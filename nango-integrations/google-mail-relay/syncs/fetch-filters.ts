import { createSync } from 'nango';
import { z } from 'zod';

const FilterCriteriaSchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    query: z.string().optional(),
    negatedQuery: z.string().optional(),
    hasAttachment: z.boolean().optional(),
    excludeChats: z.boolean().optional(),
    size: z.number().int().optional(),
    sizeComparison: z.string().optional()
});

const FilterActionSchema = z.object({
    addLabelIds: z.array(z.string()).optional(),
    removeLabelIds: z.array(z.string()).optional(),
    forward: z.string().optional()
});

const ProviderFilterSchema = z.object({
    id: z.string(),
    criteria: FilterCriteriaSchema.optional(),
    action: FilterActionSchema.optional()
});

const GoogleMailFilter = z.object({
    id: z.string(),
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    query: z.string().optional(),
    negatedQuery: z.string().optional(),
    hasAttachment: z.boolean().optional(),
    excludeChats: z.boolean().optional(),
    size: z.number().int().optional(),
    sizeComparison: z.string().optional(),
    addLabelIds: z.array(z.string()).optional(),
    removeLabelIds: z.array(z.string()).optional(),
    forward: z.string().optional()
});

const sync = createSync({
    description: 'Sync Gmail mailbox filters and filter actions for Relayfile.',
    version: '1.0.0',
    frequency: 'every 6 hours',
    autoStart: true,
    models: {
        GoogleMailFilter
    },
    endpoints: [
        {
            path: '/gmail/filters',
            method: 'GET',
            group: 'Google Mail'
        }
    ],
    scopes: ['https://www.googleapis.com/auth/gmail.settings.basic'],

    exec: async (nango) => {
        const response = await nango.get({
            // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/list
            endpoint: '/gmail/v1/users/me/settings/filters',
            retries: 3
        });

        const parsed = z
            .object({
                filter: z.array(z.unknown()).optional()
            })
            .safeParse(response.data);

        if (!parsed.success) {
            throw new Error('Invalid response from Gmail filters API: ' + parsed.error.message);
        }

        const filters = parsed.data.filter ?? [];

        const normalizedFilters = filters
            .map((raw) => {
                const parsedFilter = ProviderFilterSchema.safeParse(raw);
                if (!parsedFilter.success) {
                    return null;
                }
                const filter = parsedFilter.data;
                return {
                    id: filter.id,
                    ...(filter.criteria?.from && { from: filter.criteria.from }),
                    ...(filter.criteria?.to && { to: filter.criteria.to }),
                    ...(filter.criteria?.subject && { subject: filter.criteria.subject }),
                    ...(filter.criteria?.query && { query: filter.criteria.query }),
                    ...(filter.criteria?.negatedQuery && { negatedQuery: filter.criteria.negatedQuery }),
                    ...(filter.criteria?.hasAttachment !== undefined && { hasAttachment: filter.criteria.hasAttachment }),
                    ...(filter.criteria?.excludeChats !== undefined && { excludeChats: filter.criteria.excludeChats }),
                    ...(filter.criteria?.size !== undefined && { size: filter.criteria.size }),
                    ...(filter.criteria?.sizeComparison && { sizeComparison: filter.criteria.sizeComparison }),
                    ...(filter.action?.addLabelIds !== undefined && { addLabelIds: filter.action.addLabelIds }),
                    ...(filter.action?.removeLabelIds !== undefined && { removeLabelIds: filter.action.removeLabelIds }),
                    ...(filter.action?.forward && { forward: filter.action.forward })
                };
            })
            .filter((value): value is NonNullable<typeof value> => value !== null);

        await nango.trackDeletesStart('GoogleMailFilter');
        try {
            if (normalizedFilters.length > 0) {
                await nango.batchSave(normalizedFilters, 'GoogleMailFilter');
            }
        } finally {
            await nango.trackDeletesEnd('GoogleMailFilter');
        }
    }
});

export default sync;
