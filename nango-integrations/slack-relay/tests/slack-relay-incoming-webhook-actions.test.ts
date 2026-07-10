import { afterEach, describe, expect, it, vi } from 'vitest';

import getIncomingWebhook from '../actions/get-incoming-webhook.js';
import sendIncomingWebhook from '../actions/send-incoming-webhook.js';

const incomingWebhook = {
    channel: '#relayfile',
    channel_id: 'C1234567890',
    configuration_url: 'https://example.slack.com/services/B1234567890',
    url: ['https://hooks.slack.com', 'services', 'T1234567890', 'B1234567890', 'XXXXXXXXXXXXXXXXXXXXXXXX'].join('/')
};

function createNango(overrides: Record<string, unknown> = {}) {
    class ActionError extends Error {
        type?: string;

        constructor({ message, type }: { message: string; type?: string }) {
            super(message);
            this.name = 'ActionError';
            this.type = type;
        }
    }

    return {
        ActionError,
        getConnection: vi.fn().mockResolvedValue({
            connection_config: {
                incoming_webhook: incomingWebhook
            }
        }),
        ...overrides
    };
}

describe('slack-relay incoming webhook actions', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns incoming webhook metadata without exposing the URL', async () => {
        const nango = createNango();

        const result = await getIncomingWebhook.exec(nango as any, undefined);

        expect(result).toEqual({
            hasIncomingWebhook: true,
            channel: incomingWebhook.channel,
            channelId: incomingWebhook.channel_id,
            configurationUrl: incomingWebhook.configuration_url
        });
        expect(JSON.stringify(result)).not.toContain('hooks.slack.com');
    });

    it('posts through the stored incoming webhook URL', async () => {
        const fetchMock = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            text: vi.fn().mockResolvedValue('ok')
        });
        vi.stubGlobal('fetch', fetchMock);
        const nango = createNango();
        const input = {
            text: 'Relayfile update',
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: '*Relayfile update*'
                    }
                }
            ],
            thread_ts: '1715360000.000100',
            unfurl_links: false
        };

        const result = await sendIncomingWebhook.exec(nango as any, input);

        expect(fetchMock).toHaveBeenCalledWith(incomingWebhook.url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(input),
            signal: expect.any(AbortSignal)
        });
        expect(result).toEqual({ success: true, responseText: 'ok' });
    });

    it('requires a connection with an incoming webhook URL', async () => {
        const nango = createNango({
            getConnection: vi.fn().mockResolvedValue({ connection_config: {} })
        });

        await expect(sendIncomingWebhook.exec(nango as any, { text: 'hello' })).rejects.toMatchObject({
            name: 'ActionError',
            type: 'slack_incoming_webhook_missing'
        });
    });

    it('surfaces Slack incoming webhook errors', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 403,
                statusText: 'Forbidden',
                text: vi.fn().mockResolvedValue('action_prohibited')
            })
        );
        const nango = createNango();

        await expect(sendIncomingWebhook.exec(nango as any, { text: 'hello' })).rejects.toMatchObject({
            name: 'ActionError',
            type: 'slack_incoming_webhook_failed',
            message: expect.stringContaining('action_prohibited')
        });
    });

    it('converts Slack incoming webhook network failures into action errors', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network timeout')));
        const nango = createNango();

        await expect(sendIncomingWebhook.exec(nango as any, { text: 'hello' })).rejects.toMatchObject({
            name: 'ActionError',
            type: 'slack_incoming_webhook_failed',
            message: expect.stringContaining('network timeout')
        });
    });
});
