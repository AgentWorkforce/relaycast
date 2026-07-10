import { createOnEvent } from 'nango';
import { z } from 'zod';

const SLACK_CONNECTION_WEBHOOK_SUBSCRIPTIONS = [
    'message',
    'app_mention',
    'message.channels',
    'message.groups',
    'message.im',
    'message.mpim'
] as const;

function readStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0) : [];
}

const setup = createOnEvent({
    event: 'post-connection-creation',
    description: 'Bootstrap Slack connection metadata required for Nango webhook dispatch.',
    version: '1.0.0',
    metadata: z.object({}).passthrough(),

    exec: async (nango): Promise<void> => {
        const metadata = ((await nango.getMetadata()) ?? {}) as Record<string, unknown>;
        const existing = readStringArray(metadata['webhookSubscriptions']);
        const webhookSubscriptions = [...new Set([...existing, ...SLACK_CONNECTION_WEBHOOK_SUBSCRIPTIONS])];

        await nango.setMetadata({
            ...metadata,
            webhookSubscriptions
        });

        await nango.log(
            `Slack connection metadata initialized with ${webhookSubscriptions.length} webhook subscription keys.`
        );
    }
});

export default setup;
