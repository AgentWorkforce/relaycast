import { z } from 'zod';

import {
    LINEAR_PROJECT_FIELDS,
    LinearProjectFullSchema,
    toLinearProjectFull,
    type LinearGraphqlResponse
} from '../syncs/helpers.js';

export const LinearProjectStatusInput = z.enum(['planned', 'started', 'paused', 'completed', 'canceled']);

export const LinearProjectWritableFields = z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    leadId: z.string().min(1).optional(),
    startDate: z.string().optional(),
    targetDate: z.string().optional(),
    color: z.string().optional(),
    icon: z.string().optional(),
    state: LinearProjectStatusInput.optional()
});

export const LinearProjectOutput = LinearProjectFullSchema;

export type LinearProjectOutputValue = z.infer<typeof LinearProjectOutput>;

export const LINEAR_PROJECT_MUTATION_FIELDS = `
${LINEAR_PROJECT_FIELDS}
`;

interface ProjectMutationPayload {
    success?: boolean | null;
    project?: unknown;
}

interface ProjectStatusNode {
    id?: string | null;
    type?: string | null;
    archivedAt?: string | null;
}

interface ProjectStatusesData {
    projectStatuses?: {
        nodes?: ProjectStatusNode[];
    } | null;
}

type GraphqlPostInput = {
    endpoint: '/graphql';
    data: unknown;
    retries?: number;
};

export function firstGraphqlError(response: LinearGraphqlResponse<unknown> | undefined): string | null {
    return response?.errors?.[0]?.message ?? null;
}

export function actionError(
    nango: { ActionError: new (input: { type: string; message: string }) => Error },
    type: string,
    message: string
): Error {
    return new nango.ActionError({ type, message });
}

export function parseProjectMutationPayload(
    nango: {
        ActionError: new (input: { type: string; message: string }) => Error;
        log?: (message: string) => Promise<void> | void;
    },
    payload: ProjectMutationPayload | undefined,
    errorType: string,
    mutationName: string
): LinearProjectOutputValue {
    if (!payload) {
        throw actionError(nango, errorType, `Linear ${mutationName} response did not include a payload.`);
    }

    if (!payload.success) {
        throw actionError(nango, errorType, `Linear ${mutationName} returned success=false.`);
    }

    if (!payload.project || typeof payload.project !== 'object') {
        throw actionError(nango, errorType, `Linear ${mutationName} response did not include a project.`);
    }

    logUnknownProjectStatusType(nango, payload.project);

    return LinearProjectOutput.parse(toLinearProjectFull(payload.project as Parameters<typeof toLinearProjectFull>[0]));
}

function logUnknownProjectStatusType(
    nango: { log?: (message: string) => Promise<void> | void },
    project: object
): void {
    const status = 'status' in project && project.status && typeof project.status === 'object' ? project.status : null;
    const value = status && 'type' in status ? status.type : null;
    if (typeof value === 'string' && !LinearProjectStatusInput.safeParse(value).success) {
        void nango.log?.(`Unknown Linear ProjectStatusType value: ${value}`);
    }
}

export async function resolveProjectStatusId(
    nango: {
        post: (input: GraphqlPostInput) => Promise<{ data: unknown }>;
        ActionError: new (input: { type: string; message: string }) => Error;
    },
    state: z.infer<typeof LinearProjectStatusInput> | undefined
): Promise<string | undefined> {
    if (!state) {
        return undefined;
    }

    const response = await nango.post({
        endpoint: '/graphql',
        data: {
            query: `
              query ListProjectStatuses {
                projectStatuses(first: 100, includeArchived: false) {
                  nodes {
                    id
                    type
                    archivedAt
                  }
                }
              }
            `
        },
        retries: 3
    });

    const body = response.data as LinearGraphqlResponse<ProjectStatusesData> | undefined;
    const graphqlError = firstGraphqlError(body);
    if (graphqlError) {
        throw actionError(nango, 'linear_graphql_error', graphqlError);
    }

    const status = body?.data?.projectStatuses?.nodes?.find((node) => node?.type === state && !node.archivedAt);
    if (!status?.id) {
        throw actionError(nango, 'linear_project_status_not_found', `Linear project status '${state}' was not found.`);
    }

    return status.id;
}

export async function toLinearProjectInput(
    nango: {
        post: (input: GraphqlPostInput) => Promise<{ data: unknown }>;
        ActionError: new (input: { type: string; message: string }) => Error;
    },
    input: z.infer<typeof LinearProjectWritableFields> & { teamIds?: string[] }
): Promise<Record<string, unknown>> {
    const { state, ...rest } = input;
    const statusId = await resolveProjectStatusId(nango, state);
    return {
        ...rest,
        ...(statusId ? { statusId } : {})
    };
}
