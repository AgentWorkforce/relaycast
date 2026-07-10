import { createAction } from 'nango';
import { z } from 'zod';

const ListLabelsInput = z
    .object({
        query: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().optional()
    })
    .optional();

const LinearLabel = z.object({
    id: z.string(),
    name: z.string(),
    color: z.string().optional()
});

const ListLabelsOutput = z.object({
    labels: z.array(LinearLabel),
    nextCursor: z.string().optional()
});

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

interface LinearLabelNode {
    id?: string | null;
    name?: string | null;
    color?: string | null;
    archivedAt?: string | null;
}

interface LinearLabelsConnection {
    nodes?: LinearLabelNode[];
    pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
    };
}

interface ListLabelsData {
    issueLabels?: LinearLabelsConnection;
}

interface LinearGraphqlResponse<T> {
    data?: T;
    errors?: Array<{ message?: string }>;
}

interface ContainsIgnoreCaseFilter {
    containsIgnoreCase: string;
}

interface IssueLabelFilter {
    name?: ContainsIgnoreCaseFilter;
}

const LIST_LABELS_QUERY = `
  query ListLabels($first: Int, $after: String, $filter: IssueLabelFilter) {
    issueLabels(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        name
        color
        archivedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

function clampLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < MIN_LIMIT) {
        return DEFAULT_LIMIT;
    }
    return Math.min(value, MAX_LIMIT);
}

const action = createAction({
    description: 'Lists Linear issue labels for picker options.',
    version: '1.0.0',
    endpoint: {
        method: 'GET',
        path: '/linear/labels/list',
        group: 'Linear'
    },
    input: ListLabelsInput,
    output: ListLabelsOutput,
    scopes: ['read'],

    exec: async (nango, input): Promise<z.infer<typeof ListLabelsOutput>> => {
        const labels: Array<z.infer<typeof LinearLabel>> = [];
        const limit = clampLimit(input?.limit);
        const after = input?.cursor?.trim() || null;
        const query = input?.query?.trim() || undefined;

        const filter: IssueLabelFilter = {};
        if (query) {
            filter.name = { containsIgnoreCase: query };
        }

        const response: { data: unknown } = await nango.post({
            endpoint: '/graphql',
            data: {
                query: LIST_LABELS_QUERY,
                variables: { first: limit, after, filter }
            },
            retries: 3
        });

        const body = response.data as LinearGraphqlResponse<ListLabelsData> | undefined;
        if (body?.errors && body.errors.length > 0) {
            throw new nango.ActionError({
                type: 'linear_graphql_error',
                message: body.errors[0]?.message ?? 'Linear GraphQL returned an error.'
            });
        }

        const connection = body?.data?.issueLabels;
        if (!connection) {
            throw new nango.ActionError({
                type: 'linear_missing_labels',
                message: 'Linear GraphQL list labels did not return an issueLabels connection.'
            });
        }

        for (const node of connection.nodes ?? []) {
            if (!node?.id || node.archivedAt) {
                continue;
            }
            labels.push({
                id: node.id,
                name: node.name ?? node.id,
                ...(node.color ? { color: node.color } : {})
            });
        }

        const nextCursor =
            connection.pageInfo?.hasNextPage && connection.pageInfo.endCursor
                ? connection.pageInfo.endCursor
                : undefined;

        return { labels, ...(nextCursor ? { nextCursor } : {}) };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
