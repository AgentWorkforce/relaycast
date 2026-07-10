import { describe, expect, it, vi } from 'vitest';

import watchMailbox from '../actions/watch-mailbox.js';

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
        connectionId: 'conn-google-mail-123',
        getIntegration: vi.fn().mockResolvedValue({
            webhook_url: 'https://api.nango.dev/webhook/test/google-mail-relay'
        }),
        getWebhookURL: vi.fn().mockResolvedValue('https://api.nango.dev/webhook/test/google-mail-relay'),
        getMetadata: vi.fn().mockResolvedValue({}),
        getConnection: vi.fn().mockResolvedValue({
            connection_config: {}
        }),
        getEnvironmentVariables: vi.fn().mockResolvedValue(null),
        post: vi.fn().mockResolvedValue({
            data: {
                historyId: '1234567890',
                expiration: '1893456000000'
            }
        }),
        updateMetadata: vi.fn().mockResolvedValue({}),
        log: vi.fn(),
        ...overrides
    };
}

describe('google-mail-relay watch-mailbox action', () => {
    it('uses the explicit topicName and stores watch metadata', async () => {
        const nango = createNango();

        const result = await watchMailbox.exec(nango as never, {
            topicName: 'projects/my-project/topics/my-topic',
            labelIds: ['INBOX'],
            labelFilterBehavior: 'include'
        });

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/gmail/v1/users/me/watch',
            data: {
                topicName: 'projects/my-project/topics/my-topic',
                labelIds: ['INBOX'],
                labelFilterBehavior: 'include'
            },
            retries: 3
        });
        expect(result).toStrictEqual({
            historyId: '1234567890',
            expiration: '1893456000000'
        });
    });

    it('throws ActionError when no topicName can be resolved', async () => {
        const nango = createNango();

        const error = await watchMailbox.exec(nango as never, {}).catch((cause: Error) => cause);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('ActionError');
        expect((error as Error & { type?: string }).type).toBe('missing_gmail_watch_topic_name');
    });
});
