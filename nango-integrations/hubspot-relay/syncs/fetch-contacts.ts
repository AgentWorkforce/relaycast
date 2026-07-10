import { createSync } from 'nango';
import { z } from 'zod';
import {
    CONTACT_OBJECT_TYPE_ID,
    CONTACT_PROPERTIES,
    HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS,
    HubSpotContactSchema as ContactSchema,
    HubSpotRawObjectSchema,
    buildHubSpotContactRecord,
    extractHubspotWebhookObjectIds
} from '../shared/hubspot-record-shapes.js';

const ContactResponseSchema = z.object({
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

type HubspotClient = {
    get: (config: { endpoint: string; params?: Record<string, string>; retries: number }) => Promise<{ data: unknown }>;
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

async function fetchContactById(client: HubspotClient, contactId: string): Promise<z.infer<typeof ContactSchema> | null> {
    try {
        // https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/get-crm-v3-objects-contacts-contactId
        const response = await client.get({
            endpoint: `/crm/v3/objects/contacts/${contactId}`,
            params: {
                properties: CONTACT_PROPERTIES
            },
            retries: 3
        });

        return buildHubSpotContactRecord(HubSpotRawObjectSchema.parse(response.data));
    } catch {
        return null;
    }
}

const sync = createSync({
    description: 'Sync contacts',
    version: '4.0.0',
    endpoints: [{ method: 'POST', path: '/syncs/contacts', group: 'Contacts' }],
    frequency: 'every 12 hours',
    autoStart: true,
    checkpoint: HubspotCrmCheckpointSchema,
    webhookSubscriptions: [...HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS],

    models: {
        Contact: ContactSchema
    },

    exec: async (nango) => {
        const checkpoint = parseHubspotCrmCheckpoint(await nango.getCheckpoint());
        const shouldUseInitialListSync = checkpoint?.phase !== 'incremental' || !checkpoint.updatedAfter;

        if (shouldUseInitialListSync) {
            let after = checkpoint?.after;
            let latestUpdatedAt = checkpoint?.updatedAfter;
            let hasMore = true;

            while (hasMore) {
                // https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/basic/get-crm-v3-objects-contacts
                const response = await nango.get({
                    endpoint: '/crm/v3/objects/contacts',
                    params: {
                        limit: '100',
                        properties: CONTACT_PROPERTIES,
                        ...(after && { after })
                    },
                    retries: 3
                });

                const data = ContactResponseSchema.parse(response.data);
                const contacts = data.results || [];

                if (contacts.length === 0) {
                    break;
                }

                const records = contacts.map((contact) => buildHubSpotContactRecord(contact));

                await nango.batchSave(records, 'Contact');

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
                properties: ['firstname', 'lastname', 'email', 'phone', 'jobtitle', 'company', 'createdate', 'lastmodifieddate'],
                sorts: [
                    {
                        propertyName: 'lastmodifieddate',
                        direction: 'ASCENDING'
                    }
                ],
                filterGroups: [
                    {
                        filters: [
                            {
                                propertyName: 'lastmodifieddate',
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
                endpoint: '/crm/v3/objects/contacts/search',
                data: searchBody,
                retries: 3
            });

            const data = ContactResponseSchema.parse(response.data);
            const contacts = data.results || [];

            if (contacts.length === 0) {
                break;
            }

            const records = contacts.map((contact) => buildHubSpotContactRecord(contact));

            await nango.batchSave(records, 'Contact');

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
        const { upsertIds, deleteIds } = extractHubspotWebhookObjectIds(payload, CONTACT_OBJECT_TYPE_ID);

        if (deleteIds.length > 0) {
            await nango.batchDelete(deleteIds.map((id) => ({ id })), 'Contact');
        }

        const records: Array<z.infer<typeof ContactSchema>> = [];
        for (const id of upsertIds) {
            const record = await fetchContactById(nango, id);
            if (record) {
                records.push(record);
            }
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'Contact');
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
