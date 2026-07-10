import { createSync } from 'nango';
import { z } from 'zod';
import { HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS, extractHubspotWebhookObjectIds } from './webhook-utils.js';

const OrderSchema = z.object({
    id: z.string(),
    properties: z.record(z.string(), z.string()).optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional()
});

const OrderApiSchema = z.object({
    id: z.string(),
    properties: z.record(z.string(), z.union([z.string(), z.null()])).nullish(),
    createdAt: z.string().nullish(),
    updatedAt: z.string().nullish()
});

const OrderResponseSchema = z.object({
    results: z.array(OrderApiSchema).optional(),
    paging: z
        .object({
            next: z
                .object({
                    after: z.string()
                })
                .optional()
        })
        .optional()
});

const HubspotCrmCheckpointSchema = z.object({
    phase: z.string(),
    after: z.string(),
    updatedAfter: z.string()
});

type HubspotCrmCheckpoint = {
    phase: 'initial' | 'incremental';
    after?: string;
    updatedAfter?: string;
};

type HubspotClient = {
    get: (config: { endpoint: string; params?: Record<string, string>; retries: number }) => Promise<{ data: unknown }>;
};

const ORDER_OBJECT_TYPE_ID = '0-123';
const ORDER_PROPERTIES = 'createdate,hs_lastmodifieddate';

function parseHubspotCrmCheckpoint(value: unknown): HubspotCrmCheckpoint | undefined {
    const result = HubspotCrmCheckpointSchema.safeParse(value);
    if (!result.success) {
        return undefined;
    }

    const { phase, after, updatedAfter } = result.data;
    if (phase !== 'initial' && phase !== 'incremental') {
        return undefined;
    }

    const checkpoint: HubspotCrmCheckpoint = { phase };

    if (after) {
        checkpoint.after = after;
    }

    if (updatedAfter) {
        checkpoint.updatedAfter = updatedAfter;
    }

    return checkpoint;
}

function updateLatestUpdatedAt(current: string | undefined, candidate: string | null | undefined): string | undefined {
    if (!candidate) {
        return current;
    }

    return !current || candidate > current ? candidate : current;
}

function normalizeProperties(input: Record<string, string | null> | null | undefined): Record<string, string> | undefined {
    if (!input) {
        return undefined;
    }

    const output = Object.fromEntries(Object.entries(input).filter(([, value]) => typeof value === 'string')) as Record<string, string>;
    return Object.keys(output).length > 0 ? output : undefined;
}

function toOrderRecord(order: z.infer<typeof OrderApiSchema>): z.infer<typeof OrderSchema> {
    return {
        id: order.id,
        properties: normalizeProperties(order.properties),
        createdAt: order.createdAt ?? order.properties?.['createdate'] ?? undefined,
        updatedAt: order.updatedAt ?? order.properties?.['hs_lastmodifieddate'] ?? undefined
    };
}

async function fetchOrderById(client: HubspotClient, orderId: string): Promise<z.infer<typeof OrderSchema> | null> {
    try {
        // https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/orders/get-crm-v3-objects-orders-orderId
        const response = await client.get({
            endpoint: `/crm/v3/objects/orders/${orderId}`,
            params: {
                properties: ORDER_PROPERTIES
            },
            retries: 3
        });

        return toOrderRecord(OrderApiSchema.parse(response.data));
    } catch {
        return null;
    }
}

