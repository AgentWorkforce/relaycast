import type { NangoAction } from 'nango';
import { z } from 'zod';

export const SlackIncomingWebhookMetadata = z.object({
    hasIncomingWebhook: z.boolean(),
    channel: z.string().optional(),
    channelId: z.string().optional(),
    configurationUrl: z.string().optional()
});

export const SlackIncomingWebhookMessage = z
    .object({
        text: z.string().min(1).optional(),
        blocks: z.array(z.record(z.string(), z.unknown())).optional(),
        attachments: z.array(z.record(z.string(), z.unknown())).optional(),
        thread_ts: z.string().min(1).optional(),
        unfurl_links: z.boolean().optional(),
        unfurl_media: z.boolean().optional(),
        metadata: z.record(z.string(), z.unknown()).optional()
    })
    .refine((input) => input.text !== undefined || input.blocks !== undefined || input.attachments !== undefined, {
        message: 'Provide at least one of text, blocks, or attachments.',
        path: ['text']
    });

export const SlackIncomingWebhookSendOutput = z.object({
    success: z.boolean(),
    responseText: z.string().optional()
});

type SlackAction = Pick<NangoAction, 'getConnection' | 'ActionError'>;

interface IncomingWebhookRecord {
    url: string;
    channel?: string;
    channel_id?: string;
    configuration_url?: string;
}

export async function getIncomingWebhook(nango: SlackAction): Promise<IncomingWebhookRecord | null> {
    const connection = await nango.getConnection();
    return findIncomingWebhook(connection);
}

export function toIncomingWebhookMetadata(webhook: IncomingWebhookRecord | null): z.infer<typeof SlackIncomingWebhookMetadata> {
    if (!webhook) {
        return { hasIncomingWebhook: false };
    }

    return {
        hasIncomingWebhook: true,
        ...(webhook.channel ? { channel: webhook.channel } : {}),
        ...(webhook.channel_id ? { channelId: webhook.channel_id } : {}),
        ...(webhook.configuration_url ? { configurationUrl: webhook.configuration_url } : {})
    };
}

export function requireIncomingWebhook(nango: SlackAction, webhook: IncomingWebhookRecord | null): IncomingWebhookRecord {
    if (!webhook) {
        throw new nango.ActionError({
            type: 'slack_incoming_webhook_missing',
            message:
                'This Slack connection does not include an incoming_webhook URL. Reconnect with the incoming-webhook OAuth scope and choose a posting channel.'
        });
    }

    return webhook;
}

export function toSlackWebhookPayload(input: z.infer<typeof SlackIncomingWebhookMessage>): Record<string, unknown> {
    return {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.blocks !== undefined ? { blocks: input.blocks } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
        ...(input.thread_ts !== undefined ? { thread_ts: input.thread_ts } : {}),
        ...(input.unfurl_links !== undefined ? { unfurl_links: input.unfurl_links } : {}),
        ...(input.unfurl_media !== undefined ? { unfurl_media: input.unfurl_media } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {})
    };
}

function findIncomingWebhook(value: unknown, depth = 0): IncomingWebhookRecord | null {
    if (!value || typeof value !== 'object' || depth > 5) {
        return null;
    }

    const record = value as Record<string, unknown>;
    const candidate = parseIncomingWebhookRecord(record['incoming_webhook']);
    if (candidate) {
        return candidate;
    }

    const direct = parseIncomingWebhookRecord(record);
    if (direct) {
        return direct;
    }

    for (const child of Object.values(record)) {
        const match = findIncomingWebhook(child, depth + 1);
        if (match) {
            return match;
        }
    }

    return null;
}

function parseIncomingWebhookRecord(value: unknown): IncomingWebhookRecord | null {
    if (!value || typeof value !== 'object') {
        return null;
    }

    const record = value as Record<string, unknown>;
    const url = record['url'];
    if (typeof url !== 'string' || !isSlackIncomingWebhookUrl(url)) {
        return null;
    }

    return {
        url,
        ...(typeof record['channel'] === 'string' ? { channel: record['channel'] } : {}),
        ...(typeof record['channel_id'] === 'string' ? { channel_id: record['channel_id'] } : {}),
        ...(typeof record['configuration_url'] === 'string' ? { configuration_url: record['configuration_url'] } : {})
    };
}

function isSlackIncomingWebhookUrl(value: string): boolean {
    return /^https:\/\/hooks\.(slack|slack-gov)\.com\/services\/[^/]+\/[^/]+\/[^/]+$/.test(value);
}
