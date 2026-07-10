// Tests for the Jira and Confluence forward-webhook handlers
// (`packages/web/lib/integrations/nango-webhook-router.ts:handleJiraForward`
// and `handleConfluenceForward`). The mock surface mirrors
// `nango-webhook-router-notion-forward.test.ts` so the router's other branches
// stay no-ops while we exercise just the two new paths.
//
// We assert against `writeBatchToRelayfile` because that is the deepest entry
// the handlers cross — it is the same record-writer hand-off the sync worker
// uses, so verifying `(records[0], job.model, job.provider)` confirms the
// payload would land at the correct VFS path under the real adapter
// path-mapper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_WORKSPACE_ID = "44444444-4444-4444-8444-444444444444";
const TEST_JIRA_CONNECTION_ID = "conn-jira-001";
const TEST_CONFLUENCE_CONNECTION_ID = "conn-confluence-001";

const {
  bootstrapRegistryFromEnvMock,
  createGitHubRelayfileClientMock,
  fanoutExceptMock,
  fanoutMock,
  findSlackIntegrationByConnectionIdMock,
  findSlackIntegrationByTeamIdMock,
  findWorkspaceIntegrationByConnectionMock,
  findWorkspaceIntegrationByInstallationMock,
  getNangoHostMock,
  getNangoSecretKeyMock,
  getProviderConfigKeyMock,
  getSlackConnectionIdentityMock,
  ingestWebhookMock,
  listMock,
  loggerDebugMock,
  loggerErrorMock,
  loggerInfoMock,
  loggerWarnMock,
  nangoConstructorMock,
  nangoProxyMock,
  registerMock,
  relayfileConstructorMock,
  relayfileReadFileMock,
  relayfileWriteFileMock,
  relayfileDeleteFileMock,
  writeBatchToRelayfileMock,
} = vi.hoisted(() => ({
  bootstrapRegistryFromEnvMock: vi.fn(),
  createGitHubRelayfileClientMock: vi.fn(),
  fanoutExceptMock: vi.fn(),
  fanoutMock: vi.fn(),
  findSlackIntegrationByConnectionIdMock: vi.fn(),
  findSlackIntegrationByTeamIdMock: vi.fn(),
  findWorkspaceIntegrationByConnectionMock: vi.fn(),
  findWorkspaceIntegrationByInstallationMock: vi.fn(),
  getNangoHostMock: vi.fn(),
  getNangoSecretKeyMock: vi.fn(),
  getProviderConfigKeyMock: vi.fn(),
  getSlackConnectionIdentityMock: vi.fn(),
  ingestWebhookMock: vi.fn(),
  listMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  nangoConstructorMock: vi.fn(),
  nangoProxyMock: vi.fn(),
  registerMock: vi.fn(),
  relayfileConstructorMock: vi.fn(),
  relayfileReadFileMock: vi.fn(),
  relayfileWriteFileMock: vi.fn(),
  relayfileDeleteFileMock: vi.fn(),
  writeBatchToRelayfileMock: vi.fn(),
}));

type NangoWebhookEnvelope = {
  from: string;
  type: string;
  providerConfigKey: string;
  connectionId: string | null;
  payload: unknown;
};

type RouterModule = {
  routeForwardEvent: (envelope: NangoWebhookEnvelope) => Promise<void>;
};

function okFanoutResult() {
  return { total: 1, succeeded: ["consumer"], failed: [], skipped: [] };
}

function resetMockDefaults(): void {
  vi.clearAllMocks();

  fanoutMock.mockResolvedValue(okFanoutResult());
  fanoutExceptMock.mockResolvedValue(okFanoutResult());
  listMock.mockReturnValue([{ id: "mock-consumer" }]);
  bootstrapRegistryFromEnvMock.mockReturnValue({
    fanout: fanoutMock,
    fanoutExcept: fanoutExceptMock,
    list: listMock,
    register: registerMock,
  });

  findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
  findSlackIntegrationByConnectionIdMock.mockResolvedValue(null);
  findSlackIntegrationByTeamIdMock.mockResolvedValue(null);
  findWorkspaceIntegrationByInstallationMock.mockResolvedValue(null);
  getSlackConnectionIdentityMock.mockResolvedValue(null);

  relayfileReadFileMock.mockResolvedValue(null);
  relayfileWriteFileMock.mockResolvedValue({ status: "ok" });
  relayfileDeleteFileMock.mockResolvedValue({ status: "ok" });
  createGitHubRelayfileClientMock.mockReturnValue({
    ingestWebhook: ingestWebhookMock,
    readFile: relayfileReadFileMock,
    writeFile: relayfileWriteFileMock,
    deleteFile: relayfileDeleteFileMock,
  });
  ingestWebhookMock.mockResolvedValue({ status: "queued" });

  getNangoHostMock.mockReturnValue("https://api.nango.dev");
  getNangoSecretKeyMock.mockReturnValue("test-secret");
  getProviderConfigKeyMock.mockImplementation(
    (provider: string) => `${provider}-relay`,
  );

  nangoConstructorMock.mockImplementation(function Nango() {
    return { proxy: nangoProxyMock };
  });
  relayfileConstructorMock.mockImplementation(function RelayFileClient() {
    return { ingestWebhook: ingestWebhookMock };
  });

  writeBatchToRelayfileMock.mockResolvedValue({
    written: 1,
    deleted: 0,
    errors: 0,
  });

  loggerDebugMock.mockResolvedValue(undefined);
  loggerErrorMock.mockResolvedValue(undefined);
  loggerInfoMock.mockResolvedValue(undefined);
  loggerWarnMock.mockResolvedValue(undefined);
}

