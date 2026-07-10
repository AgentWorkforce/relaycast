import { describe, expect, it, vi } from 'vitest';

import provisionPubSubInfrastructure from '../actions/provision-pubsub-infrastructure.js';

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
        log: vi.fn(),
        ...overrides
    };
}

describe('google-mail-relay provision-pubsub-infrastructure action', () => {
    it('returns fallback state when service account credentials are not configured', async () => {
        const nango = createNango();

        const result = await provisionPubSubInfrastructure.exec(nango as never, {
            topicName: 'projects/my-project/topics/my-topic'
        });

        expect(result).toStrictEqual({
            topicName: 'projects/my-project/topics/my-topic',
            subscriptionName: 'projects/my-project/subscriptions/nango-gmail-conn-google-mail-123',
            autoProvisionAttempted: true,
            autoProvisionApplied: false
        });
    });
});
