// Tests for the Notion forward-webhook handler
// (`packages/web/lib/integrations/nango-webhook-router.ts:handleNotionForward`).
//
// Mirrors the mock surface in `nango-webhook-router-fanout.test.ts` so the
// router's other branches stay no-ops while we exercise just the Notion path.
// We import `routeForwardEvent` (the public entry) rather than the
// non-exported `handleNotionForward` so the tests follow the same code path
// production runs through.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const TEST_PAGE_ID = "page-abc-123";
const TEST_CONNECTION_ID = "conn-notion-789";

const {
  bootstrapRegistryFromEnvMock,
  computePathMock,
  computeLinearPathMock,
  createGitHubRelayfileClientMock,
  dispatchIntegrationWatchEventMock,
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
  normalizeLinearWebhookMock,
  normalizeWebhookMock,
  registerMock,
  relayfileConstructorMock,
  relayfileReadFileMock,
  relayfileWriteFileMock,
  relayfileDeleteFileMock,
  writeBatchToRelayfileMock,
} = vi.hoisted(() => ({
  bootstrapRegistryFromEnvMock: vi.fn(),
  computePathMock: vi.fn(),
  computeLinearPathMock: vi.fn(),
  createGitHubRelayfileClientMock: vi.fn(),
  dispatchIntegrationWatchEventMock: vi.fn(),
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
  normalizeLinearWebhookMock: vi.fn(),
  normalizeWebhookMock: vi.fn(),
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
  __resetNotionForwardDedupeForTests: () => void;
  __resetHubSpotForwardDedupeForTests: () => void;
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

  // Default: unmodified existing files (read returns null so dedupe never
  // short-circuits a write). Tests opt-in to non-null returns.
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
  computePathMock.mockReturnValue("");
  computeLinearPathMock.mockReturnValue("");
  normalizeWebhookMock.mockReturnValue({});
  normalizeLinearWebhookMock.mockReturnValue({});

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

  // writeBatchToRelayfile is the deepest record-writer entry the handler
  // calls. Mocking it here lets us assert "wrote N records of model X"
  // without modeling the full path-mapping pipeline.
  writeBatchToRelayfileMock.mockResolvedValue({
    written: 1,
    deleted: 0,
    errors: 0,
  });
  dispatchIntegrationWatchEventMock.mockResolvedValue({
    delivered: 0,
    failed: 0,
    matched: 0,
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
    computePath: computePathMock,
    createGitHubRelayfileClient: createGitHubRelayfileClientMock,
    normalizeWebhook: normalizeWebhookMock,
  }));

  vi.doMock("@relayfile/adapter-linear", () => ({
    normalizeLinearWebhook: normalizeLinearWebhookMock,
  }));

  vi.doMock("@relayfile/adapter-notion", () => ({
    NotionAdapter: vi.fn(),
  }));

  vi.doMock("@relayfile/adapter-github/path-mapper", () => ({
    computeGitHubPath: vi.fn(),
    normalizeNangoGitHubModel: vi.fn(),
  }));

  vi.doMock("@relayfile/adapter-linear/path-mapper", () => ({
    computeLinearPath: computeLinearPathMock,
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
    // Spies for the three exports the handler imports. We hand-implement
    // `buildDeletionRecord` and `createWebhookSyncJob` (rather than
    // `vi.importActual`) because `vi.importActual` would also pull in the
    // real `record-writer.js`'s adapter imports and we mock those above.
    writeBatchToRelayfile: writeBatchToRelayfileMock,
    buildDeletionRecord: (
      id: string,
      options: { deletedAt?: string } = {},
    ): Record<string, unknown> => ({
      id,
      _nango_metadata: {
        last_action: "deleted",
        deleted_at: options.deletedAt ?? new Date().toISOString(),
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
    extractSlackConnectionIdentityFromForwardPayload: vi.fn().mockReturnValue({}),
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
    dispatchIntegrationWatchEvent: dispatchIntegrationWatchEventMock,
  }));
}

async function loadRouter(): Promise<RouterModule> {
  vi.resetModules();
  installCommonMocks();
  const mod = (await import(
    new URL(
      "../packages/web/lib/integrations/nango-webhook-router.ts",
      import.meta.url,
    ).href
  )) as RouterModule;
  // Each test gets a fresh dedupe ring so redelivery state doesn't leak
  // between cases.
  mod.__resetNotionForwardDedupeForTests();
  mod.__resetHubSpotForwardDedupeForTests();
  return mod;
}

function createNotionEnvelope(input: {
  type: string;
  pageId?: string | null;
  entityType?: string;
  deliveryId?: string;
  timestamp?: string;
  data?: Record<string, unknown>;
  connectionId?: string | null;
}): NangoWebhookEnvelope {
  const payload: Record<string, unknown> = { type: input.type };
  // Default to TEST_PAGE_ID; pass `pageId: null` to omit `entity` entirely.
  const resolvedPageId = input.pageId === null ? null : input.pageId ?? TEST_PAGE_ID;
  if (resolvedPageId !== null) {
    payload["entity"] = {
      id: resolvedPageId,
      type: input.entityType ?? "page",
    };
  }
  if (input.deliveryId) payload["id"] = input.deliveryId;
  if (input.timestamp) payload["timestamp"] = input.timestamp;
  if (input.data) payload["data"] = input.data;
  return {
    from: "notion-relay",
    type: "forward",
    providerConfigKey: "notion-relay",
    connectionId: input.connectionId === undefined ? TEST_CONNECTION_ID : input.connectionId,
    payload,
  };
}

function notionApiPage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TEST_PAGE_ID,
    url: "https://www.notion.so/page-abc-123",
    last_edited_time: "2026-05-07T12:00:00.000Z",
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: "Demo page" }],
      },
    },
    parent: { type: "page_id", page_id: "parent-1" },
    archived: false,
    in_trash: false,
    ...overrides,
  };
}

