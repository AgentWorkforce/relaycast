import { describe, expect, it, vi } from 'vitest';

import listAssignees from '../actions/list-assignees.js';

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

describe('linear-relay list-assignees action', () => {
    it('fetches a single page, passes query as server-side filter, skips inactive users, and returns endCursor as nextCursor', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        users: {
                            nodes: [
                                {
                                    id: 'user-1',
                                    name: 'Benjamin Smith',
                                    displayName: 'Benjamin',
                                    email: 'ben@example.test',
                                    active: true
                                },
                                {
                                    id: 'user-inactive',
                                    name: 'Old Benjamin',
                                    displayName: 'Old Ben',
                                    email: 'old-ben@example.test',
                                    active: false
                                }
                            ],
                            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' }
                        }
                    }
                }
            })
        });

        const result = await listAssignees.exec(nango as any, { query: 'ben', cursor: 'cursor-1', limit: 25 });

        expect(result).toEqual({
            assignees: [
                {
                    id: 'user-1',
                    name: 'Benjamin Smith',
                    displayName: 'Benjamin',
                    email: 'ben@example.test'
                }
            ],
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
                        filter: {
                            active: { eq: true },
                            or: [
                                { name: { containsIgnoreCase: 'ben' } },
                                { displayName: { containsIgnoreCase: 'ben' } },
                                { email: { containsIgnoreCase: 'ben' } }
                            ]
                        }
                    }
                })
            })
        );
    });

    it('throws a typed ActionError on a GraphQL error', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({ data: { errors: [{ message: 'nope' }] } })
        });

        await expect(listAssignees.exec(nango as any)).rejects.toMatchObject({
            type: 'linear_graphql_error',
            message: 'nope'
        });
    });
});
