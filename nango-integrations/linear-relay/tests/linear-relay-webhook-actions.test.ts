import { describe, expect, it, vi } from 'vitest';

import createWebhook from '../actions/create-webhook.js';
import deleteWebhook from '../actions/delete-webhook.js';
import listWebhooks from '../actions/list-webhooks.js';

const webhook = {
    id: '790ce3f6-ea44-473d-bbd9-f3c73dc745a9',
    url: 'https://relayfile.example.com/api/v1/webhooks/linear',
    enabled: true,
    team: {
        id: '72b2a2dc-6f4f-4423-9d34-24b5bd10634a',
        name: 'Relay'
    },
    creator: {
        name: 'Relayfile'
    }
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
        post: vi.fn(),
        ...overrides
    };
}

describe('linear-relay webhook actions', () => {
    it('lists Linear webhooks through GraphQL pagination', async () => {
        const nango = createNango({
            post: vi
                .fn()
                .mockResolvedValueOnce({
                    data: {
                        data: {
                            webhooks: {
                                nodes: [webhook],
                                pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
                            }
                        }
                    }
                })
                .mockResolvedValueOnce({
                    data: {
                        data: {
                            webhooks: {
                                nodes: [{ ...webhook, id: 'second-webhook' }],
                                pageInfo: { hasNextPage: false, endCursor: null }
                            }
                        }
                    }
                })
        });

        const result = await listWebhooks.exec(nango as any, { first: 25 });

        expect(nango.post).toHaveBeenNthCalledWith(1, {
            endpoint: '/graphql',
            data: {
                query: expect.stringContaining('query ListWebhooks'),
                variables: { first: 25, after: null }
            },
            retries: 3
        });
        expect(nango.post).toHaveBeenNthCalledWith(2, {
            endpoint: '/graphql',
            data: {
                query: expect.stringContaining('query ListWebhooks'),
                variables: { first: 25, after: 'cursor-1' }
            },
            retries: 3
        });
        expect(result.webhooks.map((item) => item.id)).toEqual([webhook.id, 'second-webhook']);
    });

    it('creates a webhook for all public teams', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        webhookCreate: {
                            success: true,
                            webhook
                        }
                    }
                }
            })
        });

        const input = {
            url: webhook.url,
            resourceTypes: ['Issue', 'Comment'],
            allPublicTeams: true
        };
        const result = await createWebhook.exec(nango as any, input);

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/graphql',
            data: {
                query: expect.stringContaining('mutation CreateWebhook'),
                variables: {
                    input
                }
            },
            retries: 3
        });
        expect(result).toEqual({ success: true, webhook });
    });

    it('deletes a webhook by id', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        webhookDelete: {
                            success: true
                        }
                    }
                }
            })
        });

        const result = await deleteWebhook.exec(nango as any, { webhookId: webhook.id });

        expect(nango.post).toHaveBeenCalledWith({
            endpoint: '/graphql',
            data: {
                query: expect.stringContaining('mutation DeleteWebhook'),
                variables: { id: webhook.id }
            },
            retries: 3
        });
        expect(result).toEqual({ success: true, webhookId: webhook.id });
    });
});
