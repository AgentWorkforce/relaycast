import { createAction } from 'nango';
import { z } from 'zod';

// Powers the deploy-time "which Linear team should this agent file into?"
// picker. The onboarding CLI triggers this action right after the Linear
// OAuth connect so the operator selects a team instead of pasting a UUID.
// Mirrors the field set used by `syncs/fetch-teams.ts` but returns the whole
// list synchronously (no sync run required, always fresh).

const ListTeamsInput = z
    .object({
        query: z.string().optional(),
        cursor: z.string().optional(),
        limit: z.number().optional()
    })
    .optional();

const LinearTeam = z.object({
    id: z.string(),
    name: z.string(),
    key: z.string().optional(),
    private: z.boolean().optional()
});

const ListTeamsOutput = z.object({
    teams: z.array(LinearTeam),
    nextCursor: z.string().optional()
});

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 200;

interface LinearTeamNode {
    id?: string | null;
    name?: string | null;
    key?: string | null;
    private?: boolean | null;
    archivedAt?: string | null;
}

interface LinearTeamsConnection {
    nodes?: LinearTeamNode[];
    pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
    };
}

interface ListTeamsData {
    teams?: LinearTeamsConnection;
}

interface LinearGraphqlResponse<T> {
    data?: T;
    errors?: Array<{ message?: string }>;
}

const LIST_TEAMS_QUERY = `
  query ListTeams($first: Int, $after: String) {
    teams(first: $first, after: $after) {
      nodes {
        id
        name
        key
        private
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

function teamMatchesQuery(team: z.infer<typeof LinearTeam>, query: string): boolean {
    return [team.name, team.key ?? ''].some((value) => value.toLowerCase().includes(query));
}

const action = createAction({
    description: 'Lists Linear teams for the connected organization (onboarding team picker).',
    version: '1.0.0',
    endpoint: {
        method: 'GET',
        path: '/linear/teams/list',
        group: 'Linear'
    },
    input: ListTeamsInput,
    output: ListTeamsOutput,
    scopes: ['read'],

    exec: async (nango, input): Promise<z.infer<typeof ListTeamsOutput>> => {
        const teams: Array<z.infer<typeof LinearTeam>> = [];
        const limit = clampLimit(input?.limit);
        const after = input?.cursor?.trim() || null;
        const query = input?.query?.trim().toLowerCase() || undefined;

        const response: { data: unknown } = await nango.post({
            // https://studio.apollographql.com/public/Linear-API/variant/current/explorer
            endpoint: '/graphql',
            data: {
                query: LIST_TEAMS_QUERY,
                variables: { first: limit, after }
            },
            retries: 3
        });

        const body = response.data as LinearGraphqlResponse<ListTeamsData> | undefined;
        if (body?.errors && body.errors.length > 0) {
            throw new nango.ActionError({
                type: 'linear_graphql_error',
                message: body.errors[0]?.message ?? 'Linear GraphQL returned an error.'
            });
        }

        const connection = body?.data?.teams;
        if (!connection) {
            throw new nango.ActionError({
                type: 'linear_missing_teams',
                message: 'Linear GraphQL list teams did not return a teams connection.'
            });
        }

        for (const node of connection.nodes ?? []) {
            // Skip archived teams — they can't be filed into.
            if (!node?.id || node.archivedAt) {
                continue;
            }
            const team = {
                id: node.id,
                name: node.name ?? node.key ?? node.id,
                ...(node.key ? { key: node.key } : {}),
                ...(typeof node.private === 'boolean' ? { private: node.private } : {})
            };
            if (query && !teamMatchesQuery(team, query)) {
                continue;
            }
            teams.push(team);
        }

        const nextCursor =
            connection.pageInfo?.hasNextPage && connection.pageInfo.endCursor
                ? connection.pageInfo.endCursor
                : undefined;

        return { teams, ...(nextCursor ? { nextCursor } : {}) };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
