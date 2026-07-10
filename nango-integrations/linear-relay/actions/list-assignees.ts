import { createAction } from 'nango';
import { z } from 'zod';

const ListAssigneesInput = z
    .object({
        query: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().optional()
    })
    .optional();

const LinearAssignee = z.object({
    id: z.string(),
    name: z.string().optional(),
    displayName: z.string().optional(),
    email: z.string().optional()
});

const ListAssigneesOutput = z.object({
    assignees: z.array(LinearAssignee),
    nextCursor: z.string().optional()
});

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

interface LinearAssigneeNode {
    id?: string | null;
    name?: string | null;
    displayName?: string | null;
    email?: string | null;
    active?: boolean | null;
}

interface LinearAssigneesConnection {
    nodes?: LinearAssigneeNode[];
    pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
    };
}

interface ListAssigneesData {
    users?: LinearAssigneesConnection;
}

interface LinearGraphqlResponse<T> {
    data?: T;
    errors?: Array<{ message?: string }>;
}

interface ContainsIgnoreCaseFilter {
    containsIgnoreCase: string;
}

interface UserFilter {
    active: {
        eq: true;
    };
    or?: Array<{
        name?: ContainsIgnoreCaseFilter;
        displayName?: ContainsIgnoreCaseFilter;
        email?: ContainsIgnoreCaseFilter;
    }>;
}

const LIST_ASSIGNEES_QUERY = `
  query ListAssignees($first: Int, $after: String, $filter: UserFilter) {
    users(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        name
        displayName
        email
        active
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
    description: 'Lists active Linear users for assignee picker options.',
    version: '1.0.0',
    endpoint: {
        method: 'GET',
        path: '/linear/assignees/list',
        group: 'Linear'
    },
    input: ListAssigneesInput,
    output: ListAssigneesOutput,
    scopes: ['read'],

    exec: async (nango, input): Promise<z.infer<typeof ListAssigneesOutput>> => {
        const assignees: Array<z.infer<typeof LinearAssignee>> = [];
        const limit = clampLimit(input?.limit);
        const after = input?.cursor?.trim() || null;
        const query = input?.query?.trim() || undefined;

        const filter: UserFilter = { active: { eq: true } };
        if (query) {
            filter.or = [
                { name: { containsIgnoreCase: query } },
                { displayName: { containsIgnoreCase: query } },
                { email: { containsIgnoreCase: query } }
            ];
        }

        const response: { data: unknown } = await nango.post({
            endpoint: '/graphql',
            data: {
                query: LIST_ASSIGNEES_QUERY,
                variables: { first: limit, after, filter }
            },
            retries: 3
        });

        const body = response.data as LinearGraphqlResponse<ListAssigneesData> | undefined;
        if (body?.errors && body.errors.length > 0) {
            throw new nango.ActionError({
                type: 'linear_graphql_error',
                message: body.errors[0]?.message ?? 'Linear GraphQL returned an error.'
            });
        }

        const connection = body?.data?.users;
        if (!connection) {
            throw new nango.ActionError({
                type: 'linear_missing_assignees',
                message: 'Linear GraphQL list assignees did not return a users connection.'
            });
        }

        for (const node of connection.nodes ?? []) {
            if (!node?.id || node.active === false) {
                continue;
            }
            assignees.push({
                id: node.id,
                ...(node.name ? { name: node.name } : {}),
                ...(node.displayName ? { displayName: node.displayName } : {}),
                ...(node.email ? { email: node.email } : {})
            });
        }

        const nextCursor =
            connection.pageInfo?.hasNextPage && connection.pageInfo.endCursor
                ? connection.pageInfo.endCursor
                : undefined;

        return { assignees, ...(nextCursor ? { nextCursor } : {}) };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
