import { createSync } from 'nango';
import * as z from 'zod';

import { LINEAR_LABEL_FIELDS } from '../shared/query-fragments.generated.js';
import {
    INITIAL_UPDATED_AFTER,
    LinearCheckpointSchema,
    LinearLabelRecordSchema,
    formatError,
    requireLinearConnection,
    toLinearLabelRecord,
    type LinearConnection,
    type LinearGraphqlResponse,
    type LinearLabelNode,
    type LinearLabelRecord
} from './helpers.js';

interface LinearLabelsData {
    issueLabels?: LinearConnection<LinearLabelNode>;
}

const LIST_LABELS_QUERY = `
  query ListLabels($first: Int, $after: String, $updatedAfter: DateTimeOrDuration!) {
    issueLabels(first: $first, after: $after, filter: { updatedAt: { gte: $updatedAfter } }) {
      nodes {
${LINEAR_LABEL_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export default createSync({
    description: 'Fetches Linear issue labels for Relayfile materialization.',
    version: '1.0.0',
    frequency: 'every 12 hours',
    autoStart: true,
    syncType: 'incremental',
    endpoints: [{ method: 'GET', path: '/linear/labels', group: 'Linear' }],
    metadata: z.object({}),
    checkpoint: LinearCheckpointSchema,
    models: { LinearLabel: LinearLabelRecordSchema },

    exec: async (nango) => {
        await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearLabel');

        const checkpoint = await nango.getCheckpoint();
        const updatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
        let cursor: string | null = null;
        let hasNextPage = true;
        let latestUpdatedAt = updatedAfter;

        try {
            while (hasNextPage) {
                const response: { data: unknown } = await nango.post({
                    endpoint: '/graphql',
                    data: {
                        query: LIST_LABELS_QUERY,
                        variables: {
                            first: 100,
                            after: cursor,
                            updatedAfter
                        }
                    },
                    retries: 3
                });

                const labels: LinearConnection<LinearLabelNode> = requireLinearConnection(
                    response.data as LinearGraphqlResponse<LinearLabelsData> | undefined,
                    (data) => data.issueLabels,
                    'issueLabels'
                );

                const recordsToSave: LinearLabelRecord[] = [];
                for (const label of labels.nodes ?? []) {
                    const record = toLinearLabelRecord(label);
                    recordsToSave.push(record);
                    if (record.updated_at > latestUpdatedAt) {
                        latestUpdatedAt = record.updated_at;
                    }
                }

                if (recordsToSave.length > 0) {
                    await nango.batchSave(recordsToSave, 'LinearLabel');
                }

                cursor = labels.pageInfo?.endCursor ?? null;
                hasNextPage = Boolean(labels.pageInfo?.hasNextPage && cursor);
            }
        } catch (error) {
            await nango.log(`Failed to sync Linear labels: ${formatError(error)}`);
            throw error;
        }

        if (latestUpdatedAt !== updatedAfter) {
            await nango.saveCheckpoint({ updatedAtCursor: latestUpdatedAt });
        }
    }
});
