import { describe, expect, it, vi } from 'vitest';

import cycleSync from '../syncs/fetch-cycles.js';

const START_CURSOR = '2026-05-01T00:00:00.000Z';

function createNango(overrides: Record<string, unknown> = {}) {
    return {
        setMergingStrategy: vi.fn(),
        batchSave: vi.fn(),
        getCheckpoint: vi.fn().mockResolvedValue({ updatedAtCursor: START_CURSOR }),
        saveCheckpoint: vi.fn(),
        log: vi.fn(),
        post: vi.fn(),
        ...overrides,
    };
}

function cycleNode(id: string, updatedAt: string) {
    return {
        id,
        name: `Cycle ${id}`,
        number: 1,
        description: null,
        team: { id: 'team-1' },
        startsAt: '2026-05-01T00:00:00.000Z',
        endsAt: '2026-05-14T00:00:00.000Z',
        completedAt: null,
        progress: 0.5,
        createdAt: '2026-04-30T00:00:00.000Z',
        updatedAt,
    };
}

function cyclesResponse(nodes: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }) {
    return {
        data: {
            data: {
                cycles: {
                    nodes,
                    pageInfo,
                },
            },
        },
    };
}

describe('linear-relay fetch-cycles checkpoint behavior', () => {
    it('resumes from a saved page cursor while keeping the saved timestamp window', async () => {
        const post = vi.fn().mockResolvedValue(cyclesResponse([], { hasNextPage: false, endCursor: null }));
        const nango = createNango({
            getCheckpoint: vi.fn().mockResolvedValue({
                updatedAtCursor: START_CURSOR,
                pageCursor: 'cursor-page-2',
            }),
            post,
        });

        await cycleSync.exec?.(nango as any);

        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    variables: expect.objectContaining({
                        after: 'cursor-page-2',
                        updatedAfter: START_CURSOR,
                    }),
                }),
            }),
        );
    });

    it('saves a mid-run checkpoint without advancing the timestamp cursor', async () => {
        const newerUpdatedAt = '2026-05-02T00:00:00.000Z';
        const post = vi
            .fn()
            .mockResolvedValueOnce(
                cyclesResponse([cycleNode('cycle-1', newerUpdatedAt)], {
                    hasNextPage: true,
                    endCursor: 'cursor-page-2',
                }),
            )
            .mockResolvedValueOnce(cyclesResponse([], { hasNextPage: false, endCursor: null }));
        const nango = createNango({ post });

        await cycleSync.exec?.(nango as any);

        expect(nango.saveCheckpoint).toHaveBeenNthCalledWith(1, {
            updatedAtCursor: START_CURSOR,
            pageCursor: 'cursor-page-2',
        });
        expect(nango.saveCheckpoint).toHaveBeenLastCalledWith({
            updatedAtCursor: newerUpdatedAt,
        });
    });

    it('advances the final timestamp checkpoint and clears the page cursor', async () => {
        const latestUpdatedAt = '2026-05-03T12:30:00.000Z';
        const post = vi
            .fn()
            .mockResolvedValue(
                cyclesResponse([cycleNode('cycle-1', latestUpdatedAt)], {
                    hasNextPage: false,
                    endCursor: null,
                }),
            );
        const nango = createNango({ post });

        await cycleSync.exec?.(nango as any);

        expect(nango.saveCheckpoint).toHaveBeenCalledTimes(1);
        expect(nango.saveCheckpoint).toHaveBeenLastCalledWith({
            updatedAtCursor: latestUpdatedAt,
        });
    });

    it('clears a stale page cursor after an empty successful run', async () => {
        const post = vi.fn().mockResolvedValue(cyclesResponse([], { hasNextPage: false, endCursor: null }));
        const nango = createNango({
            getCheckpoint: vi.fn().mockResolvedValue({
                updatedAtCursor: START_CURSOR,
                pageCursor: 'stale-page-cursor',
            }),
            post,
        });

        await cycleSync.exec?.(nango as any);

        expect(nango.saveCheckpoint).toHaveBeenCalledTimes(1);
        expect(nango.saveCheckpoint).toHaveBeenLastCalledWith({
            updatedAtCursor: START_CURSOR,
        });
    });

    it('does not clear pageCursor when a page fetch throws', async () => {
        const post = vi
            .fn()
            .mockResolvedValueOnce(
                cyclesResponse([cycleNode('cycle-1', '2026-05-02T00:00:00.000Z')], {
                    hasNextPage: true,
                    endCursor: 'cursor-page-2',
                }),
            )
            .mockRejectedValueOnce(new Error('GraphQL request failed'));
        const nango = createNango({ post });

        await expect(cycleSync.exec?.(nango as any)).rejects.toThrow('GraphQL request failed');

        // Mid-run checkpoint should have been saved with the page cursor
        expect(nango.saveCheckpoint).toHaveBeenCalledWith({
            updatedAtCursor: START_CURSOR,
            pageCursor: 'cursor-page-2',
        });
        // Final checkpoint (which clears pageCursor by omission) must NOT have been saved
        expect(nango.saveCheckpoint).not.toHaveBeenCalledWith({
            updatedAtCursor: '2026-05-02T00:00:00.000Z',
        });
    });
});
