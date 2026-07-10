import { z } from 'zod';
import { createAction } from 'nango';

import { ensureGooglePubSubInfrastructure } from '../../shared/google-pubsub-setup.js';
import { getRequiredNangoWebhookConfig } from '../../shared/webhook-setup.js';

const InputSchema = z.object({
    topicName: z.string().optional().describe('The full Cloud Pub/Sub topic name. Format: projects/{project}/topics/{topic}.'),
    labelIds: z.array(z.string()).optional().describe('Optional label IDs used to filter Gmail watch notifications.'),
    labelFilterBehavior: z
        .enum(['include', 'exclude'])
        .optional()
        .describe('Optional label filter behavior. Use include or exclude.')
});

const ProviderWatchResponseSchema = z.object({
    historyId: z.string(),
    expiration: z.string()
});

const OutputSchema = z.object({
    historyId: z.string(),
    expiration: z.string()
});

const action = createAction({
    description: 'Start Gmail push notifications for mailbox changes.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/actions/watch-mailbox',
        group: 'Webhooks'
    },
    input: InputSchema,
    output: OutputSchema,
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],

    exec: async (nango, input): Promise<z.infer<typeof OutputSchema>> => {
        const webhookConfig = await getRequiredNangoWebhookConfig(nango);
        const metadata = asRecord((await nango.getMetadata()) ?? {}) ?? {};
        const connection = await nango.getConnection();
        const envVars = await nango.getEnvironmentVariables();
        const envMap = new Map((envVars ?? []).map((entry) => [entry.name, entry.value]));
        const pubSubProvisioning = await ensureGooglePubSubInfrastructure({
            nango,
            connectionId: nango.connectionId,
            webhookUrl: webhookConfig.url,
            ...(input.topicName ? { topicName: input.topicName } : {}),
            metadata,
            connectionConfig: connection.connection_config,
            envMap
        });

        // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
        const response = await nango.post({
            endpoint: '/gmail/v1/users/me/watch',
            data: {
                topicName: pubSubProvisioning.topicName,
                ...(input.labelIds ? { labelIds: input.labelIds } : {}),
                ...(input.labelFilterBehavior ? { labelFilterBehavior: input.labelFilterBehavior } : {})
            },
            retries: 3
        });

        const watchResponse = ProviderWatchResponseSchema.parse(response.data);
        return {
            historyId: watchResponse.historyId,
            expiration: watchResponse.expiration
        };
    }
});

export default action;

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
