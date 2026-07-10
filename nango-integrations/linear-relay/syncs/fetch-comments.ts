import { createSync, type NangoSync } from 'nango';
import * as z from 'zod';

import {
    INITIAL_UPDATED_AFTER,
    LINEAR_COMMENT_FIELDS,
    LinearCheckpointSchema,
    formatError,
    requireLinearConnection,
    toIsoString,
    type LinearCommentNode,
    type LinearConnection,
    type LinearGraphqlResponse
} from './helpers.js';

const LinearComment = z.object({
    id: z.string(),
    body: z.string().nullable(),
    url: z.string().nullable(),
    issue_id: z.string().nullable(),
    issue_identifier: z.string().nullable(),
    issue_title: z.string().nullable(),
    issue_url: z.string().nullable(),
    user_id: z.string().nullable(),
    user_name: z.string().nullable(),
    user_email: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string()
});

type LinearCommentRecord = z.infer<typeof LinearComment>;

interface LinearCommentsData {
    comments?: LinearConnection<LinearCommentNode>;
}

interface LinearCommentData {
    comment?: LinearCommentNode | null;
}

interface LinearWebhookEnvelope {
    action?: string | null;
    data?: LinearCommentNode;
}

const COMMENTS_QUERY = `
  query FetchComments($after: String, $updatedAfter: DateTimeOrDuration!) {
    comments(
      first: 100
      after: $after
      filter: { updatedAt: { gte: $updatedAfter } }
    ) {
      nodes {
${LINEAR_COMMENT_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const COMMENT_BY_ID_QUERY = `
  query FetchCommentById($id: String!) {
    comment(id: $id) {
${LINEAR_COMMENT_FIELDS}
    }
  }
`;

export default createSync({
    description: 'Fetches Linear comments for Sage.',
    version: '1.0.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/comments', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearComment },

    webhookSubscriptions: ['Comment'],

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearComment');

        const checkpoint = await nango.getCheckpoint();
        const updatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        const records: LinearCommentRecord[] = [];
        let cursor: string | null = null;
        let hasNextPage = true;
        let latestUpdatedAt = updatedAfter;

        try {
            while (hasNextPage) {
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: COMMENTS_QUERY,
                        variables: { after: cursor, updatedAfter }
                    },
                    retries: 3
                });

                const comments: LinearConnection<LinearCommentNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearCommentsData> | undefined,
                    (data) => data.comments,
                    'comments'
                );

                for (const comment of comments.nodes ?? []) {
                    const record = toLinearCommentRecord(comment);
                    records.push(record);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                }

                cursor = comments.pageInfo?.endCursor ?? null;
                hasNextPage = Boolean(comments.pageInfo?.hasNextPage && cursor);
            }
        } catch (error) {
            await nango.log(`Failed to sync Linear comments: ${formatError(error)}`);
            throw error;
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'LinearComment');
        }

        if (latestUpdatedAt !== updatedAfter) {
            await nango.saveCheckpoint({ updatedAtCursor: latestUpdatedAt });
        }
    },

    onWebhook: async (nango, payload) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearComment');

        const webhook = payload as LinearWebhookEnvelope;
        const action = typeof webhook.action === 'string' ? webhook.action : null;
        const comment = webhook.data;
        if (!comment?.id) {
            return;
        }

        try {
            if (action === 'remove') {
                await nango.batchDelete([{ id: comment.id }], 'LinearComment');
                return;
            }

            const latestComment = await fetchCommentById(nango, comment.id);
            if (!latestComment) {
                await nango.log(`Linear comment webhook skipped because comment ${comment.id} could not be fetched.`);
                return;
            }

            await nango.batchSave([toLinearCommentRecord(latestComment)], 'LinearComment');
        } catch (error) {
            await nango.log(`Failed to process Linear comment webhook: ${formatError(error)}`);
            throw error;
        }
    }
});

async function fetchCommentById(nango: NangoSync, id: string): Promise<LinearCommentNode | null> {
    const response: { data: unknown } = await nango.post({
        endpoint: '/graphql',
        data: {
            query: COMMENT_BY_ID_QUERY,
            variables: { id }
        },
        retries: 3
    });

    return requireLinearComment(
        response.data as LinearGraphqlResponse<LinearCommentData> | undefined
    );
}

function requireLinearComment(
    response: LinearGraphqlResponse<LinearCommentData> | undefined
): LinearCommentNode | null {
    if (response?.errors && response.errors.length > 0) {
        const message = response.errors[0]?.message ?? 'Unknown GraphQL error';
        throw new Error(`Linear GraphQL error: ${message}`);
    }

    return response?.data?.comment ?? null;
}

function toLinearCommentRecord(comment: LinearCommentNode): LinearCommentRecord {
    return {
        id: comment.id,
        body: comment.body ?? null,
        url: comment.url ?? null,
        issue_id: comment.issue?.id ?? null,
        issue_identifier: comment.issue?.identifier ?? null,
        issue_title: comment.issue?.title ?? null,
        issue_url: comment.issue?.url ?? null,
        user_id: comment.user?.id ?? null,
        user_name: comment.user?.displayName ?? comment.user?.name ?? null,
        user_email: comment.user?.email ?? null,
        created_at: toIsoString(comment.createdAt),
        updated_at: toIsoString(comment.updatedAt)
    };
}
