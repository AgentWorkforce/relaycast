import { createSync } from 'nango';
import { z } from 'zod';

import { ensureGooglePubSubInfrastructure } from '../../shared/google-pubsub-setup.js';
import { getRequiredNangoWebhookConfig } from '../../shared/webhook-setup.js';

const MetadataSchema = z
    .object({
        topicName: z.string().optional(),
        labelIds: z.array(z.string()).optional(),
        labelFilterBehavior: z.enum(['include', 'exclude']).optional(),
        gmailWatchTopicName: z.string().optional(),
        gmailWatchLabelIds: z.array(z.string()).optional(),
        gmailWatchLabelFilterBehavior: z.enum(['include', 'exclude']).optional()
    })
    .passthrough();

const GoogleMailWatchRenewal = z.object({
    id: z.string(),
    topicName: z.string(),
    labelIdsJson: z.string().optional(),
    labelFilterBehavior: z.enum(['include', 'exclude']).optional(),
    historyId: z.string(),
    expiration: z.string(),
    renewed_at: z.string()
});

type WatchInput = {
    topicName: string;
};

type WatchResponse = {
    historyId: string;
    expiration: string;
};

const ProviderWatchResponseSchema = z.object({
    historyId: z.string(),
    expiration: z.string()
});

const WATCH_TOPIC_ENV_KEYS = ['GOOGLE_MAIL_WATCH_TOPIC_NAME', 'GMAIL_WATCH_TOPIC_NAME'] as const;

const sync = createSync({
    description: 'Renews Gmail watch subscription daily so webhook ingestion stays active.',
    version: '1.0.0',
    frequency: 'every 24 hours',
    autoStart: true,
    endpoints: [{ method: 'POST', path: '/gmail/webhooks/renew-watch', group: 'Google Mail' }],
    metadata: MetadataSchema,
    models: {
        GoogleMailWatchRenewal
    },
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],

    exec: async (nango) => {
        const webhookConfig = await getRequiredNangoWebhookConfig(nango);
        const metadata = MetadataSchema.parse((await nango.getMetadata()) ?? {});
        const connection = await nango.getConnection();
        const envVars = await nango.getEnvironmentVariables();
        const envMap = new Map((envVars ?? []).map((entry) => [entry.name, entry.value]));

        const watchInput = resolveWatchInput(metadata, connection.connection_config, envMap);
        const pubSubProvisioning = await ensureGooglePubSubInfrastructure({
            nango,
            connectionId: nango.connectionId,
            webhookUrl: webhookConfig.url,
            ...(watchInput.topicName ? { topicName: watchInput.topicName } : {}),
            metadata,
            connectionConfig: connection.connection_config,
            envMap
        });

        // https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch
        // Relayfile materializes the full mailbox, so renewal must preserve the
        // unfiltered watch scope used during connection setup.
        const response = await nango.post({
            endpoint: '/gmail/v1/users/me/watch',
            data: {
                topicName: pubSubProvisioning.topicName
            },
            retries: 3
        });
        const watchResponse: WatchResponse = ProviderWatchResponseSchema.parse(response.data);

        await nango.batchSave(
            [
                {
                    id: nango.connectionId,
                    topicName: pubSubProvisioning.topicName,
                    historyId: watchResponse.historyId,
                    expiration: watchResponse.expiration,
                    renewed_at: new Date().toISOString()
                }
            ],
            'GoogleMailWatchRenewal'
        );

        await nango.updateMetadata({
            gmailWatchTopicName: pubSubProvisioning.topicName,
            gmailWatchLabelIds: [],
            ...(pubSubProvisioning.subscriptionName ? { gmailPubsubSubscriptionName: pubSubProvisioning.subscriptionName } : {}),
            gmailWatchHistoryId: watchResponse.historyId,
            gmailWatchExpiration: watchResponse.expiration
        });

        await nango.log(`Google Mail watch renewal completed; watch expires at ${toIsoStringFromMillis(watchResponse.expiration)}.`);
    }
});

export default sync;

function toIsoStringFromMillis(value: string): string {
    const millis = Number.parseInt(value, 10);
    if (!Number.isFinite(millis)) {
        return value;
    }

    return new Date(millis).toISOString();
}

function resolveWatchInput(metadata: z.infer<typeof MetadataSchema>, connectionConfig: Record<string, unknown>, envMap: Map<string, string>): WatchInput {
    const topicName =
        metadata.topicName ??
        metadata.gmailWatchTopicName ??
        readString(connectionConfig['topicName']) ??
        readString(connectionConfig['gmailWatchTopicName']) ??
        readEnvValue(envMap, WATCH_TOPIC_ENV_KEYS);

    return {
        topicName: topicName ?? ''
    };
}

function readEnvValue(envMap: Map<string, string>, keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = envMap.get(key);
        if (value && value.length > 0) {
            return value;
        }
    }

    return undefined;
}

function readString(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
