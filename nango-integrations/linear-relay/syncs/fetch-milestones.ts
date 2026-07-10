import { createSync } from 'nango';
import * as z from 'zod';

import {
    INITIAL_UPDATED_AFTER,
    LinearCheckpointSchema,
    formatError,
    requireLinearConnection,
    toIsoString,
    type LinearConnection,
    type LinearGraphqlResponse
} from './helpers.js';

const LinearMilestone = z.object({
    id: z.string(),
    name: z.string(),
    progress: z.number(),
    description: z.string().nullable(),
    status: z.string(),
    project_id: z.string().nullable(),
    project_name: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string()
});

type LinearMilestoneRecord = z.infer<typeof LinearMilestone>;

interface LinearProjectRef {
    id?: string | null;
    name?: string | null;
}

interface LinearMilestoneNode {
    id: string;
    name?: string | null;
    progress?: number | null;
    description?: string | null;
    status?: string | null;
    project?: LinearProjectRef | null;
    createdAt?: string | null;
    updatedAt?: string | null;
}

interface LinearMilestonesData {
    projectMilestones?: LinearConnection<LinearMilestoneNode>;
}

const LINEAR_MILESTONE_FIELDS = `
        id
        name
        progress
        description
        status
        targetDate
        project {
          id
          name
        }
        createdAt
        updatedAt
`;
const LIST_MILESTONES_QUERY = `
  query ListMilestones($first: Int, $after: String, $updatedAfter: DateTimeOrDuration!) {
    projectMilestones(
      first: $first
      after: $after
      filter: { updatedAt: { gte: $updatedAfter } }
    ) {
      nodes {
${LINEAR_MILESTONE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export default createSync({
    description: 'Fetches Linear milestones for Sage.',
    version: '1.0.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/milestones', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearMilestone },

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearMilestone');

        const checkpoint = await nango.getCheckpoint();
        const updatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        const records: LinearMilestoneRecord[] = [];
        let cursor: string | null = null;
        let hasNextPage = true;
        let latestUpdatedAt = updatedAfter;

        try {
            while (hasNextPage) {
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: LIST_MILESTONES_QUERY,
                        variables: {
                            first: 100,
                            after: cursor,
                            updatedAfter
                        }
                    },
                    retries: 3
                });

                const milestones: LinearConnection<LinearMilestoneNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearMilestonesData> | undefined,
                    (data) => data.projectMilestones,
                    'projectMilestones'
                );

                for (const milestone of milestones.nodes ?? []) {
                    const record = toLinearMilestoneRecord(milestone);
                    records.push(record);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                }

                cursor = milestones.pageInfo?.endCursor ?? null;
                hasNextPage = Boolean(milestones.pageInfo?.hasNextPage && cursor);
            }
        } catch (error) {
            await nango.log(`Failed to sync Linear milestones: ${formatError(error)}`);
            throw error;
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'LinearMilestone');
        }

        if (latestUpdatedAt !== updatedAfter) {
            await nango.saveCheckpoint({ updatedAtCursor: latestUpdatedAt });
        }
    }
});

function toLinearMilestoneRecord(milestone: LinearMilestoneNode): LinearMilestoneRecord {
    return {
        id: milestone.id,
        name: milestone.name ?? '',
        progress: milestone.progress ?? 0,
        description: milestone.description ?? null,
        status: milestone.status ?? '',
        project_id: milestone.project?.id ?? null,
        project_name: milestone.project?.name ?? null,
        created_at: toIsoString(milestone.createdAt),
        updated_at: toIsoString(milestone.updatedAt)
    };
}
