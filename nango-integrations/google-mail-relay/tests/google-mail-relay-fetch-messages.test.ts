import { afterEach, vi, expect, it, describe } from 'vitest';

import createSync from '../syncs/fetch-messages.js';

describe('google-mail-relay fetch-messages tests', () => {
  const models = 'GoogleMailMessage'.split(',');

  const createTestContext = () => {
    const nangoMock = new global.vitest.NangoSyncMock({
      dirname: __dirname,
      name: "fetch-messages",
      Model: "GoogleMailMessage"
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

  it('limits backfill queries to trailing 30 days by default', async () => {
    const nangoMock = {
      getCheckpoint: vi.fn(async () => ({ phase: 'backfill' })),
      getMetadata: vi.fn(async () => ({})),
      get: vi.fn(async ({ endpoint, params }: { endpoint: string; params?: Record<string, unknown> }) => {
        if (endpoint === '/gmail/v1/users/me/profile') {
          return { data: { historyId: '300' } };
        }
        if (endpoint === '/gmail/v1/users/me/messages') {
          expect(params).toMatchObject({ q: 'newer_than:30d' });
          return { data: { messages: [] } };
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
      history_id: '300',
      page_token: '',
      backfill_history_id: ''
    });
  });

  it('uses metadata override for backfill lookback days', async () => {
    const nangoMock = {
      getCheckpoint: vi.fn(async () => ({ phase: 'backfill' })),
      getMetadata: vi.fn(async () => ({ gmailMessageLookbackDays: 7 })),
      get: vi.fn(async ({ endpoint, params }: { endpoint: string; params?: Record<string, unknown> }) => {
        if (endpoint === '/gmail/v1/users/me/profile') {
          return { data: { historyId: '301' } };
        }
        if (endpoint === '/gmail/v1/users/me/messages') {
          expect(params).toMatchObject({ q: 'newer_than:7d' });
          return { data: { messages: [] } };
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
      history_id: '301',
      page_token: '',
      backfill_history_id: ''
    });
  });
});
