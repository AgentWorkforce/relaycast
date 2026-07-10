import { afterEach, vi, expect, it, describe } from 'vitest';

import createSync from '../syncs/fetch-issues.js';

describe('jira-relay fetch-issues tests', () => {
  const models = 'JiraIssue'.split(',');

  const createTestContext = () => {
    const nangoMock = new global.vitest.NangoSyncMock({
      dirname: __dirname,
      name: "fetch-issues",
      Model: "JiraIssue"
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

  it('deletes sparse issue webhook payloads without requiring full issue fields', async () => {
    const { nangoMock } = createTestContext();
    const batchDeleteSpy = vi.spyOn(nangoMock, 'batchDelete');

    await createSync.onWebhook(nangoMock, {
      webhookEvent: 'jira:issue_deleted',
      issue: { id: '10001' },
    });

    expect(batchDeleteSpy).toHaveBeenCalledWith([{ id: '10001' }], 'JiraIssue');
  });

  describe('multi-tenant accessible-resources handling', () => {
    const buildBareMock = () => {
      const nangoMock = new global.vitest.NangoSyncMock({
        dirname: __dirname,
        name: 'fetch-issues',
        Model: 'JiraIssue',
      });
      // Drop the fixture-backed metadata/connection so the resolver falls through
      // to oauth/token/accessible-resources, which we control via the `get` mock.
      nangoMock.getMetadata.mockReset();
      nangoMock.getMetadata.mockResolvedValue({});
      nangoMock.getConnection.mockReset();
      nangoMock.getConnection.mockResolvedValue({ connection_config: {} });
      nangoMock.getCheckpoint.mockReset();
      nangoMock.getCheckpoint.mockResolvedValue(undefined);
      nangoMock.updateMetadata.mockReset();
      nangoMock.updateMetadata.mockResolvedValue(undefined);
      nangoMock.trackDeletesStart.mockReset();
      nangoMock.trackDeletesStart.mockResolvedValue(undefined);
      nangoMock.trackDeletesEnd.mockReset();
      nangoMock.trackDeletesEnd.mockResolvedValue(undefined);
      nangoMock.saveCheckpoint.mockReset();
      nangoMock.saveCheckpoint.mockResolvedValue(undefined);
      nangoMock.clearCheckpoint.mockReset();
      nangoMock.clearCheckpoint.mockResolvedValue(undefined);
      nangoMock.batchSave.mockReset();
      nangoMock.batchSave.mockResolvedValue(undefined);
      return nangoMock;
    };
    const captureSyncError = async (nangoMock: ReturnType<typeof buildBareMock>) => {
      const error = await createSync.exec(nangoMock).catch((cause: Error) => cause);
      expect(error).toBeInstanceOf(Error);
      return error as Error;
    };
    const emptySearchResponse = { data: { issues: [], nextPageToken: '' } };

    it('refuses to auto-pick when Atlassian returns multiple sites and no cloudId hint exists', async () => {
      const nangoMock = buildBareMock();
      nangoMock.get.mockReset();
      nangoMock.get.mockImplementation(async (config: { endpoint: string }) => {
        if (config.endpoint === 'oauth/token/accessible-resources') {
          return {
            data: [
              { id: 'cloud-aaa', url: 'https://tenant-a.atlassian.net' },
              { id: 'cloud-bbb', url: 'https://tenant-b.atlassian.net' },
            ],
          };
        }
        throw new Error(`unexpected endpoint: ${config.endpoint}`);
      });

      const error = await captureSyncError(nangoMock);
      expect(error.message).toMatch(/Multiple accessible Jira sites/);
      expect(error.message).toMatch(/cloud-aaa/);
      expect(error.message).toMatch(/cloud-bbb/);
      expect(nangoMock.batchSave).not.toHaveBeenCalled();
    });

    it('errors with the available site list when a configured cloudId does not match', async () => {
      const nangoMock = buildBareMock();
      nangoMock.getMetadata.mockResolvedValue({ cloudId: 'stale-cloud-id' });
      nangoMock.get.mockReset();
      nangoMock.get.mockImplementation(async (config: { endpoint: string }) => {
        if (config.endpoint === 'oauth/token/accessible-resources') {
          return {
            data: [
              { id: 'cloud-aaa', url: 'https://tenant-a.atlassian.net' },
              { id: 'cloud-bbb', url: 'https://tenant-b.atlassian.net' },
            ],
          };
        }
        throw new Error(`unexpected endpoint: ${config.endpoint}`);
      });

      const error = await captureSyncError(nangoMock);
      expect(error.message).toMatch(/does not match any accessible Atlassian site/);
      expect(error.message).toMatch(/stale-cloud-id/);
    });

    it('errors clearly when Atlassian returns no accessible resources', async () => {
      const nangoMock = buildBareMock();
      nangoMock.get.mockReset();
      nangoMock.get.mockImplementation(async (config: { endpoint: string }) => {
        if (config.endpoint === 'oauth/token/accessible-resources') {
          return { data: [] };
        }
        throw new Error(`unexpected endpoint: ${config.endpoint}`);
      });

      const error = await captureSyncError(nangoMock);
      expect(error.message).toMatch(/No accessible Jira resource/);
      expect(error.message).toMatch(/Re-authorize the Nango Jira connection/);
      expect(nangoMock.updateMetadata).not.toHaveBeenCalled();
      expect(nangoMock.batchSave).not.toHaveBeenCalled();
    });

    it('errors clearly when the selected site has no base URL', async () => {
      const nangoMock = buildBareMock();
      nangoMock.get.mockReset();
      nangoMock.get.mockImplementation(async (config: { endpoint: string }) => {
        if (config.endpoint === 'oauth/token/accessible-resources') {
          return { data: [{ id: 'cloud-no-url' }] };
        }
        throw new Error(`unexpected endpoint: ${config.endpoint}`);
      });

      const error = await captureSyncError(nangoMock);
      expect(error.message).toMatch(/has no base URL/);
      expect(error.message).toMatch(/cloud-no-url/);
      expect(nangoMock.updateMetadata).not.toHaveBeenCalled();
    });

    it('auto-selects the only accessible site and persists it to metadata', async () => {
      const nangoMock = buildBareMock();
      nangoMock.get.mockReset();
      nangoMock.get.mockImplementation(async (config: { endpoint: string }) => {
        if (config.endpoint === 'oauth/token/accessible-resources') {
          return {
            data: [{ id: 'cloud-only', url: 'https://only.atlassian.net' }],
          };
        }
        if (config.endpoint === '/ex/jira/cloud-only/rest/api/3/search/jql') {
          // Empty search result so the sync completes after the site is resolved.
          return emptySearchResponse;
        }
        throw new Error(`unexpected endpoint: ${config.endpoint}`);
      });

      await createSync.exec(nangoMock);

      expect(nangoMock.get).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: '/ex/jira/cloud-only/rest/api/3/search/jql',
          params: expect.objectContaining({
            fields: expect.stringContaining('assignee'),
          }),
        }),
      );
      expect(nangoMock.updateMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ cloudId: 'cloud-only', baseUrl: 'https://only.atlassian.net' }),
      );
    });
  });
});
