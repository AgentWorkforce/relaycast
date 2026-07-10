import { createAction } from 'nango';
import { dynamicWebhookEndpoint, getJiraSite, JiraWebhook, JiraWebhookPayload, normalizeWebhook, toDynamicWebhookDetails } from './webhook-utils.js';

const action = createAction({
  description: 'Register a Jira dynamic webhook for the calling OAuth app.',
  version: '1.0.0',
  endpoint: {
    method: 'POST',
    path: '/jira/webhooks',
    group: 'Jira',
  },
  input: JiraWebhookPayload,
  output: JiraWebhook,
  // Stable scopes per Atlassian spec for POST /rest/api/3/webhook: read:jira-work +
  // manage:jira-webhook. Granular (write:webhook:jira, read:project:jira, read:field:jira) is Beta.
  scopes: [
    'read:jira-work',
    'manage:jira-webhook',
    'write:webhook:jira',
    'read:jql:jira',
    'read:project:jira',
    'read:field:jira',
  ],

  exec: async (nango, input) => {
    const site = await getJiraSite(nango);
    const response = await nango.post({
      // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/#api-rest-api-3-webhook-post
      endpoint: dynamicWebhookEndpoint(site.cloudId),
      data: {
        url: input.url,
        webhooks: [toDynamicWebhookDetails(input)],
      },
    });

    const data = {
      id: response.data?.webhookRegistrationResult?.[0]?.createdWebhookId,
      url: input.url,
      events: input.events,
      jqlFilter: input.jqlFilter ?? input.filters?.['issue-related-events-section'] ?? '',
      ...(input.fieldIdsFilter ? { fieldIdsFilter: input.fieldIdsFilter } : {}),
      ...(input.issuePropertyKeysFilter ? { issuePropertyKeysFilter: input.issuePropertyKeysFilter } : {}),
    };

    return normalizeWebhook(data);
  },
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
