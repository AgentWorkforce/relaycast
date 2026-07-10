import { createAction } from 'nango';
import { z } from 'zod';

const ListProjectsInput = z
    .object({
        query: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().optional()
    })
    .optional();

const LinearProject = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    state: z.string().optional(),
    url: z.string().optional()
});

const ListProjectsOutput = z.object({
    projects: z.array(LinearProject),
    nextCursor: z.string().optional()
});

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

interface LinearProjectNode {
    id?: string | null;
    name?: string | null;
    description?: string | null;
    state?: string | null;
    url?: string | null;
    archivedAt?: string | null;
}

interface LinearProjectsConnection {
    nodes?: LinearProjectNode[];
    pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
    };
}

interface ListProjectsData {
    projects?: LinearProjectsConnection;
}

interface LinearGraphqlResponse<T> {
    data?: T;
    errors?: Array<{ message?: string }>;
}

interface ContainsIgnoreCaseFilter {
    containsIgnoreCase: string;
}

interface ProjectFilter {
    or?: Array<{
        name?: ContainsIgnoreCaseFilter;
        description?: ContainsIgnoreCaseFilter;
    }>;
}

const LIST_PROJECTS_QUERY = `
  query ListProjects($first: Int, $after: String, $filter: ProjectFilter) {
    projects(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        name
        description
        state
        url
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
    description: 'Lists Linear projects for picker options.',
    version: '1.0.0',
    endpoint: {
        method: 'GET',
        path: '/linear/projects/list',
        group: 'Linear'
    },
    input: ListProjectsInput,
    output: ListProjectsOutput,
    scopes: ['read'],

    exec: async (nango, input): Promise<z.infer<typeof ListProjectsOutput>> => {
        const projects: Array<z.infer<typeof LinearProject>> = [];
        const limit = clampLimit(input?.limit);
        const after = input?.cursor?.trim() || null;
        const query = input?.query?.trim() || undefined;

        const filter: ProjectFilter = {};
        if (query) {
            filter.or = [{ name: { containsIgnoreCase: query } }, { description: { containsIgnoreCase: query } }];
        }

        const response: { data: unknown } = await nango.post({
            endpoint: '/graphql',
            data: {
                query: LIST_PROJECTS_QUERY,
                variables: { first: limit, after, filter }
            },
            retries: 3
        });

        const body = response.data as LinearGraphqlResponse<ListProjectsData> | undefined;
        if (body?.errors && body.errors.length > 0) {
            throw new nango.ActionError({
                type: 'linear_graphql_error',
                message: body.errors[0]?.message ?? 'Linear GraphQL returned an error.'
            });
        }

        const connection = body?.data?.projects;
        if (!connection) {
            throw new nango.ActionError({
                type: 'linear_missing_projects',
                message: 'Linear GraphQL list projects did not return a projects connection.'
            });
        }

        for (const node of connection.nodes ?? []) {
            if (!node?.id || node.archivedAt) {
                continue;
            }
            projects.push({
                id: node.id,
                name: node.name ?? node.id,
                ...(node.description ? { description: node.description } : {}),
                ...(node.state ? { state: node.state } : {}),
                ...(node.url ? { url: node.url } : {})
            });
        }

        const nextCursor =
            connection.pageInfo?.hasNextPage && connection.pageInfo.endCursor
                ? connection.pageInfo.endCursor
                : undefined;

        return { projects, ...(nextCursor ? { nextCursor } : {}) };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
