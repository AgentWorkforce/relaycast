import { describe, expect, it, vi } from 'vitest';

import setupWebhooks from '../on-events/setup-webhooks.js';

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
        triggerAction: vi.fn(),
        updateMetadata: vi.fn().mockResolvedValue({}),
        log: vi.fn(),
        ...overrides
    };
}

describe('google-mail-relay setup-webhooks on-event', () => {
    it('registers Gmail watch without label filters so self-sent messages are not excluded', async () => {
        const nango = createNango({
            getMetadata: vi.fn().mockResolvedValue({
                topicName: 'projects/my-project/topics/my-topic',
                labelIds: ['INBOX'],
                labelFilterBehavior: 'include'
            })
        });

        await setupWebhooks.exec(nango as never);

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/gmail/v1/users/me/watch',
            data: {
                topicName: 'projects/my-project/topics/my-topic'
            },
            retries: 3
        });
        expect(nango.updateMetadata).toHaveBeenCalledWith(
            expect.objectContaining({
                gmailWatchTopicName: 'projects/my-project/topics/my-topic',
                gmailWatchLabelIds: [],
                gmailWatchHistoryId: '1234567890',
                gmailWatchExpiration: '1893456000000'
            })
        );
    });

    it('uses environment variables for topic fallback but ignores legacy label-filter env values', async () => {
        const nango = createNango({
            getEnvironmentVariables: vi.fn().mockResolvedValue([
                { name: 'GOOGLE_MAIL_WATCH_TOPIC_NAME', value: 'projects/env-project/topics/env-topic' },
                { name: 'GOOGLE_MAIL_WATCH_LABEL_IDS', value: 'INBOX,IMPORTANT' },
                { name: 'GOOGLE_MAIL_WATCH_LABEL_FILTER_BEHAVIOR', value: 'exclude' }
            ])
        });

        await setupWebhooks.exec(nango as never);

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/gmail/v1/users/me/watch',
            data: {
                topicName: 'projects/env-project/topics/env-topic'
            },
            retries: 3
        });
    });

    it('throws a typed ActionError when topicName is missing', async () => {
        const nango = createNango();

        const error = await setupWebhooks.exec(nango as never).catch((cause: Error) => cause);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).name).toBe('ActionError');
        expect((error as Error & { type?: string }).type).toBe('missing_gmail_watch_topic_name');
    });
});
