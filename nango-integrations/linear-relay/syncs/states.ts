import { createSync } from 'nango';
import * as z from 'zod';

import {
    INITIAL_UPDATED_AFTER,
    LinearCheckpointSchema,
    formatError,
    requireLinearConnection,
    toIsoString,
    type LinearConnection,
    type LinearCheckpoint,
    type LinearGraphqlResponse
} from './helpers.js';

const LinearState = z.object({
    id: z.string().describe('Linear workflow state UUID.'),
    name: z.string().describe('Workflow state display name, e.g. `Todo` or `In Progress`.'),
    description: z.string().nullable().describe('Optional workflow state description.'),
    type: z.string().describe('Linear workflow state type, e.g. `backlog`, `started`, or `completed`.'),
    color: z.string().nullable().describe('Hex color for the workflow state, when configured.'),
    position: z.number().describe('Display position within the team workflow ordering.'),
    team_id: z.string().describe('Owning Linear team UUID.'),
    team_key: z.string().nullable().describe('Owning Linear team key, e.g. `ENG`.'),
    team_name: z.string().nullable().describe('Owning Linear team display name.'),
    created_at: z.string().describe('ISO 8601 creation timestamp.'),
    updated_at: z.string().describe('ISO 8601 last-modified timestamp used for checkpoint advancement.')
});

type LinearStateRecord = z.infer<typeof LinearState>;

interface LinearTeamRef {
    id?: string | null;
    key?: string | null;
    name?: string | null;
}

interface LinearStateNode {
    id: string;
    name?: string | null;
    description?: string | null;
    type?: string | null;
    color?: string | null;
    position?: number | null;
    team?: LinearTeamRef | null;
    createdAt?: string | null;
    updatedAt?: string | null;
}

interface LinearStatesData {
    workflowStates?: LinearConnection<LinearStateNode>;
}

const LINEAR_STATE_FIELDS = `
        id
        name
        description
        type
        color
        position
        team {
          id
          key
          name
        }
        createdAt
        updatedAt
`;

const LIST_STATES_QUERY = `
  query ListWorkflowStates($first: Int, $after: String, $updatedAfter: DateTimeOrDuration!) {
    workflowStates(
      first: $first
      after: $after
      filter: { updatedAt: { gte: $updatedAfter } }
    ) {
      nodes {
${LINEAR_STATE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const STATES_PAGE_SIZE = 100;

export default createSync({
    description: 'Fetches Linear workflow states for Sage.',
    version: '1.0.0',
    // Sync Strategy Gate:
    // - change source: Linear GraphQL `workflowStates` filtered by `updatedAt >= checkpoint`
    // - checkpoint schema: shared `{ updatedAtCursor, pageCursor? }`
    // - resume behavior: checkpoint timestamp feeds the next GraphQL filter; pageCursor resumes mid-window pagination
    // - dataset shape: changed rows only, not a full workspace scan
    // - delete strategy: no delete/tombstone feed is exposed in the documented `workflowStates` queries, so this sync does not batchDelete
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/states', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearState },

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearState');

        const checkpoint = (await nango.getCheckpoint()) as LinearCheckpoint | null | undefined;
        const initialUpdatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        let cursor: string | null = checkpoint?.pageCursor ?? null;
        let hasNextPage = true;
        let latestUpdatedAt = initialUpdatedAfter;

        try {
            while (hasNextPage) {
                // Linear GraphQL API examples include `workflowStates` as the
                // root connection for issue statuses:
                // https://linear.app/developers/graphql
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: LIST_STATES_QUERY,
                        variables: {
                            first: STATES_PAGE_SIZE,
                            after: cursor,
                            updatedAfter: initialUpdatedAfter
                        }
                    },
                    retries: 3
                });

                const states: LinearConnection<LinearStateNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearStatesData> | undefined,
                    (data) => data.workflowStates,
                    'workflowStates'
                );

                const batch: LinearStateRecord[] = [];
                for (const state of states.nodes ?? []) {
                    if (!state?.team?.id) {
                        await nango.log(
                            `states: skipping workflow state id=${state?.id ?? 'unknown'} with no team id`,
                            { level: 'warn' }
                        );
                        continue;
                    }
                    if (typeof state.position !== 'number' || !Number.isFinite(state.position)) {
                        await nango.log(
                            `states: skipping workflow state id=${state.id} with missing/invalid position`,
                            { level: 'warn' }
                        );
                        continue;
                    }

                    const record = toLinearStateRecord(state);
                    batch.push(record);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                }

                if (batch.length > 0) {
                    await nango.batchSave(batch, 'LinearState');
                }

                const nextCursor = states.pageInfo?.endCursor ?? null;
                const nextHasPage = Boolean(states.pageInfo?.hasNextPage && nextCursor);

                if (nextHasPage) {
                    await nango.saveCheckpoint({
                        updatedAtCursor: initialUpdatedAfter,
                        pageCursor: nextCursor
                    } as any);
                }

                cursor = nextCursor;
                hasNextPage = nextHasPage;
            }

            await nango.saveCheckpoint({
                updatedAtCursor: latestUpdatedAt
            });
        } catch (error) {
            await nango.log(`Failed to sync Linear states: ${formatError(error)}`, { level: 'error' });
            throw error;
        }
    }
});

function toLinearStateRecord(state: LinearStateNode): LinearStateRecord {
    return {
        id: state.id,
        name: state.name ?? '',
        description: state.description ?? null,
        type: state.type ?? '',
        color: state.color ?? null,
        position: state.position as number,
        team_id: state.team?.id as string,
        team_key: state.team?.key ?? null,
        team_name: state.team?.name ?? null,
        created_at: toIsoString(state.createdAt),
        updated_at: toIsoString(state.updatedAt)
    };
}
