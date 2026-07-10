import { describe, expect, it, vi } from 'vitest';

import renewWatch from '../syncs/renew-watch.js';

describe('google-mail-relay renew-watch sync', () => {
    it('renews watch without label filters so self-sent messages are not excluded', async () => {
        const nango = {
            ActionError: class ActionError extends Error {
                type?: string;
                constructor({ message, type }: { message: string; type?: string }) {
                    super(message);
                    this.type = type;
                }
            },
            connectionId: 'conn-google-mail-123',
            getIntegration: vi.fn().mockResolvedValue({
                webhook_url: 'https://api.nango.dev/webhook/test/google-mail-relay'
            }),
            getWebhookURL: vi.fn().mockResolvedValue('https://api.nango.dev/webhook/test/google-mail-relay'),
            getMetadata: vi.fn().mockResolvedValue({
                topicName: 'projects/my-project/topics/my-topic',
                labelIds: ['INBOX'],
                labelFilterBehavior: 'include'
            }),
            getConnection: vi.fn().mockResolvedValue({ connection_config: {} }),
            getEnvironmentVariables: vi.fn().mockResolvedValue(null),
            post: vi.fn().mockResolvedValue({
                data: { historyId: '1234567890', expiration: '1893456000000' }
            }),
            batchSave: vi.fn().mockResolvedValue(undefined),
            updateMetadata: vi.fn().mockResolvedValue(undefined),
            log: vi.fn()
        };

        await renewWatch.exec(nango as never);

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/gmail/v1/users/me/watch',
            data: {
                topicName: 'projects/my-project/topics/my-topic'
            },
            retries: 3
        });
        expect(nango.batchSave).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    id: 'conn-google-mail-123',
                    topicName: 'projects/my-project/topics/my-topic',
                    historyId: '1234567890',
                    expiration: '1893456000000'
                })
            ],
            'GoogleMailWatchRenewal'
        );
        const savedRenewal = nango.batchSave.mock.calls[0]?.[0][0] as Record<string, unknown>;
        expect(savedRenewal).not.toHaveProperty('labelIdsJson');
        expect(savedRenewal).not.toHaveProperty('labelFilterBehavior');
        expect(nango.updateMetadata).toHaveBeenCalledWith(
            expect.objectContaining({
                gmailWatchTopicName: 'projects/my-project/topics/my-topic',
                gmailWatchLabelIds: [],
                gmailWatchHistoryId: '1234567890',
                gmailWatchExpiration: '1893456000000'
            })
        );
    });
});