beforeEach(() => {
  resetMockDefaults();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("handleNotionForward — happy path", () => {
  it("page.content_updated writes one NotionPage and one NotionPageContent record", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockImplementation(async (config: { endpoint: string }) => {
      if (config.endpoint.endsWith("/markdown")) {
        return { data: { markdown: "# Hello world" } };
      }
      return { data: notionApiPage() };
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated" }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(2);
    const calls = writeBatchToRelayfileMock.mock.calls;
    const [pageCall, contentCall] = calls;
    expect(pageCall?.[1]).toHaveLength(1);
    expect(pageCall?.[1]?.[0]).toMatchObject({
      id: TEST_PAGE_ID,
      title: "Demo page",
      url: "https://www.notion.so/page-abc-123",
      parent_type: "page",
      parent_id: "parent-1",
      last_edited_time: "2026-05-07T12:00:00.000Z",
      content_preview: "",
    });
    expect(pageCall?.[2]).toMatchObject({
      provider: "notion",
      model: "NotionPage",
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(contentCall?.[1]?.[0]).toMatchObject({
      id: TEST_PAGE_ID,
      pageId: TEST_PAGE_ID,
      content: "# Hello world",
      lastEditedTime: "2026-05-07T12:00:00.000Z",
    });
    expect(typeof (contentCall?.[1]?.[0] as { contentHash?: unknown })?.contentHash).toBe("string");
    expect(contentCall?.[2]).toMatchObject({ model: "NotionPageContent" });
  });
});

describe("handleNotionForward — body fetch null", () => {
  it("writes the metadata record but skips the content write when markdown is null", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockImplementation(async (config: { endpoint: string }) => {
      if (config.endpoint.endsWith("/markdown")) {
        return { data: { markdown: null } };
      }
      return { data: notionApiPage() };
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated" }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      model: "NotionPage",
    });
  });
});

describe("handleNotionForward — deletions", () => {
  it("page.deleted issues two deletion writes and skips Notion API fetches", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(createNotionEnvelope({ type: "page.deleted" }));

    expect(nangoProxyMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(2);
    for (const call of writeBatchToRelayfileMock.mock.calls) {
      const record = call[1]?.[0] as Record<string, unknown>;
      expect(record).toMatchObject({ id: TEST_PAGE_ID });
      expect(
        (record["_nango_metadata"] as Record<string, unknown>)["last_action"],
      ).toBe("deleted");
    }
    const models = writeBatchToRelayfileMock.mock.calls.map(
      (call) => (call[2] as { model: string }).model,
    );
    expect(models.sort()).toEqual(["NotionPage", "NotionPageContent"]);
  });

  it("page.deleted skips content deletion when the page tombstone is stale", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    writeBatchToRelayfileMock.mockResolvedValueOnce({
      written: 0,
      deleted: 0,
      errors: 0,
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(createNotionEnvelope({ type: "page.deleted" }));

    expect(nangoProxyMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      model: "NotionPage",
    });
  });

  it("archived page from Notion API preserves terminal metadata", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockResolvedValueOnce({ data: notionApiPage({ archived: true }) });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated" }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const record = writeBatchToRelayfileMock.mock.calls[0]?.[1]?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      id: TEST_PAGE_ID,
      archived: true,
      in_trash: false,
    });
    expect(record["_nango_metadata"]).toBeUndefined();
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      model: "NotionPage",
    });
    expect(nangoProxyMock).toHaveBeenCalledTimes(1);
    expect(relayfileReadFileMock).toHaveBeenCalledTimes(1);
  });

  it("in_trash page from Notion API preserves terminal metadata", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockResolvedValueOnce({ data: notionApiPage({ in_trash: true }) });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated" }),
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const record = writeBatchToRelayfileMock.mock.calls[0]?.[1]?.[0] as Record<string, unknown>;
    expect(record).toMatchObject({
      id: TEST_PAGE_ID,
      archived: false,
      in_trash: true,
    });
    expect(record["_nango_metadata"]).toBeUndefined();
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      model: "NotionPage",
    });
    expect(nangoProxyMock).toHaveBeenCalledTimes(1);
    expect(relayfileReadFileMock).toHaveBeenCalledTimes(1);
  });
});

