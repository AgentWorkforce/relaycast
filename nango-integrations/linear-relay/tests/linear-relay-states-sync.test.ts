import { describe, expect, it, vi } from 'vitest';

import statesSync from '../syncs/states.js';

const START_CURSOR = '2026-05-01T00:00:00.000Z';

function createNango(overrides: Record<string, unknown> = {}) {
    return {
        setMergingStrategy: vi.fn(),
        batchSave: vi.fn(),
        getCheckpoint: vi.fn().mockResolvedValue({ updatedAtCursor: START_CURSOR }),
        saveCheckpoint: vi.fn(),
        log: vi.fn(),
        post: vi.fn(),
        ...overrides
    };
}

function stateNode(id: string, updatedAt: string) {
    return {
        id,
        name: `State ${id}`,
        description: null,
        type: 'started',
        color: '#f97316',
        position: 2,
        team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt
    };
}

function statesResponse(nodes: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }) {
    return {
        data: {
            data: {
                workflowStates: {
                    nodes,
                    pageInfo
                }
            }
        }
    };
}

describe('linear-relay states sync', () => {
    it('resumes from a saved page cursor while preserving the timestamp window', async () => {
        const post = vi.fn().mockResolvedValue(statesResponse([], { hasNextPage: false, endCursor: null }));
        const nango = createNango({
            getCheckpoint: vi.fn().mockResolvedValue({
                updatedAtCursor: START_CURSOR,
                pageCursor: 'cursor-page-2'
            }),
            post
        });

        await statesSync.exec?.(nango as any);

        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    variables: expect.objectContaining({
                        after: 'cursor-page-2',
                        updatedAfter: START_CURSOR
                    })
                })
            })
        );
    });

    it('saves a mid-run page cursor checkpoint before advancing the timestamp cursor', async () => {
        const newerUpdatedAt = '2026-05-02T00:00:00.000Z';
        const post = vi
            .fn()
            .mockResolvedValueOnce(
                statesResponse([stateNode('state-1', newerUpdatedAt)], {
                    hasNextPage: true,
                    endCursor: 'cursor-page-2'
                })
            )
            .mockResolvedValueOnce(statesResponse([], { hasNextPage: false, endCursor: null }));
        const nango = createNango({ post });

        await statesSync.exec?.(nango as any);

        expect(nango.batchSave).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    id: 'state-1',
                    team_id: 'team-1',
                    updated_at: newerUpdatedAt
                })
            ],
            'LinearState'
        );
        expect(nango.saveCheckpoint).toHaveBeenNthCalledWith(1, {
            updatedAtCursor: START_CURSOR,
            pageCursor: 'cursor-page-2'
        });
        expect(nango.saveCheckpoint).toHaveBeenLastCalledWith({
            updatedAtCursor: newerUpdatedAt
        });
    });

    it('skips malformed states that are missing team id or position', async () => {
        const post = vi.fn().mockResolvedValue(
            statesResponse(
                [
                    { ...stateNode('missing-team', '2026-05-02T00:00:00.000Z'), team: null },
                    { ...stateNode('missing-position', '2026-05-02T00:00:00.000Z'), position: null }
                ],
                { hasNextPage: false, endCursor: null }
            )
        );
        const nango = createNango({ post });

        await statesSync.exec?.(nango as any);

        expect(nango.batchSave).not.toHaveBeenCalled();
        expect(nango.log).toHaveBeenCalledTimes(2);
        expect(nango.saveCheckpoint).toHaveBeenLastCalledWith({
            updatedAtCursor: START_CURSOR
        });
    });
});
