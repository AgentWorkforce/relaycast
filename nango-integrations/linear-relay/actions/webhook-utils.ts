import type { NangoAction } from 'nango';
import { z } from 'zod';

export const LinearWebhookTeam = z
    .union([z.object({
        id: z.string(),
        name: z.union([z.string(), z.null()]).optional()
    }), z.null()])
    .optional();

export const LinearWebhookCreator = z
    .union([z.object({
        name: z.union([z.string(), z.null()]).optional()
    }), z.null()])
    .optional();

export const LinearWebhook = z.object({
    id: z.string(),
    url: z.string(),
    enabled: z.boolean(),
    team: LinearWebhookTeam,
    creator: LinearWebhookCreator
});

export const CreateWebhookInput = z
    .object({
        url: z.string().url(),
        resourceTypes: z.array(z.string().min(1)).min(1),
        teamId: z.string().min(1).optional(),
        allPublicTeams: z.boolean().optional()
    })
    .refine((input) => Boolean(input.teamId) !== input.allPublicTeams, {
        message: 'Provide exactly one of teamId or allPublicTeams.',
        path: ['teamId']
    });

export const DeleteWebhookInput = z.object({
    webhookId: z.string().min(1)
});

export const ListWebhooksInput = z.object({
    first: z.number().int().min(1).max(250).optional()
});

export const ListWebhooksOutput = z.object({
    webhooks: z.array(LinearWebhook)
});

export const CreateWebhookOutput = z.object({
    success: z.boolean(),
    webhook: LinearWebhook
});

export const DeleteWebhookOutput = z.object({
    success: z.boolean(),
    webhookId: z.string()
});

export interface LinearGraphqlResponse<T> {
    data?: T;
    errors?: Array<{
        message?: string;
        path?: string[];
    }>;
}

type LinearAction = Pick<NangoAction, 'ActionError'>;

export function requireLinearData<T>(
    nango: LinearAction,
    response: LinearGraphqlResponse<T> | undefined,
    operation: string
): T {
    const error = response?.errors?.[0];
    if (error) {
        throw new nango.ActionError({
            type: 'linear_graphql_error',
            message: error.message ?? `Linear GraphQL ${operation} failed.`
        });
    }

    if (!response?.data) {
        throw new nango.ActionError({
            type: 'linear_missing_data',
            message: `Linear GraphQL ${operation} did not return data.`
        });
    }

    return response.data;
}

export function normalizeWebhook(webhook: z.input<typeof LinearWebhook>): z.infer<typeof LinearWebhook> {
    return LinearWebhook.parse(webhook);
}
