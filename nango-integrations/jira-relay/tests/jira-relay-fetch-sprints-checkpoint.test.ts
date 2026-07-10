import { describe, expect, it, vi } from 'vitest';

import sprintSync from '../syncs/fetch-sprints.js';

const SITE = {
    cloudId: 'cloud-123',
    baseUrl: 'https://example.atlassian.net',
};

type NangoMock = ReturnType<typeof createNango>;

function createNango(overrides: Record<string, unknown> = {}) {
    return {
        getMetadata: vi.fn().mockResolvedValue(SITE),
        getConnection: vi.fn(),
        getCheckpoint: vi.fn().mockResolvedValue(undefined),
        saveCheckpoint: vi.fn().mockResolvedValue(undefined),
        clearCheckpoint: vi.fn().mockResolvedValue(undefined),
        trackDeletesStart: vi.fn().mockResolvedValue(undefined),
        trackDeletesEnd: vi.fn().mockResolvedValue(undefined),
        batchSave: vi.fn().mockResolvedValue(undefined),
        log: vi.fn(),
        get: vi.fn(),
        ...overrides,
    };
}

function boardPage(boards: Array<{ id: number; name?: string }>) {
    return {
        data: {
            values: boards.map((board) => ({
                type: 'scrum',
                ...board,
            })),
            startAt: 0,
            maxResults: 50,
            total: boards.length,
            isLast: true,
        },
    };
}

function sprintPage(
    sprints: Array<{ id: number; name?: string }>,
    options: { startAt?: number; maxResults?: number; total?: number; isLast?: boolean } = {},
) {
    return {
        data: {
            values: sprints.map((sprint) => ({
                state: 'active',
                name: sprint.name ?? `Sprint ${sprint.id}`,
                ...sprint,
            })),
            startAt: options.startAt ?? 0,
            maxResults: options.maxResults ?? 50,
            total: options.total ?? sprints.length,
            isLast: options.isLast ?? true,
        },
    };
}

function routeResponses(nango: NangoMock, responses: Record<string, unknown>) {
    nango.get.mockImplementation(async (config: { endpoint: string; params?: Record<string, unknown> }) => {
        if (config.endpoint.endsWith('/rest/agile/1.0/board')) {
            return responses.boards;
        }

        const boardId = config.endpoint.match(/\/board\/(\d+)\/sprint$/)?.[1];
        const startAt = String(config.params?.startAt ?? 0);
        const key = `board:${boardId}:startAt:${startAt}`;
        if (key in responses) {
            const response = responses[key];
            if (response instanceof Error) {
                throw response;
            }
            return response;
        }

        throw new Error(`unexpected request: ${key}`);
    });
}

function sprintRequests(nango: NangoMock) {
    return nango.get.mock.calls
        .map(([config]) => config as { endpoint: string; params?: Record<string, unknown> })
        .filter((config) => config.endpoint.includes('/sprint'));
}

describe('jira-relay fetch-sprints checkpoint behavior', () => {
    it('starts delete tracking once and persists the open window before saving sprints', async () => {
        const nango = createNango();
        routeResponses(nango, {
            boards: boardPage([{ id: 101 }]),
            'board:101:startAt:0': sprintPage([{ id: 1001 }]),
        });

        await sprintSync.exec?.(nango as any);

        expect(nango.trackDeletesStart).toHaveBeenCalledTimes(1);
        expect(nango.trackDeletesStart).toHaveBeenCalledWith('JiraSprint');
        expect(nango.saveCheckpoint).toHaveBeenNthCalledWith(1, {
            deleteTrackingStarted: true,
            boardCursor: 0,
            startAt: 0,
        });
        expect(nango.trackDeletesStart.mock.invocationCallOrder[0]).toBeLessThan(
            nango.batchSave.mock.invocationCallOrder[0],
        );
        expect(nango.saveCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
            nango.batchSave.mock.invocationCallOrder[0],
        );
    });

    it('resumes from a saved board cursor and sprint page', async () => {
        const nango = createNango({
            getCheckpoint: vi.fn().mockResolvedValue({
                deleteTrackingStarted: true,
                boardCursor: 1,
                startAt: 50,
            }),
        });
        routeResponses(nango, {
            boards: boardPage([{ id: 101 }, { id: 202 }]),
            'board:202:startAt:50': sprintPage([{ id: 2001 }], { startAt: 50 }),
        });

        await sprintSync.exec?.(nango as any);

        const requests = sprintRequests(nango);
        expect(requests).toHaveLength(1);
        expect(requests[0]?.endpoint).toContain('/board/202/sprint');
        expect(requests[0]?.params).toMatchObject({ startAt: 50, maxResults: 50 });
        expect(requests.some((request) => request.endpoint.includes('/board/101/sprint'))).toBe(false);
        expect(nango.trackDeletesStart).not.toHaveBeenCalled();
    });

    it('persists mid-board and board-complete checkpoints', async () => {
        const nango = createNango();
        routeResponses(nango, {
            boards: boardPage([{ id: 101 }]),
            'board:101:startAt:0': sprintPage([{ id: 1001 }], {
                startAt: 0,
                maxResults: 50,
                total: 75,
                isLast: false,
            }),
            'board:101:startAt:50': sprintPage([{ id: 1002 }], {
                startAt: 50,
                maxResults: 50,
                total: 75,
                isLast: true,
            }),
        });

        await sprintSync.exec?.(nango as any);

        expect(nango.saveCheckpoint).toHaveBeenCalledWith({
            deleteTrackingStarted: true,
            boardCursor: 0,
            startAt: 50,
        });
        expect(nango.saveCheckpoint).toHaveBeenCalledWith({
            deleteTrackingStarted: true,
            boardCursor: 1,
            startAt: 0,
        });
    });

    it('does not close delete tracking or clear the checkpoint when a later sprint page fails', async () => {
        const nango = createNango();
        routeResponses(nango, {
            boards: boardPage([{ id: 101 }]),
            'board:101:startAt:0': sprintPage([{ id: 1001 }], {
                startAt: 0,
                maxResults: 50,
                total: 75,
                isLast: false,
            }),
            'board:101:startAt:50': new Error('jira sprint page failed'),
        });

        await expect(sprintSync.exec?.(nango as any)).rejects.toThrow('jira sprint page failed');

        expect(nango.saveCheckpoint).toHaveBeenCalledWith({
            deleteTrackingStarted: true,
            boardCursor: 0,
            startAt: 50,
        });
        expect(nango.trackDeletesEnd).not.toHaveBeenCalled();
        expect(nango.clearCheckpoint).not.toHaveBeenCalled();
    });

    it('closes delete tracking and clears the checkpoint only after all boards succeed', async () => {
        const nango = createNango();
        routeResponses(nango, {
            boards: boardPage([{ id: 101 }, { id: 202 }]),
            'board:101:startAt:0': sprintPage([{ id: 1001 }]),
            'board:202:startAt:0': sprintPage([{ id: 2001 }]),
        });

        await sprintSync.exec?.(nango as any);

        expect(nango.trackDeletesEnd).toHaveBeenCalledWith('JiraSprint');
        expect(nango.clearCheckpoint).toHaveBeenCalledTimes(1);
        const finalBoardCheckpointOrder = nango.saveCheckpoint.mock.invocationCallOrder.at(-1);
        expect(finalBoardCheckpointOrder).toBeLessThan(nango.trackDeletesEnd.mock.invocationCallOrder[0]);
        expect(nango.trackDeletesEnd.mock.invocationCallOrder[0]).toBeLessThan(
            nango.clearCheckpoint.mock.invocationCallOrder[0],
        );
    });
});
