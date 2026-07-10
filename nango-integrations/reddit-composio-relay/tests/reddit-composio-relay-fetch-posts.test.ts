import { afterEach, vi, expect, it, describe } from 'vitest';

import createSync from '../syncs/fetch-posts.js';

describe('reddit-composio-relay fetch-posts tests', () => {
  const models = 'RedditPost'.split(',');

  const createTestContext = () => {
    const nangoMock = new global.vitest.NangoSyncMock({
      dirname: __dirname,
      name: "fetch-posts",
      Model: "RedditPost"
    });
    (nangoMock as any).getEnvironmentVariables = vi.fn().mockResolvedValue([
      { name: "COMPOSIO_API_KEY", value: "ak_PraPJWT7LkffEYifPSRj" },
    ]);
    (nangoMock as any).getConnection = vi.fn().mockResolvedValue({
      connection_id: "ca_ZeoDRmViRoFu",
      tags: {
        end_user_id: "rw_ec3c51c0",
        workspaceid: "rw_ec3c51c0",
        composio_connected_account_id: "ca_ZeoDRmViRoFu",
      },
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

      const spiedData = batchSaveSpy.mock.calls.flatMap((call) => {
        if (Array.isArray(call[0])) {
          return call[0];
        }
        if (Array.isArray(call[1])) {
          return call[1];
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
        const spiedData = batchDeleteSpy.mock.calls.flatMap((call) => {
          if (Array.isArray(call[0])) {
            return call[0];
          }
          if (Array.isArray(call[1])) {
            return call[1];
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
});
