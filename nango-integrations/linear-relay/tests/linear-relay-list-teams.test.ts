import { describe, expect, it, vi } from 'vitest';

import listTeams from '../actions/list-teams.js';

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

describe('linear-relay list-teams action', () => {
    it('fetches a single page, filters by query, and returns endCursor as nextCursor', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        teams: {
                            nodes: [
                                { id: 'team-1', name: 'Engineering', key: 'ENG', private: false },
                                { id: 'team-2', name: 'Support', key: 'SUP', private: true },
                                { id: 'team-archived', name: 'Old Engineering', key: 'OLD', archivedAt: '2025-01-01T00:00:00Z' }
                            ],
                            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' }
                        }
                    }
                }
            })
        });

        const result = await listTeams.exec(nango as any, { query: 'eng', cursor: 'cursor-1', limit: 25 });

        expect(result).toEqual({
            teams: [{ id: 'team-1', name: 'Engineering', key: 'ENG', private: false }],
            nextCursor: 'cursor-2'
        });
        expect(nango.post).toHaveBeenCalledTimes(1);
        expect(nango.post).toHaveBeenCalledWith(
            expect.objectContaining({
                endpoint: '/graphql',
                data: expect.objectContaining({ variables: { first: 25, after: 'cursor-1' } })
            })
        );
    });

    it('throws a typed ActionError on a GraphQL error', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({ data: { errors: [{ message: 'nope' }] } })
        });

        await expect(listTeams.exec(nango as any)).rejects.toMatchObject({
            type: 'linear_graphql_error',
            message: 'nope'
        });
    });
});
