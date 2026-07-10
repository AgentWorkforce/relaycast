import { describe, expect, it, vi } from 'vitest';

import labelSync from '../syncs/fetch-labels.js';

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

function labelsResponse(nodes: unknown[], pageInfo: { hasNextPage: boolean; endCursor: string | null }) {
    return {
        data: {
            data: {
                issueLabels: {
                    nodes,
                    pageInfo
                }
            }
        }
    };
}

describe('linear-relay fetch-labels sync', () => {
    it('saves active and archived labels with metadata for Relayfile lookup aliases', async () => {
        const post = vi.fn().mockResolvedValueOnce(
            labelsResponse(
                [
                    {
                        id: 'label-1',
                        name: 'Escalation',
                        description: 'Needs prompt attention',
                        color: '#95a2b3',
                        team: { id: 'team-1', key: 'ENG', name: 'Engineering' },
                        parent: { id: 'parent-1', name: 'Area' },
                        archivedAt: null,
                        createdAt: '2026-05-01T00:00:00.000Z',
                        updatedAt: '2026-05-02T00:00:00.000Z'
                    },
                    {
                        id: 'archived-label',
                        name: 'Archived',
                        archivedAt: '2026-05-03T00:00:00.000Z',
                        createdAt: '2026-05-01T00:00:00.000Z',
                        updatedAt: '2026-05-03T00:00:00.000Z'
                    }
                ],
                { hasNextPage: false, endCursor: null }
            )
        );
        const nango = createNango({ post });

        await labelSync.exec?.(nango as any);

        expect(post).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({
                    variables: expect.objectContaining({
                        updatedAfter: START_CURSOR
                    })
                })
            })
        );
        expect(nango.batchSave).toHaveBeenCalledWith(
            [
                expect.objectContaining({
                    id: 'label-1',
                    name: 'Escalation',
                    team_id: 'team-1',
                    team_name: 'Engineering',
                    parent_id: 'parent-1',
                    parent_name: 'Area',
                    updated_at: '2026-05-02T00:00:00.000Z'
                }),
                expect.objectContaining({
                    id: 'archived-label',
                    name: 'Archived',
                    archived_at: '2026-05-03T00:00:00.000Z',
                    updated_at: '2026-05-03T00:00:00.000Z'
                })
            ],
            'LinearLabel'
        );
        expect(nango.saveCheckpoint).toHaveBeenLastCalledWith({
            updatedAtCursor: '2026-05-03T00:00:00.000Z'
        });
    });

    it('saves labels incrementally per page instead of accumulating all pages', async () => {
        const post = vi
            .fn()
            .mockResolvedValueOnce(
                labelsResponse(
                    [
                        {
                            id: 'label-page-1',
                            name: 'Page 1',
                            createdAt: '2026-05-01T00:00:00.000Z',
                            updatedAt: '2026-05-02T00:00:00.000Z'
                        }
                    ],
                    { hasNextPage: true, endCursor: 'cursor-1' }
                )
            )
            .mockResolvedValueOnce(
                labelsResponse(
                    [
                        {
                            id: 'label-page-2',
                            name: 'Page 2',
                            createdAt: '2026-05-01T00:00:00.000Z',
                            updatedAt: '2026-05-04T00:00:00.000Z'
                        }
                    ],
                    { hasNextPage: false, endCursor: null }
                )
            );
        const nango = createNango({ post });

        await labelSync.exec?.(nango as any);

        expect(nango.batchSave).toHaveBeenNthCalledWith(
            1,
            [expect.objectContaining({ id: 'label-page-1' })],
            'LinearLabel'
        );
        expect(nango.batchSave).toHaveBeenNthCalledWith(
            2,
            [expect.objectContaining({ id: 'label-page-2' })],
            'LinearLabel'
        );
        expect(nango.saveCheckpoint).toHaveBeenLastCalledWith({
            updatedAtCursor: '2026-05-04T00:00:00.000Z'
        });
    });
});
