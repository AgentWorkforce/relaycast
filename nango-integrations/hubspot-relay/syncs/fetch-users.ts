import { createSync, type ProxyConfiguration } from 'nango';
import { z } from 'zod';
import { HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS, extractHubspotWebhookObjectIds } from './webhook-utils.js';

const UserSchema = z.object({
    id: z.string(),
    email: z.string().optional(),
    roleId: z.string().optional(),
    primaryTeamId: z.string().optional(),
    secondaryTeamIds: z.array(z.string()),
    superAdmin: z.boolean()
});

const HubspotUserApiSchema = z.object({
    id: z.string(),
    email: z.string().nullish(),
    roleId: z.string().nullish(),
    primaryTeamId: z.string().nullish(),
    secondaryTeamIds: z.array(z.string()).optional(),
    superAdmin: z.union([z.boolean(), z.literal('true'), z.literal('false')]).optional()
});

type HubspotClient = {
    get: (config: { endpoint: string; params?: Record<string, string>; retries: number }) => Promise<{ data: unknown }>;
};

const USER_OBJECT_TYPE_ID = '0-115';

function toUserRecord(user: z.infer<typeof HubspotUserApiSchema>): z.infer<typeof UserSchema> {
    return {
        id: user.id,
        email: user.email ?? undefined,
        roleId: user.roleId ?? undefined,
        primaryTeamId: user.primaryTeamId ?? undefined,
        secondaryTeamIds: user.secondaryTeamIds || [],
        superAdmin: user.superAdmin === true || user.superAdmin === 'true'
    };
}

async function fetchUserById(client: HubspotClient, userId: string): Promise<z.infer<typeof UserSchema> | null> {
    try {
        // https://developers.hubspot.com/docs/api-reference/settings-user-provisioning-v3/users/get-settings-v3-users-userId
        const response = await client.get({
            endpoint: `/settings/v3/users/${userId}`,
            retries: 3
        });

        return toUserRecord(HubspotUserApiSchema.parse(response.data));
    } catch {
        return null;
    }
}

const sync = createSync({
    description: 'Sync provisioned users with role IDs, primary team, and admin status',
    version: '3.0.0',
    endpoints: [{ method: 'GET', path: '/syncs/users', group: 'Users' }],
    frequency: 'every 12 hours',
    autoStart: true,
    webhookSubscriptions: [...HUBSPOT_GENERIC_WEBHOOK_SUBSCRIPTIONS],

    models: {
        User: UserSchema
    },

    exec: async (nango) => {
        // https://developers.hubspot.com/docs/api-reference/settings-user-provisioning-v3/users/get-settings-v3-users-
        const proxyConfig = {
            endpoint: '/settings/v3/users/',
            paginate: {
                type: 'cursor',
                cursor_path_in_response: 'paging.next.after',
                cursor_name_in_request: 'after',
                response_path: 'results',
                limit_name_in_request: 'limit',
                limit: 100
            },
            retries: 3
        } satisfies ProxyConfiguration;

        for await (const batch of nango.paginate(proxyConfig)) {
            const users = z.array(HubspotUserApiSchema).parse(batch);
            const records = users.map((user) => toUserRecord(user));

            if (records.length > 0) {
                await nango.batchSave(records, 'User');
            }
        }
    },

    onWebhook: async (nango, payload) => {
        const { upsertIds, deleteIds } = extractHubspotWebhookObjectIds(payload, USER_OBJECT_TYPE_ID);

        if (deleteIds.length > 0) {
            await nango.batchDelete(deleteIds.map((id) => ({ id })), 'User');
        }

        const records: Array<z.infer<typeof UserSchema>> = [];
        for (const id of upsertIds) {
            const record = await fetchUserById(nango, id);
            if (record) {
                records.push(record);
            }
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'User');
        }
    }
});

export type NangoSyncLocal = Parameters<(typeof sync)['exec']>[0];
export default sync;
