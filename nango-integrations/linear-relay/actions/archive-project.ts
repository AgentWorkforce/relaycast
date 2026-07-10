import { createAction } from 'nango';
import { z } from 'zod';

import { actionError, firstGraphqlError } from './project-utils.js';
import type { LinearGraphqlResponse } from '../syncs/helpers.js';

const ArchiveProjectInput = z.object({
    id: z.string().min(1),
    trash: z.boolean().optional()
});

const ArchiveProjectOutput = z.object({
    id: z.string(),
    success: z.boolean()
});

interface ArchiveProjectData {
    projectArchive?: {
        success?: boolean | null;
    } | null;
}

const ARCHIVE_PROJECT_MUTATION = `
  mutation ArchiveProject($id: String!, $trash: Boolean) {
    projectArchive(id: $id, trash: $trash) {
      success
    }
  }
`;

const action = createAction({
    description: 'Archives a Linear project for Relayfile writeback.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/linear/projects/{id}/archive',
        group: 'Linear'
    },
    input: ArchiveProjectInput,
    output: ArchiveProjectOutput,
    scopes: ['write'],

    exec: async (nango, input): Promise<z.infer<typeof ArchiveProjectOutput>> => {
        const parsedInput = await nango.zodValidateInput({ zodSchema: ArchiveProjectInput, input });
        const response: { data: unknown } = await nango.post({
            endpoint: '/graphql',
            data: {
                query: ARCHIVE_PROJECT_MUTATION,
                variables: {
                    id: parsedInput.data.id,
                    trash: parsedInput.data.trash ?? false
                }
            },
            retries: 3
        });

        const body = response.data as LinearGraphqlResponse<ArchiveProjectData> | undefined;
        const graphqlError = firstGraphqlError(body);
        if (graphqlError) {
            throw actionError(nango, 'linear_graphql_error', graphqlError);
        }

        if (!body?.data?.projectArchive?.success) {
            throw actionError(nango, 'linear_project_archive_failed', 'Linear projectArchive returned success=false.');
        }

        return { id: parsedInput.data.id, success: true };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
