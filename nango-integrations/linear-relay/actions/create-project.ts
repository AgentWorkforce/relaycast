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

const CreateProjectInput = LinearProjectWritableFields.extend({
    name: z.string().min(1),
    teamIds: z.array(z.string().min(1)).min(1)
});

interface CreateProjectData {
    projectCreate?: {
        success?: boolean | null;
        project?: unknown;
    } | null;
}

const CREATE_PROJECT_MUTATION = `
  mutation CreateProject($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project {
${LINEAR_PROJECT_MUTATION_FIELDS}
      }
    }
  }
`;

const action = createAction({
    description: 'Creates a Linear project for Relayfile writeback.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/linear/projects',
        group: 'Linear'
    },
    input: CreateProjectInput,
    output: LinearProjectOutput,
    scopes: ['write'],

    exec: async (nango, input): Promise<z.infer<typeof LinearProjectOutput>> => {
        const parsedInput = await nango.zodValidateInput({ zodSchema: CreateProjectInput, input });
        const projectInput = await toLinearProjectInput(nango, parsedInput.data);

        const response: { data: unknown } = await nango.post({
            endpoint: '/graphql',
            data: {
                query: CREATE_PROJECT_MUTATION,
                variables: {
                    input: projectInput
                }
            },
            retries: 3
        });

        const body = response.data as LinearGraphqlResponse<CreateProjectData> | undefined;
        const graphqlError = firstGraphqlError(body);
        if (graphqlError) {
            throw actionError(nango, 'linear_graphql_error', graphqlError);
        }

        return parseProjectMutationPayload(nango, body?.data?.projectCreate ?? undefined, 'linear_project_create_failed', 'projectCreate');
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
