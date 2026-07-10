import { createAction } from 'nango';
import { z } from 'zod';

import { firstGraphqlError } from './project-utils.js';
import type { LinearGraphqlResponse } from '../syncs/helpers.js';

const AddIssuesToProjectInput = z.object({
    projectId: z.string().min(1),
    issueIds: z.array(z.string().min(1)).min(1)
});

const AddIssuesToProjectResult = z.object({
    issueId: z.string(),
    success: z.boolean(),
    error: z.string().optional()
});

const AddIssuesToProjectOutput = z.object({
    results: z.array(AddIssuesToProjectResult)
});

interface IssueUpdateData {
    issueUpdate?: {
        success?: boolean | null;
    } | null;
}

const DEFAULT_CONCURRENCY = 5;

const UPDATE_ISSUE_PROJECT_MUTATION = `
  mutation AddIssueToProject($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) {
      success
    }
  }
`;

type NangoClient = {
    post: (input: { endpoint: '/graphql'; data: unknown; retries?: number }) => Promise<{ data: unknown }>;
};

async function addIssueToProject(
    nango: NangoClient,
    issueId: string,
    projectId: string
): Promise<z.infer<typeof AddIssuesToProjectResult>> {
    try {
        const response = await nango.post({
            endpoint: '/graphql',
            data: {
                query: UPDATE_ISSUE_PROJECT_MUTATION,
                variables: {
                    id: issueId,
                    input: { projectId }
                }
            },
            retries: 3
        });

        const body = response.data as LinearGraphqlResponse<IssueUpdateData> | undefined;
        const graphqlError = firstGraphqlError(body);
        if (graphqlError) {
            return { issueId, success: false, error: graphqlError };
        }

        if (!body?.data?.issueUpdate?.success) {
            return { issueId, success: false, error: 'Linear issueUpdate returned success=false.' };
        }

        return { issueId, success: true };
    } catch (error) {
        return {
            issueId,
            success: false,
            error: error instanceof Error ? error.message : String(error)
        };
    }
}

const action = createAction({
    description: 'Adds existing Linear issues to a project for Relayfile writeback.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/linear/projects/{id}/add-issues',
        group: 'Linear'
    },
    input: AddIssuesToProjectInput,
    output: AddIssuesToProjectOutput,
    scopes: ['write'],

    exec: async (nango, input): Promise<z.infer<typeof AddIssuesToProjectOutput>> => {
        const parsedInput = await nango.zodValidateInput({ zodSchema: AddIssuesToProjectInput, input });
        const { projectId, issueIds } = parsedInput.data;
        const results: Array<z.infer<typeof AddIssuesToProjectResult>> = [];

        for (let index = 0; index < issueIds.length; index += DEFAULT_CONCURRENCY) {
            const chunk = issueIds.slice(index, index + DEFAULT_CONCURRENCY);
            const settled = await Promise.allSettled(chunk.map((issueId) => addIssueToProject(nango, issueId, projectId)));
            for (let settledIndex = 0; settledIndex < settled.length; settledIndex += 1) {
                const item = settled[settledIndex];
                if (item?.status === 'fulfilled') {
                    results.push(item.value);
                    continue;
                }

                results.push({
                    issueId: chunk[settledIndex] ?? '',
                    success: false,
                    error: item?.reason instanceof Error ? item.reason.message : String(item?.reason)
                });
            }
        }

        return AddIssuesToProjectOutput.parse({ results });
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
