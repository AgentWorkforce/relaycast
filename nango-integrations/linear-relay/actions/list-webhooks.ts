import { createAction } from 'nango';
import { z } from 'zod';
import {
    LinearWebhook,
    ListWebhooksInput,
    ListWebhooksOutput,
    normalizeWebhook,
    requireLinearData,
    type LinearGraphqlResponse
} from './webhook-utils.js';

const LIST_WEBHOOKS_QUERY = `
  query ListWebhooks($first: Int, $after: String) {
    webhooks(first: $first, after: $after) {
      nodes {
        id
        url
        enabled
        team {
          id
          name
        }
        creator {
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface LinearWebhookConnection {
    nodes?: Array<z.input<typeof LinearWebhook>>;
    pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
    };
}

interface ListWebhooksData {
    webhooks?: LinearWebhookConnection;
}

const action = createAction({
    description: 'Lists Linear webhooks for the connected organization.',
    version: '1.0.0',
    endpoint: {
        method: 'GET',
        path: '/linear/webhooks',
        group: 'Linear'
    },
    input: ListWebhooksInput,
    output: ListWebhooksOutput,
    scopes: ['admin'],

    exec: async (nango, input): Promise<z.infer<typeof ListWebhooksOutput>> => {
        const first = input.first ?? 100;
        const webhooks: Array<z.infer<typeof LinearWebhook>> = [];
        let after: string | null = null;
        let hasNextPage = true;

        while (hasNextPage) {
            const response: { data: unknown } = await nango.post({
                // https://linear.app/developers/webhooks#querying-existing-webhooks
                endpoint: '/graphql',
                data: {
                    query: LIST_WEBHOOKS_QUERY,
                    variables: { first, after }
                },
                retries: 3
            });

            const data: ListWebhooksData = requireLinearData(
                nango,
                response.data as LinearGraphqlResponse<ListWebhooksData> | undefined,
                'list webhooks'
            );
            const connection: LinearWebhookConnection | undefined = data.webhooks;
            if (!connection) {
                throw new nango.ActionError({
                    type: 'linear_missing_webhooks',
                    message: 'Linear GraphQL list webhooks did not return a webhooks connection.'
                });
            }

            webhooks.push(...(connection.nodes ?? []).map(normalizeWebhook));
            after = connection.pageInfo?.endCursor ?? null;
            hasNextPage = Boolean(connection.pageInfo?.hasNextPage && after);
        }

        return { webhooks };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