describe("handleNotionForward — guard rails", () => {
  it("skips when connectionId is missing", async () => {
    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated", connectionId: null }),
    );

    expect(loggerWarnMock).toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
  });

  it("skips when no matching workspace integration", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce(null);

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated" }),
    );

    expect(loggerWarnMock).toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
  });

  it("skips when entity.id is missing", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated", pageId: null }),
    );

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
  });

  it("returns silently for entity.type === \"database\"", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({
        type: "database.updated",
        entityType: "database",
      }),
    );

    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
    expect(nangoProxyMock).not.toHaveBeenCalled();
  });

  it("skips when Notion page fetch returns null", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockResolvedValueOnce({ data: null });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated" }),
    );

    expect(loggerWarnMock).toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).not.toHaveBeenCalled();
  });
});

describe("handleNotionForward — webhook redelivery dedupe", () => {
  it("suppresses duplicate deliveries within the dedupe window", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockImplementation(async (config: { endpoint: string }) => {
      if (config.endpoint.endsWith("/markdown")) {
        return { data: { markdown: "# Hello" } };
      }
      return { data: notionApiPage() };
    });

    const { routeForwardEvent } = await loadRouter();
    const envelope = createNotionEnvelope({
      type: "page.content_updated",
      deliveryId: "delivery-uuid-001",
    });

    await routeForwardEvent(envelope);
    const firstWriteCount = writeBatchToRelayfileMock.mock.calls.length;
    await routeForwardEvent(envelope);

    // Second run is a no-op: write count unchanged.
    expect(writeBatchToRelayfileMock.mock.calls.length).toBe(firstWriteCount);
    // And we logged the redelivery suppression.
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Notion forward webhook redelivery suppressed",
      expect.objectContaining({ deliveryId: "delivery-uuid-001" }),
    );
  });

  it("does NOT collapse two distinct edits within window when only the envelope timestamp differentiates them", async () => {
    // Codex P2 on PR #486: when the payload lacks `id` AND
    // `data.last_edited_time`, the dedupe key must still incorporate the
    // envelope `timestamp` so two legitimate edits aren't fused into one
    // suppressed delivery.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockImplementation(async (config: { endpoint: string }) => {
      if (config.endpoint.endsWith("/markdown")) {
        return { data: { markdown: "# Hello" } };
      }
      return { data: notionApiPage() };
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({
        type: "page.content_updated",
        timestamp: "2026-05-07T12:00:00.000Z",
      }),
    );
    const firstWriteCount = writeBatchToRelayfileMock.mock.calls.length;

    await routeForwardEvent(
      createNotionEnvelope({
        type: "page.content_updated",
        timestamp: "2026-05-07T12:00:01.000Z",
      }),
    );

    // Both deliveries did real work — the timestamp difference defeats the
    // dedupe key, as required.
    expect(writeBatchToRelayfileMock.mock.calls.length).toBeGreaterThan(firstWriteCount);
  });

  it("releases the dedupe claim on ingest failure so a redelivery can retry", async () => {
    // Codex P2 on PR #486: if the durable work fails after the dedupe claim
    // is taken, the claim must be released — otherwise a Notion/Nango
    // redelivery (the standard recovery path for a 5xx) is silently
    // suppressed for the full TTL and the update is lost until the next
    // 12h sync.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockImplementation(async (config: { endpoint: string }) => {
      if (config.endpoint.endsWith("/markdown")) {
        return { data: { markdown: "# Hello" } };
      }
      return { data: notionApiPage() };
    });

    // First call throws on the metadata write.
    writeBatchToRelayfileMock
      .mockRejectedValueOnce(new Error("relayfile write failed"))
      .mockResolvedValue({ written: 1, deleted: 0, errors: 0 });

    const { routeForwardEvent } = await loadRouter();
    const envelope = createNotionEnvelope({
      type: "page.content_updated",
      deliveryId: "delivery-uuid-released",
    });

    await expect(routeForwardEvent(envelope)).rejects.toThrow(
      "relayfile write failed",
    );

    // The retry of the same delivery is NOT suppressed — claim was released.
    await routeForwardEvent(envelope);

    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      "Notion forward webhook redelivery suppressed",
      expect.anything(),
    );
    // The retry actually did writes (more calls than before the throw).
    const writes = writeBatchToRelayfileMock.mock.calls.length;
    expect(writes).toBeGreaterThanOrEqual(2);
  });

  it("skips dedupe entirely when neither id, last_edited_time, nor timestamp is present", async () => {
    // Without any unique hint we genuinely cannot tell redeliveries from new
    // edits — better to over-process (the contentHash short-circuit absorbs
    // the cost) than to drop a real update.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    nangoProxyMock.mockImplementation(async (config: { endpoint: string }) => {
      if (config.endpoint.endsWith("/markdown")) {
        return { data: { markdown: "# Hello" } };
      }
      return { data: notionApiPage() };
    });

    const { routeForwardEvent } = await loadRouter();
    const envelope = createNotionEnvelope({ type: "page.content_updated" });

    await routeForwardEvent(envelope);
    const firstWriteCount = writeBatchToRelayfileMock.mock.calls.length;
    await routeForwardEvent(envelope);

    // Both runs proceeded past the dedupe gate (no suppressed-redelivery log)
    // and did real fetch+write work the second time around.
    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      "Notion forward webhook redelivery suppressed",
      expect.anything(),
    );
    expect(writeBatchToRelayfileMock.mock.calls.length).toBeGreaterThan(firstWriteCount);
  });
});

