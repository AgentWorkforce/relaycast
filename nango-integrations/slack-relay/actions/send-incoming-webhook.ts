import { createAction } from 'nango';
import { z } from 'zod';
import {
    getIncomingWebhook,
    requireIncomingWebhook,
    SlackIncomingWebhookMessage,
    SlackIncomingWebhookSendOutput,
    toSlackWebhookPayload
} from './incoming-webhook-utils.js';

const SLACK_WEBHOOK_TIMEOUT_MS = 15_000;

const action = createAction({
    description: 'Posts a message through the Slack incoming webhook URL returned by the Slack OAuth install.',
    version: '1.0.0',
    endpoint: {
        method: 'POST',
        path: '/slack/incoming-webhook/messages',
        group: 'Slack'
    },
    input: SlackIncomingWebhookMessage,
    output: SlackIncomingWebhookSendOutput,
    scopes: ['incoming-webhook'],

    exec: async (nango, input): Promise<z.infer<typeof SlackIncomingWebhookSendOutput>> => {
        const webhook = requireIncomingWebhook(nango, await getIncomingWebhook(nango));
        let response: Response;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), SLACK_WEBHOOK_TIMEOUT_MS);
            try {
                response = await fetch(webhook.url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(toSlackWebhookPayload(input)),
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeout);
            }
        } catch (error) {
            throw new nango.ActionError({
                type: 'slack_incoming_webhook_failed',
                message: `Slack incoming webhook request failed: ${error instanceof Error ? error.message : String(error)}`
            });
        }
        const responseText = await response.text();

        if (!response.ok || responseText !== 'ok') {
            throw new nango.ActionError({
                type: 'slack_incoming_webhook_failed',
                message: `Slack incoming webhook failed with status ${response.status}: ${responseText || response.statusText}`
            });
        }

        return {
            success: true,
            responseText
        };
    }
});

export type NangoActionLocal = Parameters<(typeof action)['exec']>[0];
export default action;
