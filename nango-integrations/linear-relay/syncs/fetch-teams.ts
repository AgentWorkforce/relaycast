import { createSync } from 'nango';
import * as z from 'zod';

import {
    INITIAL_UPDATED_AFTER,
    LINEAR_TEAM_FIELDS,
    LinearCheckpointSchema,
    formatError,
    requireLinearConnection,
    toIsoString,
    type LinearConnection,
    type LinearGraphqlResponse
} from './helpers.js';

const LinearTeam = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string()
});

type LinearTeamRecord = z.infer<typeof LinearTeam>;

interface LinearTeamNode {
    id: string;
    name?: string | null;
    description?: string | null;
    createdAt?: string | null;
    updatedAt?: string | null;
}

interface LinearTeamsData {
    teams?: LinearConnection<LinearTeamNode>;
}

const LIST_TEAMS_QUERY = `
  query ListTeams($first: Int, $after: String, $updatedAfter: DateTimeOrDuration!) {
    teams(first: $first, after: $after, filter: { updatedAt: { gte: $updatedAfter } }) {
      nodes {
${LINEAR_TEAM_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export default createSync({
    description: 'Fetches Linear teams for Sage.',
    version: '1.0.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/teams', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearTeam },

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearTeam');

        const checkpoint = await nango.getCheckpoint();
        const updatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        const records: LinearTeamRecord[] = [];
        let cursor: string | null = null;
        let hasNextPage = true;
        let latestUpdatedAt = updatedAfter;

        try {
            while (hasNextPage) {
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: LIST_TEAMS_QUERY,
                        variables: {
                            first: 100,
                            after: cursor,
                            updatedAfter
                        }
                    },
                    retries: 3
                });

                const teams: LinearConnection<LinearTeamNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearTeamsData> | undefined,
                    (data) => data.teams,
                    'teams'
                );

                for (const team of teams.nodes ?? []) {
                    const record = toLinearTeamRecord(team);
                    records.push(record);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                }

                cursor = teams.pageInfo?.endCursor ?? null;
                hasNextPage = Boolean(teams.pageInfo?.hasNextPage && cursor);
            }
        } catch (error) {
            await nango.log(`Failed to sync Linear teams: ${formatError(error)}`);
            throw error;
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'LinearTeam');
        }

        if (latestUpdatedAt !== updatedAfter) {
            await nango.saveCheckpoint({ updatedAtCursor: latestUpdatedAt });
        }
    }
});

function toLinearTeamRecord(team: LinearTeamNode): LinearTeamRecord {
    return {
        id: team.id,
        name: team.name ?? '',
        description: team.description ?? null,
        created_at: toIsoString(team.createdAt),
        updated_at: toIsoString(team.updatedAt)
    };
}
