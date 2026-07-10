import { createSync } from 'nango';
import { z } from 'zod';
import {
    DEAL_OBJECT_TYPE_ID,
    DEAL_PROPERTIES,
    HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS_WITH_ASSOCIATIONS,
    HubSpotDealSchema as DealSchema,
    HubSpotRawObjectSchema,
    buildHubSpotDealRecord,
    extractHubspotWebhookObjectIds,
    type HubSpotAssociationClient
} from '../shared/hubspot-record-shapes.js';

const DealResponseSchema = z.object({
    results: z.array(HubSpotRawObjectSchema).optional(),
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

async function fetchDealById(client: HubSpotAssociationClient, dealId: string): Promise<z.infer<typeof DealSchema> | null> {
    try {
        // https://developers.hubspot.com/docs/api-reference/crm-deals-v3/basic/get-crm-v3-objects-deals-dealId
        const response = await client.get({
            endpoint: `/crm/v3/objects/deals/${dealId}`,
            params: {
                properties: DEAL_PROPERTIES,
                associations: 'companies,contacts'
            },
            retries: 3
        });

        return await buildHubSpotDealRecord(HubSpotRawObjectSchema.parse(response.data), client);
    } catch {
        return null;
    }
}

const sync = createSync({
    description: 'Sync deals with amount, close date, stage, owner, description, and associated companies and contacts',
    version: '3.0.0',
    endpoints: [{ method: 'GET', path: '/syncs/deals', group: 'Deals' }],
    frequency: 'every 12 hours',
    autoStart: true,
    checkpoint: HubspotCrmCheckpointSchema,
    webhookSubscriptions: [...HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS_WITH_ASSOCIATIONS],

    models: {
        Deal: DealSchema
    },

    exec: async (nango) => {
        const checkpoint = parseHubspotCrmCheckpoint(await nango.getCheckpoint());
        const shouldUseInitialListSync = checkpoint?.phase !== 'incremental' || !checkpoint.updatedAfter;

        if (shouldUseInitialListSync) {
            let after = checkpoint?.after;
            let latestUpdatedAt = checkpoint?.updatedAfter;
            let hasMore = true;

            while (hasMore) {
                // https://developers.hubspot.com/docs/api-reference/crm-deals-v3/basic/get-crm-v3-objects-deals
                const response = await nango.get({
                    endpoint: '/crm/v3/objects/deals',
                    params: {
                        limit: '100',
                        properties: DEAL_PROPERTIES,
                        associations: 'companies,contacts',
                        ...(after && { after })
                    },
                    retries: 3
                });

                const data = DealResponseSchema.parse(response.data);
                const deals = data.results || [];

                if (deals.length === 0) {
                    break;
                }

                const records: Array<z.infer<typeof DealSchema>> = [];
                for (const deal of deals) {
                    records.push(await buildHubSpotDealRecord(deal, nango));
                }

                await nango.batchSave(records, 'Deal');

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
                properties: DEAL_PROPERTIES.split(','),
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
            // Template users should narrow the search window/filter strategy to fit their data volume before relying on this template.
            // https://developers.hubspot.com/docs/api-reference/search/guide#paging-through-results
            const response = await nango.post({
                endpoint: '/crm/v3/objects/deals/search',
                data: searchBody,
                retries: 3
            });

            const data = DealResponseSchema.parse(response.data);
            const parsedBatch = data.results || [];

            if (parsedBatch.length === 0) {
                break;
            }

            const deals: Array<z.infer<typeof DealSchema>> = [];

            for (const deal of parsedBatch) {
                deals.push(await buildHubSpotDealRecord(deal, nango));
            }

            await nango.batchSave(deals, 'Deal');

            latestUpdatedAt = deals.reduce((latest, deal) => updateLatestUpdatedAt(latest, deal.updatedAt), latestUpdatedAt);

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
        const { upsertIds, deleteIds } = extractHubspotWebhookObjectIds(payload, DEAL_OBJECT_TYPE_ID, {
            includeAssociationChange: true
        });

        if (deleteIds.length > 0) {
            await nango.batchDelete(deleteIds.map((id) => ({ id })), 'Deal');
        }

        const records: Array<z.infer<typeof DealSchema>> = [];
        for (const id of upsertIds) {
            const record = await fetchDealById(nango, id);
            if (record) {
                records.push(record);
            }
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'Deal');
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