describe("handleNotionForward — concurrent-write contentHash dedupe", () => {
  it("skips the content write when the existing content.md hash matches", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValueOnce({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "notion",
      connectionId: TEST_CONNECTION_ID,
      providerConfigKey: "notion-relay",
      installationId: null,
      metadata: {},
    });
    const markdown = "# Identical body";
    nangoProxyMock.mockImplementation(async (config: { endpoint: string }) => {
      if (config.endpoint.endsWith("/markdown")) {
        return { data: { markdown } };
      }
      return { data: notionApiPage() };
    });

    // Existing file has the SAME body — sync just landed it. Webhook should
    // not re-write the content record.
    relayfileReadFileMock.mockImplementation(async (_workspaceId: string, path: string) => {
      if (path.endsWith("/content.md")) {
        return { content: markdown };
      }
      return null;
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createNotionEnvelope({ type: "page.content_updated" }),
    );

    // Only the metadata record should be written; the content write was
    // dedup'd by hash.
    const models = writeBatchToRelayfileMock.mock.calls.map(
      (call) => (call[2] as { model: string }).model,
    );
    expect(models).toEqual(["NotionPage"]);
  });
});

describe("handleHubSpotForward", () => {
  function createHubSpotEnvelope(payload: unknown): NangoWebhookEnvelope {
    return {
      from: "hubspot-relay",
      type: "forward",
      providerConfigKey: "hubspot-relay",
      connectionId: "conn-hubspot-1",
      payload,
    };
  }

  beforeEach(() => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "hubspot",
      connectionId: "conn-hubspot-1",
      providerConfigKey: "hubspot-relay",
      installationId: null,
      metadata: {},
    });
  });

  it("fetches and writes a changed contact, then emits a watch event for the canonical path", async () => {
    nangoProxyMock.mockResolvedValue({
      data: {
        id: "101",
        properties: {
          firstname: "Ada",
          lastname: "Lovelace",
          email: "ada@example.com",
          lastmodifieddate: "2026-05-21T10:00:00.000Z",
        },
      },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createHubSpotEnvelope([
        {
          subscriptionType: "object.propertyChange",
          objectTypeId: "0-1",
          objectId: 101,
        },
      ]),
    );

    expect(findWorkspaceIntegrationByConnectionMock).toHaveBeenCalledWith(
      "hubspot",
      "conn-hubspot-1",
    );
    expect(nangoProxyMock).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/crm/v3/objects/contacts/101",
      connectionId: "conn-hubspot-1",
      providerConfigKey: "hubspot-relay",
      params: {
        properties: "firstname,lastname,email,phone,jobtitle,company,createdate,lastmodifieddate",
      },
      retries: 3,
    });
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[1]).toEqual([
      {
        id: "101",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        phone: undefined,
        jobTitle: undefined,
        company: undefined,
        createdAt: undefined,
        updatedAt: "2026-05-21T10:00:00.000Z",
      },
    ]);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "hubspot",
      syncName: "fetch-contacts",
      model: "Contact",
    });
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "hubspot",
      eventType: "object.propertyChange",
      connectionId: "conn-hubspot-1",
      paths: ["/hubspot/contacts/101.json"],
      payload: expect.objectContaining({ id: "101", email: "ada@example.com" }),
    });
  });

  it("preserves terminal deal states as upserts, not deletes", async () => {
    nangoProxyMock.mockResolvedValue({
      data: {
        id: "301",
        properties: {
          dealname: "Expansion",
          amount: "4200",
          dealstage: "closedwon",
          hs_lastmodifieddate: "2026-05-21T11:00:00.000Z",
        },
        associations: {
          companies: { results: [{ id: "201" }] },
          contacts: { results: [{ id: "101" }] },
        },
      },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createHubSpotEnvelope([
        {
          subscriptionType: "object.propertyChange",
          objectTypeId: "0-3",
          objectId: "301",
        },
      ]),
    );

    const records = writeBatchToRelayfileMock.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(records[0]).toMatchObject({
      id: "301",
      name: "Expansion",
      amount: 4200,
      stage: "closedwon",
      companyIds: ["201"],
      contactIds: ["101"],
    });
    expect(records[0]?._nango_metadata).toBeUndefined();
    expect(nangoProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/crm/v3/objects/deals/301",
        params: expect.objectContaining({ associations: "companies,contacts" }),
      }),
    );
  });

  it("turns object.merge events into loser tombstones and a winner upsert", async () => {
    nangoProxyMock.mockResolvedValue({
      data: {
        id: "103",
        properties: {
          firstname: "Grace",
          lastname: "Hopper",
          email: "grace@example.com",
          lastmodifieddate: "2026-05-21T12:00:00.000Z",
        },
      },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createHubSpotEnvelope([
        {
          subscriptionType: "object.merge",
          objectTypeId: "0-1",
          objectId: "101",
          mergedObjectIds: ["101", 102],
          newObjectId: "103",
        },
      ]),
    );

    expect(nangoProxyMock).toHaveBeenCalledTimes(1);
    expect(nangoProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/crm/v3/objects/contacts/103",
      }),
    );
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(2);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        id: "101",
        _nango_metadata: expect.objectContaining({ last_action: "deleted" }),
      }),
      expect.objectContaining({
        id: "102",
        _nango_metadata: expect.objectContaining({ last_action: "deleted" }),
      }),
    ]);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "hubspot",
      syncName: "fetch-contacts",
      model: "Contact",
    });
    expect(writeBatchToRelayfileMock.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({
        id: "103",
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@example.com",
      }),
    ]);
    expect(writeBatchToRelayfileMock.mock.calls[1]?.[2]).toMatchObject({
      provider: "hubspot",
      syncName: "fetch-contacts",
      model: "Contact",
    });
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "hubspot",
      eventType: "object.merge",
      connectionId: "conn-hubspot-1",
      paths: ["/hubspot/contacts/101.json", "/hubspot/contacts/102.json"],
      payload: [
        expect.objectContaining({
          id: "101",
          _nango_metadata: expect.objectContaining({ last_action: "deleted" }),
        }),
        expect.objectContaining({
          id: "102",
          _nango_metadata: expect.objectContaining({ last_action: "deleted" }),
        }),
      ],
    });
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "hubspot",
      eventType: "object.merge",
      connectionId: "conn-hubspot-1",
      paths: ["/hubspot/contacts/103.json"],
      payload: expect.objectContaining({
        id: "103",
        email: "grace@example.com",
      }),
    });
  });

  it("treats object.restore as an upsert", async () => {
    nangoProxyMock.mockResolvedValue({
      data: {
        id: "201",
        properties: {
          name: "Analytical Engines LLC",
          domain: "engines.example",
          hs_lastmodifieddate: "2026-05-21T12:30:00.000Z",
        },
      },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createHubSpotEnvelope([
        {
          subscriptionType: "object.restore",
          objectTypeId: "0-2",
          objectId: "201",
        },
      ]),
    );

    expect(nangoProxyMock).toHaveBeenCalledWith({
      method: "GET",
      endpoint: "/crm/v3/objects/companies/201",
      connectionId: "conn-hubspot-1",
      providerConfigKey: "hubspot-relay",
      params: {
        properties: "name,domain,industry,city,state,country,phone,website,description,createdate,hs_lastmodifieddate",
      },
      retries: 3,
    });
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const records = writeBatchToRelayfileMock.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(records).toEqual([
      expect.objectContaining({
        id: "201",
        name: "Analytical Engines LLC",
        domain: "engines.example",
      }),
    ]);
    expect(records[0]?._nango_metadata).toBeUndefined();
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "hubspot",
      syncName: "fetch-companies",
      model: "Company",
    });
  });

  it("preserves closed ticket property changes as upserts, not deletes", async () => {
    nangoProxyMock.mockResolvedValue({
      data: {
        id: "401",
        properties: {
          subject: "Billing follow-up",
          content: "Customer confirmed resolution.",
          hs_pipeline: "support",
          hs_pipeline_stage: "closed",
          hs_lastmodifieddate: "2026-05-21T13:00:00.000Z",
        },
      },
    });

    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createHubSpotEnvelope([
        {
          subscriptionType: "object.propertyChange",
          objectTypeId: "0-5",
          objectId: "401",
        },
      ]),
    );

    expect(nangoProxyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/crm/v3/objects/tickets/401",
      }),
    );
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    const records = writeBatchToRelayfileMock.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
    expect(records[0]).toMatchObject({
      id: "401",
      subject: "Billing follow-up",
      content: "Customer confirmed resolution.",
      pipeline: "support",
      stage: "closed",
      updatedAt: "2026-05-21T13:00:00.000Z",
    });
    expect(records[0]?._nango_metadata).toBeUndefined();
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "hubspot",
      syncName: "fetch-tickets",
      model: "Ticket",
    });
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "hubspot",
      eventType: "object.propertyChange",
      connectionId: "conn-hubspot-1",
      paths: ["/hubspot/tickets/401.json"],
      payload: expect.objectContaining({
        id: "401",
        stage: "closed",
      }),
    });
  });

  it("turns object.deletion events into Relayfile tombstones", async () => {
    const { routeForwardEvent } = await loadRouter();
    await routeForwardEvent(
      createHubSpotEnvelope([
        {
          subscriptionType: "object.deletion",
          objectTypeId: "0-5",
          objectId: "401",
        },
      ]),
    );

    expect(nangoProxyMock).not.toHaveBeenCalled();
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        id: "401",
        _nango_metadata: expect.objectContaining({ last_action: "deleted" }),
      }),
    ]);
    expect(writeBatchToRelayfileMock.mock.calls[0]?.[2]).toMatchObject({
      provider: "hubspot",
      syncName: "fetch-tickets",
      model: "Ticket",
    });
    expect(dispatchIntegrationWatchEventMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "hubspot",
      eventType: "object.deletion",
      connectionId: "conn-hubspot-1",
      paths: ["/hubspot/tickets/401.json"],
      payload: [
        expect.objectContaining({
          id: "401",
          _nango_metadata: expect.objectContaining({ last_action: "deleted" }),
        }),
      ],
    });
  });

  it("releases the dedupe claim when the Relayfile write fails", async () => {
    const payload = [
      {
        subscriptionType: "object.propertyChange",
        objectTypeId: "0-1",
        objectId: "101",
      },
    ];
    nangoProxyMock.mockResolvedValue({
      data: {
        id: "101",
        properties: {
          firstname: "Ada",
          lastname: "Lovelace",
          email: "ada@example.com",
          lastmodifieddate: "2026-05-21T14:00:00.000Z",
        },
      },
    });
    writeBatchToRelayfileMock
      .mockRejectedValueOnce(new Error("relayfile unavailable"))
      .mockResolvedValue({
        written: 1,
        deleted: 0,
        errors: 0,
      });

    const { routeForwardEvent } = await loadRouter();
    await expect(routeForwardEvent(createHubSpotEnvelope(payload))).rejects.toThrow(
      "relayfile unavailable",
    );

    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(1);
    await routeForwardEvent(createHubSpotEnvelope(payload));

    expect(nangoProxyMock).toHaveBeenCalledTimes(2);
    expect(writeBatchToRelayfileMock).toHaveBeenCalledTimes(2);
    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      "HubSpot forward webhook redelivery suppressed",
      expect.anything(),
    );
    expect(writeBatchToRelayfileMock.mock.calls[1]?.[1]).toEqual([
      expect.objectContaining({
        id: "101",
        email: "ada@example.com",
      }),
    ]);
  });
});