function installCommonMocks(): void {
  vi.doMock("@cloud/core/provider-readiness.js", () => ({
    markProviderInitialSyncComplete: vi.fn().mockResolvedValue(undefined),
    markProviderInitialSyncFailed: vi.fn().mockResolvedValue(undefined),
    markProviderInitialSyncQueued: vi.fn().mockResolvedValue(undefined),
    markProviderOAuthConnected: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("@nangohq/node", () => ({
    Nango: nangoConstructorMock,
  }));

  vi.doMock("@relayfile/sdk", () => ({
    RelayFileClient: relayfileConstructorMock,
  }));

  vi.doMock("@/lib/integrations/nango-sync-queue", () => ({
    enqueueNangoSyncJob: vi.fn().mockResolvedValue(undefined),
  }));

  vi.doMock("@/lib/integrations/workspace-integrations", () => ({
    deleteWorkspaceIntegration: vi.fn(),
    findSlackIntegrationByConnectionId: findSlackIntegrationByConnectionIdMock,
    findSlackIntegrationByTeamId: findSlackIntegrationByTeamIdMock,
    findWorkspaceIntegrationByConnection: findWorkspaceIntegrationByConnectionMock,
    findWorkspaceIntegrationByInstallation: findWorkspaceIntegrationByInstallationMock,
    insertWorkspaceIntegrationIfAbsent: vi.fn(),
    upsertWorkspaceIntegration: vi.fn(),
  }));

  vi.doMock("@/lib/integrations/github-relayfile", () => ({
    enrichGitHubWatchPayload: vi.fn((data: Record<string, unknown>) => data),
    computePath: vi.fn().mockReturnValue(""),
    createGitHubRelayfileClient: createGitHubRelayfileClientMock,
    normalizeWebhook: vi.fn().mockReturnValue({}),
  }));

  vi.doMock("@relayfile/adapter-linear", () => ({
    normalizeLinearWebhook: vi.fn(),
  }));

  vi.doMock("@relayfile/adapter-notion", () => ({
    NotionAdapter: vi.fn(),
  }));

  vi.doMock("@relayfile/adapter-github/path-mapper", () => ({
    computeGitHubPath: vi.fn(),
    normalizeNangoGitHubModel: vi.fn(),
  }));

  vi.doMock("@relayfile/adapter-linear/path-mapper", () => ({
    computeLinearPath: vi.fn(),
  }));

  vi.doMock("@relayfile/adapter-slack/path-mapper", () => ({
    computeSlackPath: vi.fn(),
    createSlackMessageObjectId: vi.fn(),
    createSlackThreadObjectId: vi.fn(),
    createSlackThreadReplyObjectId: vi.fn(),
  }));

  vi.doMock("@cloud/core/sync/linear-semantics.js", () => ({
    buildLinearSyncSemantics: vi.fn(),
  }));

  vi.doMock("@cloud/core/sync/record-writer.js", () => ({
    writeBatchToRelayfile: writeBatchToRelayfileMock,
    buildDeletionRecord: (id: string): Record<string, unknown> => ({
      id,
      _nango_metadata: {
        last_action: "deleted",
        deleted_at: new Date().toISOString(),
      },
    }),
    createWebhookSyncJob: (input: {
      workspaceId: string;
      connectionId: string;
      providerConfigKey: string;
      provider: string;
      syncName: string;
      model: string;
    }) => ({
      type: "nango_sync" as const,
      provider: input.provider,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey,
      syncName: input.syncName,
      model: input.model,
      modifiedAfter: "",
      cursor: null,
      workspaceId: input.workspaceId,
    }),
  }));

  vi.doMock("@/lib/integrations/nango-service", () => ({
    getNangoConnectionDetails: vi.fn().mockResolvedValue(null),
    getNangoHost: getNangoHostMock,
    getNangoSecretKey: getNangoSecretKeyMock,
    getProviderConfigKey: getProviderConfigKeyMock,
    triggerNangoSyncs: vi.fn(),
    upsertNangoComposioBridgeConnection: vi.fn(),
  }));

  vi.doMock("@/lib/logger", () => ({
    logger: {
      debug: loggerDebugMock,
      error: loggerErrorMock,
      info: loggerInfoMock,
      notice: vi.fn().mockResolvedValue(undefined),
      warn: loggerWarnMock,
    },
  }));

  vi.doMock("@/lib/integrations/nango-slack", () => ({
    getSlackConnectionIdentity: getSlackConnectionIdentityMock,
  }));

  vi.doMock("@/lib/integrations/slack-identity", () => ({
    extractSlackConnectionIdentityFromForwardPayload: vi
      .fn()
      .mockReturnValue({}),
    hasSlackConnectionIdentity: vi.fn().mockReturnValue(false),
    mergeSlackConnectionIdentity: vi.fn().mockReturnValue({}),
    mergeSlackConnectionIdentityMetadata: vi.fn().mockReturnValue({}),
  }));

  vi.doMock("@/lib/env", () => ({
    optionalEnv: vi.fn().mockReturnValue(undefined),
  }));

  vi.doMock("@cloud/core/workspace/id.js", () => ({
    isValidWorkspaceIdAny: vi.fn().mockReturnValue(false),
  }));

  vi.doMock("@relayfile/provider-nango", () => ({
    fetchNangoRecords: vi.fn(),
    recordNotionIngest: vi.fn(),
    NotionIngestHandler: {
      handleNotionBulkIngest: vi.fn(),
      handleNotionSyncNotification: vi.fn(),
    },
    NotionSupportedModelSchema: { safeParse: () => ({ success: false }) },
  }));

  vi.doMock("@/lib/integrations/webhook-consumer-registry", () => ({
    bootstrapRegistryFromEnv: bootstrapRegistryFromEnvMock,
  }));

  vi.doMock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
    dispatchIntegrationWatchEvent: vi.fn().mockResolvedValue({
      delivered: 0,
      failed: 0,
      matched: 0,
    }),
  }));
}

