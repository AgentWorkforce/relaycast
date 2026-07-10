import { createOnEvent } from 'nango';
import * as z from 'zod';

import { ensureGooglePubSubInfrastructure } from '../../shared/google-pubsub-setup.js';
import { getRequiredNangoWebhookConfig } from '../../shared/webhook-setup.js';

const MetadataSchema = z
    .object({
        topicName: z.string().optional(),
        labelIds: z.array(z.string()).optional(),
        labelFilterBehavior: z.enum(['include', 'exclude']).optional(),
        gmailWatchTopicName: z.string().optional(),
        gmailWatchLabelIds: z.array(z.string()).optional(),
        gmailWatchLabelFilterBehavior: z.enum(['include', 'exclude']).optional(),
        gmailWatchHistoryId: z.string().optional(),
        gmailWatchExpiration: z.string().optional(),
        emailAddress: z.string().optional(),
        email: z.string().optional()
    })
    .passthrough();

const WATCH_TOPIC_ENV_KEYS = ['GOOGLE_MAIL_WATCH_TOPIC_NAME', 'GMAIL_WATCH_TOPIC_NAME'] as const;

type SetupMetadata = z.infer<typeof MetadataSchema>;

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

const setupWebhooks = createOnEvent({
    event: 'post-connection-creation',
    description: 'Register Gmail Pub/Sub watch subscription for this connection.',
    version: '1.0.0',
    metadata: MetadataSchema,

    exec: async (nango): Promise<void> => {
        const webhookConfig = await getRequiredNangoWebhookConfig(nango);
        const metadata = MetadataSchema.parse((await nango.getMetadata()) ?? {});
        const connection = await nango.getConnection();
        const envMap = await loadEnvMap(nango);

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
        // Relayfile materializes the full mailbox, so the default watch must not
        // narrow delivery to INBOX and miss self-sent/SENT-co-labeled messages.
        const response = await nango.post({
            endpoint: '/gmail/v1/users/me/watch',
            data: {
                topicName: pubSubProvisioning.topicName
            },
            retries: 3
        });
        const watchResponse: WatchResponse = ProviderWatchResponseSchema.parse(response.data);

        const expirationIso = toIsoStringFromMillis(watchResponse.expiration);
        await nango.updateMetadata({
            gmailWatchTopicName: pubSubProvisioning.topicName,
            gmailWatchLabelIds: [],
            ...(pubSubProvisioning.subscriptionName ? { gmailPubsubSubscriptionName: pubSubProvisioning.subscriptionName } : {}),
            gmailWatchHistoryId: watchResponse.historyId,
            gmailWatchExpiration: watchResponse.expiration
        });

        await nango.log(
            `Google Mail webhook setup activated watch for topic ${pubSubProvisioning.topicName} (expires ${expirationIso}). Pub/Sub push endpoint should target ${webhookConfig.url}.`
        );
    }
});

export default setupWebhooks;

function resolveWatchInput(metadata: SetupMetadata, connectionConfig: Record<string, unknown>, envMap: Map<string, string>): WatchInput {
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

async function loadEnvMap(nango: { getEnvironmentVariables: () => Promise<Array<{ name: string; value: string }> | null> }): Promise<Map<string, string>> {
    const envVars = await nango.getEnvironmentVariables();
    if (!envVars) {
        return new Map();
    }

    return new Map(envVars.map((entry) => [entry.name, entry.value]));
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


function toIsoStringFromMillis(value: string): string {
    const millis = Number.parseInt(value, 10);
    if (!Number.isFinite(millis)) {
        return value;
    }

    return new Date(millis).toISOString();
}
