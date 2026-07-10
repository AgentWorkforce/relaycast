import { createAction } from 'nango';
import { z } from 'zod';
import { dynamicWebhookEndpoint, getJiraSite, toWebhookId, WebhookIdInput } from './webhook-utils.js';

const OutputSchema = z.object({
  success: z.boolean(),
  webhookId: z.string(),
});

const action = createAction({
  description: 'Delete a Jira dynamic webhook registered by the calling OAuth app.',
  version: '1.0.0',
  endpoint: {
    method: 'DELETE',
    path: '/jira/webhooks/{webhookId}',
    group: 'Jira',
  },
  input: WebhookIdInput,
  output: OutputSchema,
  // Stable scopes per Atlassian spec for DELETE /rest/api/3/webhook:
  // read:jira-work + manage:jira-webhook. Granular (delete:webhook:jira) is Beta.
  scopes: ['read:jira-work', 'manage:jira-webhook', 'delete:webhook:jira'],

  exec: async (nango, input): Promise<z.infer<typeof OutputSchema>> => {
    const site = await getJiraSite(nango);
    const webhookId = toWebhookId(input.webhookId);
    await nango.delete({
      // https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-webhooks/#api-rest-api-3-webhook-delete
      endpoint: dynamicWebhookEndpoint(site.cloudId),
      data: {
        webhookIds: [Number(webhookId)],
      },
      retries: 3,
    });

    return {
      success: true,
      webhookId,
    };
  },
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