const sync = createSync({
    description: 'Sync orders from HubSpot CRM',
    version: '1.0.0',
    endpoints: [{ method: 'POST', path: '/syncs/orders', group: 'Orders' }],
    frequency: 'every 12 hours',
    autoStart: true,
    checkpoint: HubspotCrmCheckpointSchema,
    webhookSubscriptions: [...HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS],

    models: {
        Order: OrderSchema
    },

    exec: async (nango) => {
        const checkpoint = parseHubspotCrmCheckpoint(await nango.getCheckpoint());
        const shouldUseInitialListSync = checkpoint?.phase !== 'incremental' || !checkpoint.updatedAfter;

        if (shouldUseInitialListSync) {
            let after = checkpoint?.after;
            let latestUpdatedAt = checkpoint?.updatedAfter;
            let hasMore = true;

            while (hasMore) {
                // https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/orders/get-page
                const response = await nango.get({
                    endpoint: '/crm/v3/objects/orders',
                    params: {
                        limit: '100',
                        properties: ORDER_PROPERTIES,
                        ...(after && { after })
                    },
                    retries: 3
                });

                const data = OrderResponseSchema.parse(response.data);
                const orders = data.results || [];

                if (orders.length === 0) {
                    break;
                }

                const records = orders.map((order) => toOrderRecord(order));

                await nango.batchSave(records, 'Order');

                latestUpdatedAt = records.reduce((latest, record) => updateLatestUpdatedAt(latest, record.updatedAt), latestUpdatedAt);

                const nextAfter = data.paging?.next?.after;

                if (nextAfter) {
                    await nango.saveCheckpoint({
                        phase: 'initial',
                        after: nextAfter,
                        updatedAfter: latestUpdatedAt || ''
                    });
                    after = nextAfter;
                    continue;
                }

                if (latestUpdatedAt) {
                    await nango.saveCheckpoint({
                        phase: 'incremental',
                        after: '',
                        updatedAfter: latestUpdatedAt
                    });
                }

                hasMore = false;
            }

            return;
        }

        const updatedAfter = checkpoint.updatedAfter;
        let after = checkpoint.after;
        let latestUpdatedAt = updatedAfter;
        let hasMore = true;

        while (hasMore) {
            const searchBody: Record<string, unknown> = {
                limit: 100,
                properties: ORDER_PROPERTIES.split(','),
                sorts: [
                    {
                        propertyName: 'hs_lastmodifieddate',
                        direction: 'ASCENDING'
                    }
                ],
                filterGroups: [
                    {
                        filters: [
                            {
                                propertyName: 'hs_lastmodifieddate',
                                operator: 'GT',
                                value: updatedAfter
                            }
                        ]
                    }
                ],
                ...(after && { after })
            };

            // Incremental syncs use search so they can filter by last modified date.
            // HubSpot search queries are capped at 10,000 total results; paging past that returns a 400 and can leave this incremental sync incomplete.
            // https://developers.hubspot.com/docs/api/crm/search#limits
            const response = await nango.post({
                endpoint: '/crm/v3/objects/orders/search',
                data: searchBody,
                retries: 3
            });

            const data = OrderResponseSchema.parse(response.data);
            const orders = data.results || [];

            if (orders.length === 0) {
                break;
            }

            const records = orders.map((order) => toOrderRecord(order));

            await nango.batchSave(records, 'Order');

            latestUpdatedAt = records.reduce((latest, record) => updateLatestUpdatedAt(latest, record.updatedAt), latestUpdatedAt);

            const nextAfter = data.paging?.next?.after;

            if (nextAfter) {
                await nango.saveCheckpoint({
                    phase: 'incremental',
                    after: nextAfter,
                    updatedAfter: updatedAfter || ''
                });
                after = nextAfter;
                continue;
            }

            if (latestUpdatedAt) {
                await nango.saveCheckpoint({
                    phase: 'incremental',
                    after: '',
                    updatedAfter: latestUpdatedAt
                });
            }

            hasMore = false;
        }
    },

    onWebhook: async (nango, payload) => {
        const { upsertIds, deleteIds } = extractHubspotWebhookObjectIds(payload, ORDER_OBJECT_TYPE_ID);

        if (deleteIds.length > 0) {
            await nango.batchDelete(deleteIds.map((id) => ({ id })), 'Order');
        }

        const records: Array<z.infer<typeof OrderSchema>> = [];
        for (const id of upsertIds) {
            const record = await fetchOrderById(nango, id);
            if (record) {
                records.push(record);
            }
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'Order');
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
