import { createAction } from 'nango';
import { z } from 'zod';
import { dynamicWebhookEndpoint, getJiraSite, JiraWebhook, normalizeWebhook } from './webhook-utils.js';

const OutputSchema = z.object({
  webhooks: z.array(JiraWebhook),
});

const action = createAction({
  description: 'List Jira dynamic webhooks registered by the calling OAuth app.',
  version: '1.0.0',
      endpoint: {
    method: 'GET',
    path: '/jira/webhooks',
    group: 'Jira',
  },
  input: z.void(),
  output: OutputSchema,
  // Stable scopes per Atlassian spec for GET /rest/api/3/webhook: read:jira-work +
  // manage:jira-webhook. Granular (read:webhook:jira, read:jql:jira) is Beta.
  scopes: ['read:jira-work', 'manage:jira-webhook', 'read:webhook:jira', 'read:jql:jira'],

  exec: async (nango): Promise<z.infer<typeof OutputSchema>> => {
    const site = await getJiraSite(nango);
    const response = await nango.get({
      // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/#api-rest-api-3-webhook-get
      endpoint: dynamicWebhookEndpoint(site.cloudId),
      retries: 3,
    });

    const data = z.object({ values: z.array(z.unknown()).optional() }).parse(response.data);
    return {
      webhooks: (data.values ?? []).map(normalizeWebhook),
    };
  },
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
