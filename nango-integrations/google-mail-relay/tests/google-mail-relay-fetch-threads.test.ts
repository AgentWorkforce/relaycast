import { afterEach, vi, expect, it, describe } from 'vitest';

import createSync from '../syncs/fetch-threads.js';

describe('google-mail-relay fetch-threads tests', () => {
  const models = 'GoogleMailThread'.split(',');

  const createTestContext = () => {
    const nangoMock = new global.vitest.NangoSyncMock({
      dirname: __dirname,
      name: "fetch-threads",
      Model: "GoogleMailThread"
    });

    return {
      nangoMock,
      batchSaveSpy: vi.spyOn(nangoMock, 'batchSave')
    };
  };

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it('should get, map correctly the data and batchSave the result', async () => {
    const { nangoMock, batchSaveSpy } = createTestContext();

    await createSync.exec(nangoMock);

    for (const model of models) {
      const expectedBatchSaveData = await nangoMock.getBatchSaveData(model);

      const spiedData = batchSaveSpy.mock.calls.flatMap(call => {
        if (call[1] === model) {
          return call[0];
        }

        return [];
      });

      // Normalize spy-captured args into plain JSON so they compare cleanly
      // with fixture data loaded from `*.test.json`. 
      // Removes things like prototypes, undefined values and other non-serializable data.
      const spied = JSON.parse(JSON.stringify(spiedData));

      expect(spied).toStrictEqual(expectedBatchSaveData);
    }
  });

  it('should get, map correctly the data and batchDelete the result', async () => {
    const { nangoMock } = createTestContext();
    const batchDeleteSpy = vi.spyOn(nangoMock, 'batchDelete');

    await createSync.exec(nangoMock);

    for (const model of models) {
      const batchDeleteData = await nangoMock.getBatchDeleteData(model);
      if (batchDeleteData && batchDeleteData.length > 0) {
        const spiedData = batchDeleteSpy.mock.calls.flatMap(call => {
          if (call[1] === model) {
            return call[0];
          }

          return [];
        });

        // Normalize spy-captured args into plain JSON so they compare cleanly
        // with fixture data loaded from `*.test.json`.
        // Removes things like prototypes, undefined values and other non-serializable data.
        const spied = JSON.parse(JSON.stringify(spiedData));

        expect(spied).toStrictEqual(batchDeleteData);
      }
    }
  });

  it('processes webhook history deltas during active backfill without clobbering the backfill checkpoint', async () => {
    const calls: string[] = [];
    const saved: unknown[] = [];
    const nangoMock = {
      getCheckpoint: vi.fn(async () => ({
        phase: 'backfill',
        page_token: 'backfill-page-2',
        backfill_history_id: '100'
      })),
      get: vi.fn(async ({ endpoint, params }: { endpoint: string; params?: Record<string, unknown> }) => {
        calls.push(`${endpoint}:${JSON.stringify(params ?? {})}`);
        if (endpoint === '/gmail/v1/users/me/history') {
          expect(params).toMatchObject({ startHistoryId: '100' });
          return {
            data: {
              history: [{ id: 'h-105', messagesAdded: [{ message: { id: 'm-new', threadId: 't-new' } }] }],
              historyId: '105'
            }
          };
        }
        if (endpoint === '/gmail/v1/users/me/threads/t-new') {
          return {
            data: {
              id: 't-new',
              historyId: '105',
              messages: [
                {
                  id: 'm-new',
                  threadId: 't-new',
                  historyId: '105'
                }
              ]
            }
          };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      }),
      batchSave: vi.fn(async (records: unknown[]) => {
        saved.push(...records);
      }),
      batchDelete: vi.fn(),
      saveCheckpoint: vi.fn(),
      log: vi.fn()
    };

    await createSync.onWebhook?.(nangoMock as never, pubsubPayload('105'));

    expect(saved).toStrictEqual([
      {
        id: 't-new',
        historyId: '105',
        messageIds: ['m-new'],
        messageCount: 1,
        messages: [
          {
            id: 'm-new',
            threadId: 't-new',
            historyId: '105'
          }
        ]
      }
    ]);
    expect(nangoMock.saveCheckpoint).toHaveBeenCalledWith({
      phase: 'backfill',
      history_id: '105',
      page_token: 'backfill-page-2',
      backfill_history_id: '100'
    });
    expect(calls.some((call) => call.startsWith('/gmail/v1/users/me/threads:'))).toBe(false);
  });

  it('does not fail webhook processing when checkpoint save conflicts during active backfill', async () => {
    const saveConflictError = new Error('Error saving checkpoint');
    (saveConflictError as Error & { payload?: unknown }).payload = {
      error: {
        code: 'checkpoint_conflict',
        message: 'Checkpoint has been updated since last read'
      }
    };

    const nangoMock = {
      getCheckpoint: vi.fn(async () => ({
        phase: 'backfill',
        page_token: 'backfill-page-2',
        backfill_history_id: '100'
      })),
      get: vi.fn(async ({ endpoint }: { endpoint: string; params?: Record<string, unknown> }) => {
        if (endpoint === '/gmail/v1/users/me/history') {
          return {
            data: {
              history: [{ id: 'h-105', messagesAdded: [{ message: { id: 'm-new', threadId: 't-new' } }] }],
              historyId: '105'
            }
          };
        }
        if (endpoint === '/gmail/v1/users/me/threads/t-new') {
          return {
            data: {
              id: 't-new',
              historyId: '105',
              messages: [{ id: 'm-new', threadId: 't-new', historyId: '105' }]
            }
          };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      }),
      batchSave: vi.fn(),
      batchDelete: vi.fn(),
      saveCheckpoint: vi.fn(async () => {
        throw saveConflictError;
      }),
      log: vi.fn()
    };

    await expect(createSync.onWebhook?.(nangoMock as never, pubsubPayload('105'))).resolves.toBeUndefined();
    expect(nangoMock.batchSave).toHaveBeenCalled();
    expect(nangoMock.log).toHaveBeenCalledWith(expect.stringContaining('skipped checkpoint save'));
  });

  it('processes pending history deltas before continuing an exec-time active backfill', async () => {
    const calls: string[] = [];
    const saved: unknown[] = [];
    const nangoMock = {
      getCheckpoint: vi.fn(async () => ({
        phase: 'backfill',
        page_token: 'backfill-page-2',
        backfill_history_id: '100'
      })),
      get: vi.fn(async ({ endpoint, params }: { endpoint: string; params?: Record<string, unknown> }) => {
        calls.push(`${endpoint}:${JSON.stringify(params ?? {})}`);
        if (endpoint === '/gmail/v1/users/me/history') {
          expect(params).toMatchObject({ startHistoryId: '100' });
          return {
            data: {
              history: [{ id: 'h-105', messagesAdded: [{ message: { id: 'm-new', threadId: 't-new' } }] }],
              historyId: '105'
            }
          };
        }
        if (endpoint === '/gmail/v1/users/me/threads/t-new') {
          return {
            data: {
              id: 't-new',
              historyId: '105',
              messages: [
                {
                  id: 'm-new',
                  threadId: 't-new',
                  historyId: '105'
                }
              ]
            }
          };
        }
        if (endpoint === '/gmail/v1/users/me/threads') {
          expect(params).toMatchObject({ pageToken: 'backfill-page-2' });
          return {
            data: {
              threads: [],
              nextPageToken: 'backfill-page-3'
            }
          };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      }),
      batchSave: vi.fn(async (records: unknown[]) => {
        saved.push(...records);
      }),
      batchDelete: vi.fn(),
      saveCheckpoint: vi.fn(),
      trackDeletesStart: vi.fn(),
      trackDeletesEnd: vi.fn(),
      log: vi.fn()
    };

    await createSync.exec(nangoMock as never);

    expect(saved).toStrictEqual([
      {
        id: 't-new',
        historyId: '105',
        messageIds: ['m-new'],
        messageCount: 1,
        messages: [
          {
            id: 'm-new',
            threadId: 't-new',
            historyId: '105'
          }
        ]
      }
    ]);
    expect(calls[0]?.startsWith('/gmail/v1/users/me/history:')).toBe(true);
    expect(calls.some((call) => call.startsWith('/gmail/v1/users/me/threads:'))).toBe(true);
    expect(nangoMock.saveCheckpoint).toHaveBeenCalledWith({
      phase: 'backfill',
      history_id: '105',
      page_token: 'backfill-page-3',
      backfill_history_id: '100'
    });
  });

  it('uses processed backfill delta history as the live checkpoint when backfill finishes', async () => {
    const nangoMock = {
      getCheckpoint: vi.fn(async () => ({
        phase: 'backfill',
        page_token: 'backfill-page-final',
        backfill_history_id: '100'
      })),
      get: vi.fn(async ({ endpoint, params }: { endpoint: string; params?: Record<string, unknown> }) => {
        if (endpoint === '/gmail/v1/users/me/history') {
          expect(params).toMatchObject({ startHistoryId: '100' });
          return {
            data: {
              history: [{ id: 'h-105', messagesAdded: [{ message: { id: 'm-new', threadId: 't-new' } }] }],
              historyId: '105'
            }
          };
        }
        if (endpoint === '/gmail/v1/users/me/threads/t-new') {
          return {
            data: {
              id: 't-new',
              historyId: '105',
              messages: [
                {
                  id: 'm-new',
                  threadId: 't-new',
                  historyId: '105'
                }
              ]
            }
          };
        }
        if (endpoint === '/gmail/v1/users/me/threads') {
          expect(params).toMatchObject({ pageToken: 'backfill-page-final' });
          return { data: { threads: [] } };
        }
        throw new Error(`unexpected endpoint ${endpoint}`);
      }),
      batchSave: vi.fn(),
      batchDelete: vi.fn(),
      saveCheckpoint: vi.fn(),
      trackDeletesStart: vi.fn(),
      trackDeletesEnd: vi.fn(),
      log: vi.fn()
    };

    await createSync.exec(nangoMock as never);

    expect(nangoMock.saveCheckpoint).toHaveBeenCalledWith({
      phase: 'history',
      history_id: '105',
      page_token: '',
      backfill_history_id: ''
    });
  });
});

function pubsubPayload(historyId: string) {
  return {
    payload: {
      message: {
        data: Buffer.from(JSON.stringify({ historyId }), 'utf8').toString('base64')
      }
    }
  };
}
