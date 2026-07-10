import { createAction } from 'nango';
import { z } from 'zod';

import {
    LINEAR_PROJECT_MUTATION_FIELDS,
    LinearProjectOutput,
    LinearProjectWritableFields,
    actionError,
    firstGraphqlError,
    parseProjectMutationPayload,
    toLinearProjectInput
} from './project-utils.js';
import type { LinearGraphqlResponse } from '../syncs/helpers.js';

const UpdateProjectFields = LinearProjectWritableFields.partial().refine(
    (value) =>
        Object.values(value).some((fieldValue) => fieldValue !== undefined),
    { message: 'At least one project field must be provided.' }
);

const UpdateProjectInput = z
    .object({
        id: z.string().min(1)
    })
    .and(UpdateProjectFields);

interface UpdateProjectData {
    projectUpdate?: {
        success?: boolean | null;
        project?: unknown;
    } | null;
}

const UPDATE_PROJECT_MUTATION = `
  mutation UpdateProject($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) {
      success
      project {
${LINEAR_PROJECT_MUTATION_FIELDS}
      }
    }
  }
`;

const action = createAction({
    description: 'Updates a Linear project for Relayfile writeback.',
    version: '1.0.0',
    endpoint: {
        method: 'PATCH',
        path: '/linear/projects/{id}',
        group: 'Linear'
    },
    input: UpdateProjectInput,
    output: LinearProjectOutput,
    scopes: ['write'],

    exec: async (nango, input): Promise<z.infer<typeof LinearProjectOutput>> => {
        const parsedInput = await nango.zodValidateInput({ zodSchema: UpdateProjectInput, input });
        const { id, ...fields } = parsedInput.data;
        const projectInput = await toLinearProjectInput(nango, fields);

        const response: { data: unknown } = await nango.post({
            endpoint: '/graphql',
            data: {
                query: UPDATE_PROJECT_MUTATION,
                variables: {
                    id,
                    input: projectInput
                }
            },
            retries: 3
        });

        const body = response.data as LinearGraphqlResponse<UpdateProjectData> | undefined;
        const graphqlError = firstGraphqlError(body);
        if (graphqlError) {
            throw actionError(nango, 'linear_graphql_error', graphqlError);
        }

        return parseProjectMutationPayload(nango, body?.data?.projectUpdate ?? undefined, 'linear_project_update_failed', 'projectUpdate');
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
