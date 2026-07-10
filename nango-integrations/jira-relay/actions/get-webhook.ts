import { createAction } from 'nango';
import { dynamicWebhookEndpoint, getJiraSite, JiraWebhook, normalizeWebhook, toWebhookId, WebhookIdInput } from './webhook-utils.js';

const action = createAction({
  description: 'Get a Jira dynamic webhook by id from the calling OAuth app registrations.',
  version: '1.0.0',
  endpoint: {
    method: 'GET',
    path: '/jira/webhooks/{webhookId}',
    group: 'Jira',
  },
  input: WebhookIdInput,
  output: JiraWebhook,
  // Stable scopes per Atlassian spec for GET /rest/api/3/webhook: read:jira-work +
  // manage:jira-webhook. Granular (read:webhook:jira, read:jql:jira) is Beta.
  scopes: ['read:jira-work', 'manage:jira-webhook', 'read:webhook:jira', 'read:jql:jira'],

  exec: async (nango, input) => {
    const site = await getJiraSite(nango);
    const response = await nango.get({
      // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/#api-rest-api-3-webhook-get
      endpoint: dynamicWebhookEndpoint(site.cloudId),
      retries: 3,
    });

    const webhookId = toWebhookId(input.webhookId);
    const values = (response.data as { values?: unknown[] }).values ?? [];
    const match = values.find((webhook) => String((webhook as { id?: unknown }).id) === webhookId);
    if (!match) {
      throw new nango.ActionError({
        type: 'jira_webhook_not_found',
        message: `Jira dynamic webhook ${webhookId} was not found for this OAuth app.`,
      });
    }

    return normalizeWebhook(match);
  },
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
