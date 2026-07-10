import { createSync } from 'nango';
import { z } from 'zod';
import {
    COMPANY_OBJECT_TYPE_ID,
    COMPANY_PROPERTIES,
    HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS,
    HubSpotCompanySchema as CompanySchema,
    HubSpotRawObjectSchema,
    buildHubSpotCompanyRecord,
    extractHubspotWebhookObjectIds
} from '../shared/hubspot-record-shapes.js';

const CompanyResponseSchema = z.object({
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

async function fetchCompanyById(client: HubspotClient, companyId: string): Promise<z.infer<typeof CompanySchema> | null> {
    try {
        // https://developers.hubspot.com/docs/api-reference/crm-companies-v3/basic/get-crm-v3-objects-companies-companyId
        const response = await client.get({
            endpoint: `/crm/v3/objects/companies/${companyId}`,
            params: {
                properties: COMPANY_PROPERTIES
            },
            retries: 3
        });

        return buildHubSpotCompanyRecord(HubSpotRawObjectSchema.parse(response.data));
    } catch {
        return null;
    }
}

const sync = createSync({
    description: 'Sync companies from HubSpot CRM',
    version: '3.0.0',
    endpoints: [
        {
            method: 'POST',
            path: '/syncs/companies',
            group: 'Companies'
        }
    ],
    frequency: 'every 12 hours',
    autoStart: true,
    checkpoint: HubspotCrmCheckpointSchema,
    webhookSubscriptions: [...HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS],

    models: {
        Company: CompanySchema
    },

    exec: async (nango) => {
        const checkpoint = parseHubspotCrmCheckpoint(await nango.getCheckpoint());
        const shouldUseInitialListSync = checkpoint?.phase !== 'incremental' || !checkpoint.updatedAfter;

        if (shouldUseInitialListSync) {
            let after = checkpoint?.after;
            let latestUpdatedAt = checkpoint?.updatedAfter;
            let hasMore = true;

            while (hasMore) {
                // https://developers.hubspot.com/docs/api-reference/crm-companies-v3/basic/get-crm-v3-objects-companies
                const response = await nango.get({
                    endpoint: '/crm/v3/objects/companies',
                    params: {
                        limit: '100',
                        properties: COMPANY_PROPERTIES,
                        ...(after && { after })
                    },
                    retries: 3
                });

                const data = CompanyResponseSchema.parse(response.data);
                const companies = data.results || [];

                if (companies.length === 0) {
                    break;
                }

                const records = companies.map((company) => buildHubSpotCompanyRecord(company));

                await nango.batchSave(records, 'Company');

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
                properties: ['name', 'domain', 'industry', 'city', 'state', 'country', 'phone', 'website', 'description', 'createdate', 'hs_lastmodifieddate'],
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
                endpoint: '/crm/v3/objects/companies/search',
                data: searchBody,
                retries: 3
            });

            const data = CompanyResponseSchema.parse(response.data);
            const companies = data.results || [];

            if (companies.length === 0) {
                break;
            }

            const records = companies.map((company) => buildHubSpotCompanyRecord(company));

            await nango.batchSave(records, 'Company');

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
        const { upsertIds, deleteIds } = extractHubspotWebhookObjectIds(payload, COMPANY_OBJECT_TYPE_ID);

        if (deleteIds.length > 0) {
            await nango.batchDelete(deleteIds.map((id) => ({ id })), 'Company');
        }

        const records: Array<z.infer<typeof CompanySchema>> = [];
        for (const id of upsertIds) {
            const record = await fetchCompanyById(nango, id);
            if (record) {
                records.push(record);
            }
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'Company');
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
