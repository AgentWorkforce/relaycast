import { describe, expect, it, vi } from 'vitest';

import listProjects from '../actions/list-projects.js';

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

describe('linear-relay list-projects action', () => {
    it('fetches a single page, passes query as server-side filter, skips archived projects, and returns endCursor as nextCursor', async () => {
        const nango = createNango({
            post: vi.fn().mockResolvedValue({
                data: {
                    data: {
                        projects: {
                            nodes: [
                                {
                                    id: 'project-1',
                                    name: 'Roadmap',
                                    description: 'Q3 Engineering roadmap',
                                    state: 'started',
                                    url: 'https://linear.app/acme/project/roadmap'
                                },
                                {
                                    id: 'project-archived',
                                    name: 'Old Engineering Roadmap',
                                    state: 'completed',
                                    archivedAt: '2025-01-01T00:00:00Z'
                                }
                            ],
                            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' }
                        }
                    }
                }
            })
        });

        const result = await listProjects.exec(nango as any, { query: 'eng', cursor: 'cursor-1', limit: 25 });

        expect(result).toEqual({
            projects: [
                {
                    id: 'project-1',
                    name: 'Roadmap',
                    description: 'Q3 Engineering roadmap',
                    state: 'started',
                    url: 'https://linear.app/acme/project/roadmap'
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
                            or: [{ name: { containsIgnoreCase: 'eng' } }, { description: { containsIgnoreCase: 'eng' } }]
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

        await expect(listProjects.exec(nango as any)).rejects.toMatchObject({
            type: 'linear_graphql_error',
            message: 'nope'
        });
    });
});
