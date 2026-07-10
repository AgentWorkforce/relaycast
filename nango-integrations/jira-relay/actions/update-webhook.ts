import { createAction } from 'nango';
import { z } from 'zod';
import { dynamicWebhookEndpoint, getJiraSite, RefreshWebhookOutput, toWebhookId, WebhookIdInput } from './webhook-utils.js';

const InputSchema = z.object({
  webhookId: WebhookIdInput.shape.webhookId,
});

const action = createAction({
  description: 'Refreshes a Jira dynamic webhook and returns the current registration.',
  version: '1.0.0',
  endpoint: {
    method: 'PUT',
    path: '/jira/webhooks/{webhookId}',
    group: 'Jira',
  },
  input: InputSchema,
  output: RefreshWebhookOutput,
  // Stable scopes per Atlassian spec for PUT /rest/api/3/webhook/refresh:
  // read:jira-work + manage:jira-webhook. Granular (write:webhook:jira, read:webhook:jira) is Beta.
  scopes: ['read:jira-work', 'manage:jira-webhook', 'write:webhook:jira', 'read:webhook:jira'],

  exec: async (nango, input): Promise<z.infer<typeof RefreshWebhookOutput>> => {
    const site = await getJiraSite(nango);
    const webhookId = toWebhookId(input.webhookId);
    const response = await nango.put({
      // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/#api-rest-api-3-webhook-refresh-put
      endpoint: dynamicWebhookEndpoint(site.cloudId, '/refresh'),
      data: {
        webhookIds: [Number(webhookId)],
      },
      retries: 3,
    });

    return {
      success: true,
      webhookId,
      ...(typeof response.data?.expirationDate === 'string' ? { expirationDate: response.data.expirationDate } : {}),
    };
  },
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
