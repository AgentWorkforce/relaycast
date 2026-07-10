import { createSync } from 'nango';
import * as z from 'zod';

import {
    INITIAL_UPDATED_AFTER,
    LINEAR_PROJECT_FIELDS,
    LinearCheckpointSchema,
    LinearProjectRecordSchema,
    formatError,
    requireLinearConnection,
    toLinearProjectRecord,
    type LinearConnection,
    type LinearGraphqlResponse,
    type LinearProjectNode,
    type LinearProjectRecord
} from './helpers.js';

interface LinearProjectsData {
    projects?: LinearConnection<LinearProjectNode>;
}

const LIST_PROJECTS_QUERY = `
  query ListProjects($first: Int, $after: String, $updatedAfter: DateTimeOrDuration!) {
    projects(first: $first, after: $after, filter: { updatedAt: { gte: $updatedAfter } }) {
      nodes {
${LINEAR_PROJECT_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export default createSync({
    description: 'Fetches Linear projects for Sage.',
    version: '1.0.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/projects', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearProject: LinearProjectRecordSchema },

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearProject');

        const checkpoint = await nango.getCheckpoint();
        const updatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        const records: LinearProjectRecord[] = [];
        let cursor: string | null = null;
        let hasNextPage = true;
        let latestUpdatedAt = updatedAfter;

        try {
            while (hasNextPage) {
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: LIST_PROJECTS_QUERY,
                        variables: {
                            first: 100,
                            after: cursor,
                            updatedAfter
                        }
                    },
                    retries: 3
                });

                const projects: LinearConnection<LinearProjectNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearProjectsData> | undefined,
                    (data) => data.projects,
                    'projects'
                );

                for (const project of projects.nodes ?? []) {
                    const record = toLinearProjectRecord(project);
                    records.push(record);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                }

                cursor = projects.pageInfo?.endCursor ?? null;
                hasNextPage = Boolean(projects.pageInfo?.hasNextPage && cursor);
            }
        } catch (error) {
            await nango.log(`Failed to sync Linear projects: ${formatError(error)}`);
            throw error;
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'LinearProject');
        }

        if (latestUpdatedAt !== updatedAfter) {
            await nango.saveCheckpoint({ updatedAtCursor: latestUpdatedAt });
        }
    }
});
