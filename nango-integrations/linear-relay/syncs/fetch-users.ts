import { createSync } from 'nango';
import * as z from 'zod';

import {
    INITIAL_UPDATED_AFTER,
    LINEAR_USER_FIELDS,
    LinearCheckpointSchema,
    formatError,
    requireLinearConnection,
    toIsoString,
    type LinearConnection,
    type LinearGraphqlResponse
} from './helpers.js';

const LinearUser = z.object({
    id: z.string(),
    name: z.string(),
    first_name: z.string(),
    last_name: z.string(),
    email: z.string().nullable(),
    admin: z.boolean(),
    avatar_url: z.string().nullable(),
    updated_at: z.string()
});

type LinearUserRecord = z.infer<typeof LinearUser>;

interface LinearUserNode {
    id: string;
    name?: string | null;
    email?: string | null;
    admin?: boolean | null;
    avatarUrl?: string | null;
    updatedAt?: string | null;
}

interface LinearUsersData {
    users?: LinearConnection<LinearUserNode>;
}

const LIST_USERS_QUERY = `
  query ListUsers($first: Int, $after: String, $updatedAfter: DateTimeOrDuration!) {
    users(first: $first, after: $after, filter: { updatedAt: { gte: $updatedAfter } }) {
      nodes {
${LINEAR_USER_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export default createSync({
    description: 'Fetches Linear users for Sage.',
    version: '1.0.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/users', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearUser },

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearUser');

        const checkpoint = await nango.getCheckpoint();
        const updatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        const records: LinearUserRecord[] = [];
        let cursor: string | null = null;
        let hasNextPage = true;
        let latestUpdatedAt = updatedAfter;

        try {
            while (hasNextPage) {
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: LIST_USERS_QUERY,
                        variables: {
                            first: 100,
                            after: cursor,
                            updatedAfter
                        }
                    },
                    retries: 3
                });

                const users: LinearConnection<LinearUserNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearUsersData> | undefined,
                    (data) => data.users,
                    'users'
                );

                for (const user of users.nodes ?? []) {
                    const record = toLinearUserRecord(user);
                    records.push(record);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                }

                cursor = users.pageInfo?.endCursor ?? null;
                hasNextPage = Boolean(users.pageInfo?.hasNextPage && cursor);
            }
        } catch (error) {
            await nango.log(`Failed to sync Linear users: ${formatError(error)}`);
            throw error;
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'LinearUser');
        }

        if (latestUpdatedAt !== updatedAfter) {
            await nango.saveCheckpoint({ updatedAtCursor: latestUpdatedAt });
        }
    }
});

function toLinearUserRecord(user: LinearUserNode): LinearUserRecord {
    const name = user.name ?? '';
    const [firstName = '', ...rest] = name.split(' ').filter(Boolean);

    return {
        id: user.id,
        name,
        first_name: firstName,
        last_name: rest.join(' '),
        email: user.email ?? null,
        admin: user.admin ?? false,
        avatar_url: user.avatarUrl ?? null,
        updated_at: toIsoString(user.updatedAt)
    };
}