async function loadRouter(): Promise<RouterModule> {
  vi.resetModules();
  installCommonMocks();
  return (await import(
    new URL(
      "../packages/web/lib/integrations/nango-webhook-router.ts",
      import.meta.url,
    ).href
  )) as RouterModule;
}

function jiraEnvelope(payload: Record<string, unknown>): NangoWebhookEnvelope {
  return {
    from: "jira-relay",
    type: "forward",
    providerConfigKey: "jira-relay",
    connectionId: TEST_JIRA_CONNECTION_ID,
    payload,
  };
}

function confluenceEnvelope(
  payload: Record<string, unknown>,
): NangoWebhookEnvelope {
  return {
    from: "confluence-relay",
    type: "forward",
    providerConfigKey: "confluence-relay",
    connectionId: TEST_CONFLUENCE_CONNECTION_ID,
    payload,
  };
}

beforeEach(() => {
  resetMockDefaults();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("handleJiraForward", () => {
  it("issue_updated dispatches a JiraIssue write through writeBatchToRelayfile", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "jira",
      connectionId: TEST_JIRA_CONNECTION_ID,
      providerConfigKey: "jira-relay",
      installationId: null,
      metadata: {},
    });

    const issue = {
      id: "10001",
      key: "REL-1",
      self: "https://example.atlassian.net/rest/api/3/issue/10001",
      fields: { summary: "Wire jira forward webhook" },
    };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      jiraEnvelope({
        webhookEvent: "jira:issue_updated",
        issue_event_type_name: "issue_generic",
        issue,
      }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];
    expect(records).toEqual([issue]);
    expect(job).toMatchObject({
      provider: "jira",
      model: "JiraIssue",
      syncName: "fetch-issues",
      workspaceId: TEST_WORKSPACE_ID,
      connectionId: TEST_JIRA_CONNECTION_ID,
      providerConfigKey: "jira-relay",
    });
  });

  it("project_created routes to the JiraProject model and fetch-projects sync", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "jira",
      connectionId: TEST_JIRA_CONNECTION_ID,
      providerConfigKey: "jira-relay",
      installationId: null,
      metadata: {},
    });

    const project = { id: "p-1", key: "REL", name: "Relayfile" };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      jiraEnvelope({
        webhookEvent: "project_created",
        project,
      }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];
    expect(records).toEqual([project]);
    expect(job).toMatchObject({
      provider: "jira",
      model: "JiraProject",
      syncName: "fetch-projects",
    });
  });

  it("issue_deleted writes a synthetic _nango_metadata deletion record", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "jira",
      connectionId: TEST_JIRA_CONNECTION_ID,
      providerConfigKey: "jira-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      jiraEnvelope({
        webhookEvent: "jira:issue_deleted",
        issue: { id: "10042", key: "REL-42" },
      }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];
    const record = records?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({ id: "10042" });
    expect(
      (record["_nango_metadata"] as Record<string, unknown>)["last_action"],
    ).toBe("deleted");
    expect(job).toMatchObject({ model: "JiraIssue" });
  });

  it("skips non-resource Jira events whose names contain deleted", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "jira",
      connectionId: TEST_JIRA_CONNECTION_ID,
      providerConfigKey: "jira-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      jiraEnvelope({
        webhookEvent: "issuelink_deleted",
        issue: { id: "10001", key: "REL-1" },
      }),
    );

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Jira forward webhook skipped — unsupported event shape",
      expect.objectContaining({ webhookEvent: "issuelink_deleted" }),
    );
  });

  it("warns and skips when no workspace integration matches the connection", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce(null);

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      jiraEnvelope({
        webhookEvent: "jira:issue_updated",
        issue: { id: "10001", key: "REL-1" },
      }),
    );

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Jira forward webhook received with no matching workspace integration",
      expect.objectContaining({ connectionId: TEST_JIRA_CONNECTION_ID }),
    );
  });

  it("logs info and skips when the event shape is not recognized", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "jira",
      connectionId: TEST_JIRA_CONNECTION_ID,
      providerConfigKey: "jira-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(jiraEnvelope({ webhookEvent: "board_updated" }));

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Jira forward webhook skipped — unsupported event shape",
      expect.objectContaining({ webhookEvent: "board_updated" }),
    );
  });
});

