import { createAction } from 'nango';
import { z } from 'zod';

const CreateIssueInput = z.object({
  teamId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  projectId: z.string().optional(),
  milestoneId: z.string().optional(),
  assigneeId: z.string().optional(),
  priority: z.number().optional(),
  parentId: z.string().optional(),
  estimate: z.number().optional(),
  dueDate: z.string().optional(),
});

const LinearIssue = z.object({
  id: z.string(),
  identifier: z.string().optional(),
  assigneeId: z.string().nullable().optional(),
  creatorId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  description: z.string().nullable(),
  dueDate: z.string().nullable(),
  projectId: z.string().nullable(),
  teamId: z.string(),
  title: z.string(),
  status: z.string(),
  url: z.string().optional(),
});

const LINEAR_CREATED_ISSUE_FIELDS = `
        id
        identifier
        title
        description
        dueDate
        url
        createdAt
        updatedAt
        assignee {
          id
        }
        creator {
          id
        }
        project {
          id
        }
        team {
          id
        }
        state {
          name
        }
`;

const CreateIssueResponse = z.object({
  data: z.object({
    issueCreate: z.object({
      success: z.boolean(),
      issue: z
        .object({
          id: z.string(),
          identifier: z.string().optional(),
          title: z.string(),
          description: z.string().nullable().optional(),
          dueDate: z.string().nullable().optional(),
          url: z.string().optional(),
          createdAt: z.string(),
          updatedAt: z.string(),
          assignee: z.object({ id: z.string().optional() }).nullable().optional(),
          creator: z.object({ id: z.string().optional() }).nullable().optional(),
          project: z.object({ id: z.string().optional() }).nullable().optional(),
          team: z.object({ id: z.string() }),
          state: z.object({ name: z.string().optional() }).nullable().optional(),
        })
        .nullable(),
    }),
  }),
  errors: z.array(z.object({ message: z.string().optional() })).optional(),
});

function toCreateIssueVariables(input: z.infer<typeof CreateIssueInput>): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    ...input,
    ...(input.milestoneId ? { projectMilestoneId: input.milestoneId } : {}),
  };
  delete variables['milestoneId'];
  return variables;
}

function toLinearIssue(issue: z.infer<typeof CreateIssueResponse>['data']['issueCreate']['issue']): z.infer<typeof LinearIssue> {
  if (!issue) {
    throw new Error('Linear issueCreate response did not include an issue.');
  }

  return {
    id: issue.id,
    ...(issue.identifier ? { identifier: issue.identifier } : {}),
    assigneeId: issue.assignee?.id ?? null,
    creatorId: issue.creator?.id ?? null,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    description: issue.description ?? null,
    dueDate: issue.dueDate ?? null,
    projectId: issue.project?.id ?? null,
    teamId: issue.team.id,
    title: issue.title,
    status: issue.state?.name ?? '',
    ...(issue.url ? { url: issue.url } : {}),
  };
}

const action = createAction({
  description: 'Creates a Linear issue for Relayfile writeback.',
  version: '1.0.0',
  endpoint: {
    method: 'POST',
    path: '/linear/issues',
    group: 'Linear',
  },
  input: CreateIssueInput,
  output: LinearIssue,
  scopes: ['issues:create'],

  exec: async (nango, input): Promise<z.infer<typeof LinearIssue>> => {
    const parsedInput = await nango.zodValidateInput({ zodSchema: CreateIssueInput, input });
    const query = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
${LINEAR_CREATED_ISSUE_FIELDS}
          }
        }
      }
    `;

    const response = await nango.post({
      // https://studio.apollographql.com/public/Linear-API/variant/current/explorer
      endpoint: '/graphql',
      data: {
        query,
        variables: {
          input: toCreateIssueVariables(parsedInput.data),
        },
      },
      retries: 3,
    });

    const parsedResponse = CreateIssueResponse.parse(response.data);
    if (parsedResponse.errors && parsedResponse.errors.length > 0) {
      throw new nango.ActionError({
        type: 'linear_graphql_error',
        message: parsedResponse.errors[0]?.message ?? 'Linear GraphQL returned an error.',
      });
    }

    if (!parsedResponse.data.issueCreate.success) {
      throw new nango.ActionError({
        type: 'linear_issue_create_failed',
        message: 'Linear issueCreate returned success=false.',
      });
    }

    return LinearIssue.parse(toLinearIssue(parsedResponse.data.issueCreate.issue));
  },
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
