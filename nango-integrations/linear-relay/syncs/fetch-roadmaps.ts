import { createSync } from 'nango';
import * as z from 'zod';

import {
    INITIAL_UPDATED_AFTER,
    LINEAR_LIST_ROADMAPS_QUERY,
    LinearCheckpointSchema,
    formatError,
    nodeIds,
    requireLinearConnection,
    toIsoString,
    type LinearConnection,
    type LinearGraphqlResponse,
    type LinearIdNode
} from './helpers.js';

const LinearRoadmap = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    team_ids: z.array(z.string()),
    project_ids: z.array(z.string()),
    created_at: z.string(),
    updated_at: z.string()
});

type LinearRoadmapRecord = z.infer<typeof LinearRoadmap>;

interface LinearRoadmapProjectNode extends LinearIdNode {
    teams?: LinearConnection<LinearIdNode> | null;
}

interface LinearRoadmapNode {
    id: string;
    name?: string | null;
    description?: string | null;
    projects?: LinearConnection<LinearRoadmapProjectNode> | null;
    createdAt?: string | null;
    updatedAt?: string | null;
}

interface LinearRoadmapsData {
    roadmaps?: LinearConnection<LinearRoadmapNode>;
}

export default createSync({
    description: 'Fetches Linear roadmaps for Sage.',
    version: '1.0.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/roadmaps', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearRoadmap },

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearRoadmap');

        const checkpoint = await nango.getCheckpoint();
        const updatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        const records: LinearRoadmapRecord[] = [];
        let cursor: string | null = null;
        let hasNextPage = true;
        let latestUpdatedAt = updatedAfter;

        try {
            while (hasNextPage) {
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: LINEAR_LIST_ROADMAPS_QUERY,
                        variables: {
                            first: 25,
                            after: cursor
                        }
                    },
                    retries: 3
                });

                const roadmaps: LinearConnection<LinearRoadmapNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearRoadmapsData> | undefined,
                    (data) => data.roadmaps,
                    'roadmaps'
                );

                for (const roadmap of roadmaps.nodes ?? []) {
                    const record = toLinearRoadmapRecord(roadmap);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                    if (record.updated_at >= updatedAfter) {
                        records.push(record);
                    }
                }

                cursor = roadmaps.pageInfo?.endCursor ?? null;
                hasNextPage = Boolean(roadmaps.pageInfo?.hasNextPage && cursor);
            }
        } catch (error) {
            await nango.log(`Failed to sync Linear roadmaps: ${formatError(error)}`);
            throw error;
        }

        if (records.length > 0) {
            await nango.batchSave(records, 'LinearRoadmap');
        }

        if (latestUpdatedAt !== updatedAfter) {
            await nango.saveCheckpoint({ updatedAtCursor: latestUpdatedAt });
        }
    }
});

function toLinearRoadmapRecord(roadmap: LinearRoadmapNode): LinearRoadmapRecord {
    return {
        id: roadmap.id,
        name: roadmap.name ?? '',
        description: roadmap.description ?? null,
        team_ids: roadmapTeamIds(roadmap),
        project_ids: nodeIds(roadmap.projects),
        created_at: toIsoString(roadmap.createdAt),
        updated_at: toIsoString(roadmap.updatedAt)
    };
}

function roadmapTeamIds(roadmap: LinearRoadmapNode): string[] {
    return Array.from(
        new Set(
            (roadmap.projects?.nodes ?? []).flatMap((project) => nodeIds(project.teams))
        )
    );
}
