import { createAction } from 'nango';
import { z } from 'zod';

import { getJiraSite } from './webhook-utils.js';

const CreateIssueInput = z.object({
  summary: z.string().min(1),
  description: z.string().optional(),
  assignee: z.string().optional(),
  labels: z.array(z.string()).optional(),
  project: z.string().min(1),
  issueType: z.string().min(1),
});

const CreateIssueOutput = z.object({
  id: z.string(),
  key: z.string(),
  self: z.string(),
});

function toJiraIssue(input: z.infer<typeof CreateIssueInput>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    summary: input.summary,
    issuetype: { id: input.issueType },
    project: { id: input.project },
  };

  if (input.description) {
    fields['description'] = {
      version: 1,
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: input.description }],
        },
      ],
    };
  }

  if (input.assignee) {
    fields['assignee'] = { id: input.assignee };
  }

  if (input.labels && input.labels.length > 0) {
    fields['labels'] = input.labels;
  }

  return { fields };
}

const action = createAction({
  description: 'Creates a Jira issue for Relayfile writeback.',
  version: '1.0.0',
  endpoint: {
    method: 'POST',
    path: '/jira/issues',
    group: 'Jira',
  },
  input: CreateIssueInput,
  output: CreateIssueOutput,
  // `write:jira-work` is the *stable* required scope for POST /rest/api/3/issue;
  // granular alternatives are still Beta per Atlassian's OpenAPI spec.
  scopes: [
    'write:jira-work',
    'write:issue:jira',
    'write:comment:jira',
    'write:comment.property:jira',
    'write:attachment:jira',
    'read:issue:jira',
    'read:project:jira',
    'read:issue-type:jira',
  ],

  exec: async (nango, input): Promise<z.infer<typeof CreateIssueOutput>> => {
    const parsedInput = await nango.zodValidateInput({ zodSchema: CreateIssueInput, input });
    const site = await getJiraSite(nango);
    const response = await nango.post({
      // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/#api-rest-api-3-issue-post
      endpoint: `/ex/jira/${site.cloudId}/rest/api/3/issue`,
      headers: {
        'X-Atlassian-Token': 'no-check',
      },
      data: toJiraIssue(parsedInput.data),
      retries: 3,
    });

    return CreateIssueOutput.parse(response.data);
  },
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
