import { describe, expect, it, vi } from 'vitest';

import listLabels from '../actions/list-labels.js';

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

describe('linear-relay list-labels action', () => {
    it('fetches a single page, passes query as server-side filter, skips archived labels, and returns endCursor as nextCursor', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        issueLabels: {
                            nodes: [
                                { id: 'label-1', name: 'Bug', color: '#d73a4a' },
                                {
                                    id: 'label-archived',
                                    name: 'Old Bug',
                                    color: '#cccccc',
                                    archivedAt: '2025-01-01T00:00:00Z'
                                }
                            ],
                            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' }
                        }
                    }
                }
            })
        });

        const result = await listLabels.exec(nango as any, { query: 'bug', cursor: 'cursor-1', limit: 25 });

        expect(result).toEqual({
            labels: [{ id: 'label-1', name: 'Bug', color: '#d73a4a' }],
            nextCursor: 'cursor-2'
        });
        expect(nango.post).toHaveBeenCalledTimes(1);
        expect(nango.post).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/graphql',
                data: expect.objectContaining({
                    variables: {
                        first: 25,
                        after: 'cursor-1',
                        filter: { name: { containsIgnoreCase: 'bug' } }
                    }
                })
            })
        );
    });

    it('throws a typed ActionError on a GraphQL error', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({ data: { errors: [{ message: 'nope' }] } })
        });

        await expect(listLabels.exec(nango as any)).rejects.toMatchObject({
            type: 'linear_graphql_error',
            message: 'nope'
        });
    });
});
