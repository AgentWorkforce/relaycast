import { afterEach, vi, expect, it, describe } from 'vitest';

import createSync from '../syncs/fetch-projects.js';

describe('jira-relay fetch-projects tests', () => {
  const models = 'JiraProject'.split(',');

  const createTestContext = () => {
    const nangoMock = new global.vitest.NangoSyncMock({
      dirname: __dirname,
      name: "fetch-projects",
      Model: "JiraProject"
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

  it('deletes sparse project webhook payloads without requiring name or key', async () => {
    const { nangoMock, batchSaveSpy } = createTestContext();
    const batchDeleteSpy = vi.spyOn(nangoMock, 'batchDelete');

    await createSync.onWebhook(nangoMock, {
      webhookEvent: 'project_deleted',
      project: { id: '10011' },
    });

    expect(batchDeleteSpy).toHaveBeenCalledTimes(1);
    expect(batchDeleteSpy).toHaveBeenCalledWith([{ id: '10011' }], 'JiraProject');
    expect(batchSaveSpy).not.toHaveBeenCalled();
  });
});
