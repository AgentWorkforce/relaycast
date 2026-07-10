import { createSync, type NangoSync } from 'nango';
import * as z from 'zod';

import {
  LINEAR_GET_ISSUE_QUERY,
  LinearActiveIssueSchema,
  toLinearActiveIssueRecord,
  type LinearActiveIssueRecord,
  type LinearConnection,
  type LinearGraphqlResponse,
  type LinearIssueNode,
} from './helpers.js';

// Model + projection live in ./helpers (Nango forbids non-default exports from
// sync entry files); see LinearActiveIssueSchema / toLinearActiveIssueRecord.
const LinearIssue = LinearActiveIssueSchema;

type LinearIssueRecord = LinearActiveIssueRecord;

interface LinearIssuesData {
  issues?: LinearConnection<LinearIssueNode>;
}

interface LinearIssueByIdData {
  issue?: LinearIssueNode | null;
}

interface LinearWebhookEnvelope {
  action?: string | null;
  data?: LinearIssueNode;
}

const INITIAL_UPDATED_AFTER = '1970-01-01T00:00:00.000Z';
const LinearCheckpointSchema = z.object({
  updatedAtCursor: z.string(),
});
const LINEAR_ACTIVE_ISSUE_FIELDS = `
        id
        identifier
        title
        description
        state {
          id
          name
          type
        }
        priority
        assignee {
          id
          name
        }
        team {
          id
          key
          name
        }
        labels(first: 50) {
          nodes {
            id
            name
            color
          }
        }
        url
        createdAt
        updatedAt
`;
const FETCH_ACTIVE_ISSUES_QUERY = `
  query FetchActiveIssues($after: String, $updatedAfter: DateTimeOrDuration!) {
    issues(
      filter: {
        updatedAt: { gt: $updatedAfter }
      }
      first: 100
      after: $after
      orderBy: updatedAt
    ) {
      nodes {
${LINEAR_ACTIVE_ISSUE_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null;
};

const isString = (value: unknown): value is string => {
  return typeof value === 'string';
};

const getErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

const getIssuesConnection = (
  response: LinearGraphqlResponse<LinearIssuesData> | undefined,
): LinearConnection<LinearIssueNode> => {
  if (response?.errors && response.errors.length > 0) {
    const message = response.errors[0]?.message ?? 'Unknown GraphQL error';
    throw new Error(`Linear GraphQL error: ${message}`);
  }

  const issues = response?.data?.issues;
  if (!issues) {
    throw new Error('Linear GraphQL response did not include issues data.');
  }

  return issues;
};

const getIssueById = (
  response: LinearGraphqlResponse<LinearIssueByIdData> | undefined,
): LinearIssueNode | null => {
  if (response?.errors && response.errors.length > 0) {
    const message = response.errors[0]?.message ?? 'Unknown GraphQL error';
    throw new Error(`Linear GraphQL error: ${message}`);
  }

  return response?.data?.issue ?? null;
};

const fetchIssueById = async (nango: NangoSync, id: string): Promise<LinearIssueNode | null> => {
  const response: { data: unknown } = await nango.post({
    endpoint: '/graphql',
    data: {
      query: LINEAR_GET_ISSUE_QUERY,
      variables: { id },
    },
    retries: 3,
  });

  return getIssueById(response.data as LinearGraphqlResponse<LinearIssueByIdData> | undefined);
};

const getWebhookIssue = (payload: unknown): LinearIssueNode | null => {
  if (!isRecord(payload)) {
    return null;
  }

  if (isString(payload['id'])) {
    return payload as unknown as LinearIssueNode;
  }

  const nested = (payload as LinearWebhookEnvelope).data;
  if (isRecord(nested) && isString(nested.id)) {
    return nested as unknown as LinearIssueNode;
  }

  return null;
};

export default createSync({
  description: 'Fetches Linear issues and keeps lifecycle states current with issue webhooks.',
  version: '1.2.0',
  frequency: 'every 12 hours',
  autoStart: true,
  syncType: 'incremental',
  endpoints: [{ method: 'GET', path: '/linear/active-issues', group: 'Linear' }],
  metadata: z.object({}),
  checkpoint: LinearCheckpointSchema,
  models: { LinearIssue },

  webhookSubscriptions: ['Issue'],

  exec: async (nango) => {
    await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearIssue');

    const checkpoint = await nango.getCheckpoint();
    const updatedAfter = checkpoint?.updatedAtCursor ?? INITIAL_UPDATED_AFTER;
    const records: LinearIssueRecord[] = [];
    let cursor: string | null = null;
    let hasNextPage = true;
    let latestUpdatedAt = updatedAfter;

    try {
      while (hasNextPage) {
        const response = await nango.post({
          endpoint: '/graphql',
          data: {
            query: FETCH_ACTIVE_ISSUES_QUERY,
            variables: {
              after: cursor,
              updatedAfter,
            },
          },
          retries: 3,
        });

        const issues = getIssuesConnection(
          response.data as LinearGraphqlResponse<LinearIssuesData> | undefined,
        );

        for (const issue of issues.nodes ?? []) {
          const record = toLinearActiveIssueRecord(issue);
          records.push(record);

          if (record.updated_at > latestUpdatedAt) {
            latestUpdatedAt = record.updated_at;
          }
        }

        cursor = issues.pageInfo?.endCursor ?? null;
        hasNextPage = Boolean(issues.pageInfo?.hasNextPage && cursor);
      }
    } catch (error) {
      await nango.log(`Failed to sync Linear issues: ${getErrorMessage(error)}`);
      throw error;
    }

    if (records.length > 0) {
      await nango.batchSave(records, 'LinearIssue');
    }

    if (latestUpdatedAt !== INITIAL_UPDATED_AFTER) {
      await nango.saveCheckpoint({
        updatedAtCursor: latestUpdatedAt,
      });
    }
  },

  onWebhook: async (nango, payload) => {
    await nango.setMergingStrategy({ strategy: 'ignore_if_modified_after' }, 'LinearIssue');

    const webhook = payload as LinearWebhookEnvelope;
    const action = typeof webhook.action === 'string' ? webhook.action : null;
    const issue = getWebhookIssue(webhook);
    if (!issue?.id) {
      return;
    }

    try {
      if (action === 'remove') {
        await nango.batchDelete([{ id: issue.id }], 'LinearIssue');
        return;
      }

      const latestIssue = await fetchIssueById(nango, issue.id);
      if (!latestIssue) {
        await nango.log(`Linear issue webhook skipped because issue ${issue.id} could not be fetched.`);
        return;
      }

      await nango.batchSave([toLinearActiveIssueRecord(latestIssue)], 'LinearIssue');
    } catch (error) {
      await nango.log(`Failed to process Linear issue webhook: ${getErrorMessage(error)}`);
      throw error;
    }
  },
});
