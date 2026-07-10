import { createAction } from 'nango';
import { z } from 'zod';

import { ensureGooglePubSubInfrastructure } from '../../shared/google-pubsub-setup.js';
import { getRequiredNangoWebhookConfig } from '../../shared/webhook-setup.js';

const InputSchema = z.object({
    topicName: z.string().optional().describe('Optional full topic name. Format: projects/{project}/topics/{topic}.'),
    subscriptionName: z.string().optional().describe('Optional full subscription name or subscription id.')
});

const OutputSchema = z.object({
    topicName: z.string(),
    subscriptionName: z.string().optional(),
    autoProvisionAttempted: z.boolean(),
    autoProvisionApplied: z.boolean()
});

const action = createAction({
    description: 'Provision and validate Google Pub/Sub resources used by Gmail watch webhooks.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/actions/provision-pubsub-infrastructure',
        group: 'Webhooks'
    },
    input: InputSchema,
    output: OutputSchema,

    exec: async (nango, input): Promise<z.infer<typeof OutputSchema>> => {
        const webhookConfig = await getRequiredNangoWebhookConfig(nango);
        const metadata = asRecord((await nango.getMetadata()) ?? {}) ?? {};
        const connection = await nango.getConnection();
        const envVars = await nango.getEnvironmentVariables();
        const envMap = new Map((envVars ?? []).map((entry) => [entry.name, entry.value]));

        const provisioningMetadata = {
            ...metadata,
            ...(input.subscriptionName ? { pubsubSubscriptionName: input.subscriptionName } : {})
        };

        const provisioning = await ensureGooglePubSubInfrastructure({
            nango,
            connectionId: nango.connectionId,
            webhookUrl: webhookConfig.url,
            ...(input.topicName ? { topicName: input.topicName } : {}),
            metadata: provisioningMetadata,
            connectionConfig: connection.connection_config,
            envMap
        });

        return {
            topicName: provisioning.topicName,
            ...(provisioning.subscriptionName ? { subscriptionName: provisioning.subscriptionName } : {}),
            autoProvisionAttempted: provisioning.autoProvisionAttempted,
            autoProvisionApplied: provisioning.autoProvisionApplied
        };
    }
});

export default action;

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