describe("handleConfluenceForward", () => {
  it("page_created dispatches a ConfluencePage write through writeBatchToRelayfile", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "confluence",
      connectionId: TEST_CONFLUENCE_CONNECTION_ID,
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    });

    const page = { id: "5001", title: "Hello", spaceId: "S1", status: "current" };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      confluenceEnvelope({
        event: "page_created",
        page,
      }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];
    expect(records).toEqual([
      expect.objectContaining({
        ...page,
        _webhook: expect.objectContaining({
          action: "created",
          eventType: "page_created",
        }),
      }),
    ]);
    expect(job).toMatchObject({
      provider: "confluence",
      model: "ConfluencePage",
      syncName: "fetch-pages",
      workspaceId: TEST_WORKSPACE_ID,
    });
  });

  it("space_created routes to the ConfluenceSpace model and fetch-spaces sync", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "confluence",
      connectionId: TEST_CONFLUENCE_CONNECTION_ID,
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    });

    const space = { id: "1", key: "REL", name: "Relayfile" };

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      confluenceEnvelope({ event: "space_created", space }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];
    expect(records).toEqual([space]);
    expect(job).toMatchObject({
      provider: "confluence",
      model: "ConfluenceSpace",
      syncName: "fetch-spaces",
    });
  });

  it("page_removed writes a synthetic _nango_metadata deletion record", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "confluence",
      connectionId: TEST_CONFLUENCE_CONNECTION_ID,
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      confluenceEnvelope({
        event: "page_removed",
        page: { id: "5099" },
      }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const [, records, job] = writeBatchToRelayfileMock.mock.calls[0] ?? [];
    const record = records?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({ id: "5099" });
    expect(
      (record["_nango_metadata"] as Record<string, unknown>)["last_action"],
    ).toBe("deleted");
    expect(job).toMatchObject({ model: "ConfluencePage" });
  });

  it("skips non-resource Confluence events whose names contain removed", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "confluence",
      connectionId: TEST_CONFLUENCE_CONNECTION_ID,
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      confluenceEnvelope({
        event: "content_permission_removed",
        content: { id: "5099" },
      }),
    );

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Confluence forward webhook skipped — unsupported event shape",
      expect.objectContaining({ event: "content_permission_removed" }),
    );
  });

  it("warns and skips when no workspace integration matches the connection", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce(null);

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      confluenceEnvelope({
        event: "page_created",
        page: { id: "5001" },
      }),
    );

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Confluence forward webhook received with no matching workspace integration",
      expect.objectContaining({ connectionId: TEST_CONFLUENCE_CONNECTION_ID }),
    );
  });

  it("logs info and skips when the event shape is not recognized", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "confluence",
      connectionId: TEST_CONFLUENCE_CONNECTION_ID,
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      confluenceEnvelope({ event: "label_added" }),
    );

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Confluence forward webhook skipped — unsupported event shape",
      expect.objectContaining({ event: "label_added" }),
    );
  });
});
