import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pathMatches } from "@relayfile/sdk";

const TEST_WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const {
  bootstrapRegistryFromEnvMock,
  computePathMock,
  computeLinearPathMock,
  computeSlackPathMock,
  createSlackMessageObjectIdMock,
  createSlackThreadObjectIdMock,
  createSlackThreadReplyObjectIdMock,
  createGitHubRelayfileClientMock,
  enqueueNangoSyncJobMock,
  fanoutExceptMock,
  fanoutMock,
  findWorkspaceIntegrationByConnectionMock,
  getRecentWorkspaceIntegrationDisconnectMock,
  getWorkspaceIntegrationMock,
  getNangoConnectionDetailsMock,
  getProviderConfigKeyMock,
  ingestWebhookMock,
  insertWorkspaceIntegrationIfAbsentMock,
  probeNangoConnectionLivenessMock,
  replaceWorkspaceIntegrationConnectionIfStaleMock,
  isValidWorkspaceIdAnyMock,
  listMock,
  loggerInfoMock,
  loggerWarnMock,
  markProviderInitialSyncCompleteMock,
  markProviderInitialSyncFailedMock,
  markProviderInitialSyncQueuedMock,
  markProviderOAuthConnectedMock,
  normalizeLinearWebhookMock,
  normalizeWebhookMock,
  registerMock,
  upsertWorkspaceIntegrationMock,
  writeFileMock,
  deleteFileMock,
} = vi.hoisted(() => ({
  bootstrapRegistryFromEnvMock: vi.fn(),
  computePathMock: vi.fn(),
  computeLinearPathMock: vi.fn(() => "/linear/issues/issue-123.json"),
  computeSlackPathMock: vi.fn((objectType: string, objectId: string) => `/slack/${objectType}/${objectId}.json`),
  createSlackMessageObjectIdMock: vi.fn((channelId: string, ts: string) => `${channelId}:${ts}`),
  createSlackThreadObjectIdMock: vi.fn((channelId: string, threadTs: string) => `${channelId}:${threadTs}`),
  createSlackThreadReplyObjectIdMock: vi.fn((channelId: string, threadTs: string, replyTs: string) => `${channelId}:${threadTs}:${replyTs}`),
  createGitHubRelayfileClientMock: vi.fn(),
  enqueueNangoSyncJobMock: vi.fn().mockResolvedValue(undefined),
  fanoutExceptMock: vi.fn(),
  fanoutMock: vi.fn(),
  findWorkspaceIntegrationByConnectionMock: vi.fn(),
  getRecentWorkspaceIntegrationDisconnectMock: vi.fn().mockResolvedValue(null),
  getWorkspaceIntegrationMock: vi.fn().mockResolvedValue(null),
  getNangoConnectionDetailsMock: vi.fn().mockResolvedValue(null),
  getProviderConfigKeyMock: vi.fn((provider: string) => `${provider}-config`),
  ingestWebhookMock: vi.fn().mockResolvedValue({ status: "queued", id: "evt-1" }),
  insertWorkspaceIntegrationIfAbsentMock: vi
    .fn()
    .mockResolvedValue({ inserted: true }),
  probeNangoConnectionLivenessMock: vi.fn().mockResolvedValue("unknown"),
  replaceWorkspaceIntegrationConnectionIfStaleMock: vi
    .fn()
    .mockResolvedValue(null),
  isValidWorkspaceIdAnyMock: vi.fn().mockReturnValue(false),
  listMock: vi.fn(),
  loggerInfoMock: vi.fn().mockResolvedValue(undefined),
  loggerWarnMock: vi.fn().mockResolvedValue(undefined),
  markProviderInitialSyncCompleteMock: vi.fn().mockResolvedValue(undefined),
  markProviderInitialSyncFailedMock: vi.fn().mockResolvedValue(undefined),
  markProviderInitialSyncQueuedMock: vi.fn().mockResolvedValue(undefined),
  markProviderOAuthConnectedMock: vi.fn().mockResolvedValue(undefined),
  normalizeLinearWebhookMock: vi.fn(),
  normalizeWebhookMock: vi.fn(),
  registerMock: vi.fn(),
  upsertWorkspaceIntegrationMock: vi.fn().mockResolvedValue(undefined),
  writeFileMock: vi.fn().mockResolvedValue({ status: "queued" }),
  deleteFileMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  markProviderInitialSyncComplete: markProviderInitialSyncCompleteMock,
  markProviderInitialSyncFailed: markProviderInitialSyncFailedMock,
  markProviderInitialSyncQueued: markProviderInitialSyncQueuedMock,
  markProviderOAuthConnected: markProviderOAuthConnectedMock,
}));

vi.mock("@/lib/integrations/nango-sync-queue", () => ({
  enqueueNangoSyncJob: enqueueNangoSyncJobMock,
}));

vi.mock("@/lib/integrations/webhook-consumer-registry", () => ({
  bootstrapRegistryFromEnv: bootstrapRegistryFromEnvMock,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceIntegrationByConnection: findWorkspaceIntegrationByConnectionMock,
  getRecentWorkspaceIntegrationDisconnect:
    getRecentWorkspaceIntegrationDisconnectMock,
  getWorkspaceIntegration: getWorkspaceIntegrationMock,
  findSlackIntegrationByConnectionId: vi.fn().mockResolvedValue(null),
  findSlackIntegrationByTeamId: vi.fn().mockResolvedValue(null),
  findWorkspaceIntegrationByInstallation: vi.fn().mockResolvedValue(null),
  insertWorkspaceIntegrationIfAbsent: insertWorkspaceIntegrationIfAbsentMock,
  replaceWorkspaceIntegrationConnectionIfStale:
    replaceWorkspaceIntegrationConnectionIfStaleMock,
  upsertWorkspaceIntegration: upsertWorkspaceIntegrationMock,
  deleteWorkspaceIntegration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/integrations/github-relayfile", () => ({
    enrichGitHubWatchPayload: vi.fn((data: Record<string, unknown>) => data),
  buildGitHubWebhookFileData: vi.fn((normalized: {
    objectType?: string;
    payload?: Record<string, unknown>;
  }) => {
    const payload = normalized.payload ?? {};
    if (normalized.objectType === "pull_request" && payload.pull_request) {
      const repository = payload.repository as Record<string, unknown> | undefined;
      return {
        ...(payload.pull_request as Record<string, unknown>),
        repository,
        full_name: typeof repository?.full_name === "string" ? repository.full_name : undefined,
      };
    }
    if (normalized.objectType === "issue" && payload.issue) {
      const repository = payload.repository as Record<string, unknown> | undefined;
      return {
        ...(payload.issue as Record<string, unknown>),
        repository,
        full_name: typeof repository?.full_name === "string" ? repository.full_name : undefined,
      };
    }
    return payload;
  }),
  buildGitHubWebhookIngestData: vi.fn((normalized: { payload?: Record<string, unknown> }) => ({
    eventType: "file.updated",
    data: normalized.payload ?? {},
  })),
  createGitHubRelayfileClient: createGitHubRelayfileClientMock,
  computePath: computePathMock,
  getGitHubWebhookRecordWriterTarget: vi.fn((normalized: { objectType?: string }) => {
    if (normalized.objectType === "pull_request") {
      return { syncName: "fetch-open-prs", model: "PullRequest" };
    }
    if (normalized.objectType === "issue") {
      return { syncName: "fetch-open-issues", model: "Issue" };
    }
    return null;
  }),
  normalizeWebhook: normalizeWebhookMock,
}));

vi.mock("@relayfile/adapter-linear", () => ({
  normalizeLinearWebhook: normalizeLinearWebhookMock,
}));

vi.mock("@relayfile/adapter-notion", () => ({
  NotionAdapter: vi.fn(),
}));

vi.mock("@relayfile/adapter-github/path-mapper", () => ({
  computeGitHubPath: vi.fn(),
  githubIssuePath: vi.fn((owner: string, repo: string, number: string | number) =>
    `/github/repos/${owner}/${repo}/issues/${number}/metadata.json`,
  ),
  githubPullRequestPath: vi.fn((owner: string, repo: string, number: string | number) =>
    `/github/repos/${owner}/${repo}/pulls/${number}/metadata.json`,
  ),
  githubRepositoryMetadataPath: vi.fn((owner: string, repo: string) =>
    `/github/repos/${owner}/${repo}/metadata.json`,
  ),
  normalizeNangoGitHubModel: vi.fn((model: string) => {
    const normalized = model.toLowerCase();
    if (normalized.includes("pull")) return "pull_request";
    if (normalized.includes("issue")) return "issue";
    if (normalized.includes("repo")) return "repository";
    return normalized;
  }),
}));

vi.mock("@relayfile/adapter-linear/path-mapper", () => ({
  computeLinearPath: computeLinearPathMock,
  normalizeNangoLinearModel: vi.fn((model: string) => {
    const normalized = model.toLowerCase();
    if (normalized.includes("issue")) return "issue";
    if (normalized.includes("comment")) return "comment";
    return normalized;
  }),
}));

vi.mock("@relayfile/adapter-slack/path-mapper", () => ({
  channelMetadataPath: vi.fn((channelId: string) => `/slack/channel/${channelId}.json`),
  computeSlackPath: computeSlackPathMock,
  createSlackMessageObjectId: createSlackMessageObjectIdMock,
  createSlackThreadObjectId: createSlackThreadObjectIdMock,
  createSlackThreadReplyObjectId: createSlackThreadReplyObjectIdMock,
  messagePath: vi.fn((channelId: string, ts: string) => `/slack/message/${channelId}:${ts}.json`),
  slackChannelsIndexPath: vi.fn(() => "/slack/channels/_index.json"),
  threadPath: vi.fn((channelId: string, ts: string) => `/slack/thread/${channelId}:${ts}.json`),
  threadReplyPath: vi.fn((channelId: string, threadTs: string, ts: string) =>
    `/slack/reply/${channelId}:${threadTs}:${ts}.json`,
  ),
  userMetadataPath: vi.fn((userId: string) => `/slack/user/${userId}.json`),
}));

vi.mock("@cloud/core/sync/linear-semantics.js", () => ({
  buildLinearSyncSemantics: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoHost: vi.fn().mockReturnValue("https://api.nango.dev"),
  getNangoSecretKey: vi.fn().mockReturnValue("test-nango-secret"),
  getProviderConfigKey: getProviderConfigKeyMock,
  getNangoConnectionDetails: getNangoConnectionDetailsMock,
  probeNangoConnectionLiveness: probeNangoConnectionLivenessMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
    notice: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/integrations/nango-slack", () => ({
  getSlackConnectionIdentity: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/integrations/slack-identity", () => ({
  extractSlackConnectionIdentityFromForwardPayload: vi.fn().mockReturnValue({}),
  hasSlackConnectionIdentity: vi.fn().mockReturnValue(false),
  mergeSlackConnectionIdentity: vi.fn().mockReturnValue({}),
  mergeSlackConnectionIdentityMetadata: vi.fn().mockReturnValue({}),
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: vi.fn().mockReturnValue(undefined),
}));

vi.mock("@cloud/core/workspace/id.js", () => ({
  isValidWorkspaceIdAny: (value: string) => isValidWorkspaceIdAnyMock(value),
}));

vi.mock("@relayfile/provider-nango", () => ({
  fetchNangoRecords: vi.fn(),
  recordNotionIngest: vi.fn(),
  NotionIngestHandler: {
    handleNotionSyncNotification: vi.fn(),
    handleNotionBulkIngest: vi.fn(),
  },
  NotionSupportedModelSchema: { safeParse: () => ({ success: false }) },
}));

type HandleSyncEventModule = {
  handleSyncEvent: (envelope: {
    from: string;
    type: string;
    providerConfigKey: string;
    connectionId: string | null;
    payload: unknown;
  }) => Promise<void>;
  routeForwardEvent: (envelope: {
    from: string;
    type: string;
    providerConfigKey: string;
    connectionId: string | null;
    payload: unknown;
  }) => Promise<void>;
};

function okFanoutResult() {
  return {
    total: 1,
    succeeded: ["consumer"],
    failed: [],
    skipped: [],
  };
}

function resetWebhookRegistryMock(): void {
  fanoutMock.mockResolvedValue(okFanoutResult());
  fanoutExceptMock.mockResolvedValue(okFanoutResult());
  listMock.mockReturnValue([{ id: "mock-consumer" }]);
  bootstrapRegistryFromEnvMock.mockReturnValue({
    fanout: fanoutMock,
    fanoutExcept: fanoutExceptMock,
    list: listMock,
    register: registerMock,
  });
}

async function loadModule(): Promise<HandleSyncEventModule> {
  return import(
    new URL(
      "../packages/web/lib/integrations/nango-webhook-router.ts",
      import.meta.url,
    ).href
  ) as Promise<HandleSyncEventModule>;
}

function makeEnvelope(overrides: {
  from?: string;
  providerConfigKey?: string;
  connectionId?: string | null;
  syncName?: string;
  model?: string;
  success?: boolean;
  modifiedAfter?: string;
}) {
  return {
    from: overrides.from ?? "github-sage",
    type: "sync",
    providerConfigKey: overrides.providerConfigKey ?? "github-sage",
    connectionId:
      "connectionId" in overrides
        ? overrides.connectionId ?? null
        : "conn-github-123",
    payload: {
      syncName: overrides.syncName ?? "fetch-repos",
      model: overrides.model ?? "Repo",
      success: overrides.success ?? true,
      modifiedAfter: overrides.modifiedAfter ?? "2026-01-01T00:00:00Z",
    },
  };
}

describe("handleSyncEvent async queue routing", () => {
  let handleSyncEvent: HandleSyncEventModule["handleSyncEvent"];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    resetWebhookRegistryMock();
    getRecentWorkspaceIntegrationDisconnectMock.mockResolvedValue(null);

    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-github-123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
    });

    const mod = await loadModule();
    handleSyncEvent = mod.handleSyncEvent;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues successful GitHub sync webhooks with resolved workspace context", async () => {
    await handleSyncEvent(
      makeEnvelope({
        model: "PullRequest",
        syncName: "fetch-open-prs",
        modifiedAfter: "2026-04-01T00:00:00Z",
      }),
    );

    expect(enqueueNangoSyncJobMock).toHaveBeenCalledTimes(1);
    expect(enqueueNangoSyncJobMock).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "github",
      connectionId: "conn-github-123",
      providerConfigKey: "github-sage",
      syncName: "fetch-open-prs",
      model: "PullRequest",
      modifiedAfter: "2026-04-01T00:00:00Z",
      cursor: null,
      workspaceId: TEST_WORKSPACE_ID,
    });
    expect(markProviderInitialSyncQueuedMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      syncName: "fetch-open-prs",
      model: "PullRequest",
      modifiedAfter: "2026-04-01T00:00:00Z",
    });
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Nango sync job enqueued",
      expect.objectContaining({
        area: "nango-webhook",
        provider: "github",
        workspaceId: TEST_WORKSPACE_ID,
      }),
    );
  });

  it("enqueues Slack sync webhooks using the concrete workspace provider", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack-nightcto",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-nightcto",
      installationId: null,
      metadata: {},
    });

    await handleSyncEvent(
      makeEnvelope({
        from: "slack-nightcto",
        providerConfigKey: "slack-nightcto",
        connectionId: "conn-slack-123",
        model: "SlackMessage",
        syncName: "fetch-slack-messages",
      }),
    );

    expect(findWorkspaceIntegrationByConnectionMock).toHaveBeenCalledWith(
      "slack-nightcto",
      "conn-slack-123",
    );
    expect(enqueueNangoSyncJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "slack-nightcto",
        providerConfigKey: "slack-nightcto",
        connectionId: "conn-slack-123",
        model: "SlackMessage",
      }),
    );
  });

  it("does not enqueue failed sync notifications", async () => {
    await handleSyncEvent(makeEnvelope({ success: false }));

    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(markProviderInitialSyncFailedMock).toHaveBeenCalledWith({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      error: "Nango reported a failed sync for fetch-repos",
      syncName: "fetch-repos",
      model: "Repo",
      modifiedAfter: "2026-01-01T00:00:00Z",
    });
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook reported a failed sync",
      expect.objectContaining({
        area: "nango-webhook",
        syncName: "fetch-repos",
      }),
    );
  });

  it("does not enqueue when provider or connection cannot be determined", async () => {
    await handleSyncEvent(
      makeEnvelope({
        from: "unknown-provider",
        providerConfigKey: "unknown-provider",
        connectionId: null,
      }),
    );

    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook could not determine provider or connection",
      expect.objectContaining({
        area: "nango-webhook",
        provider: "unknown-provider",
      }),
    );
  });

  it("does not enqueue when the workspace cannot be resolved", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);

    await handleSyncEvent(makeEnvelope({ model: "Issue" }));

    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook could not resolve workspace",
      expect.objectContaining({
        area: "nango-webhook",
        provider: "github",
        model: "Issue",
      }),
    );
  });

  it("self-heals a missing workspace_integrations row from Nango connection details and enqueues the sync", async () => {
    // No row in the cloud — orphaned-connection failure mode.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    // Nango knows the connection and which workspaceId it belongs to.
    isValidWorkspaceIdAnyMock.mockImplementation(
      (value: string) => value === "rw_91c99e4d",
    );
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: {
        end_user: { id: "rw_91c99e4d" },
      },
      installationId: null,
    });
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({ inserted: true });

    await handleSyncEvent(
      makeEnvelope({
        from: "linear-relay",
        providerConfigKey: "linear-relay",
        connectionId: "4d63dc05-cbcb-4ecc-a80d-4e3f1ec1b48e",
        model: "Issue",
        syncName: "fetch-linear-issues",
      }),
    );

    expect(getNangoConnectionDetailsMock).toHaveBeenCalledWith(
      "4d63dc05-cbcb-4ecc-a80d-4e3f1ec1b48e",
      "linear-relay",
    );
    expect(insertWorkspaceIntegrationIfAbsentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "4d63dc05-cbcb-4ecc-a80d-4e3f1ec1b48e",
        providerConfigKey: "linear-relay",
      }),
    );
    // The atomic insert must replace the prior read-then-upsert; the
    // unconditional upsert path is no longer load-bearing here.
    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(enqueueNangoSyncJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "nango_sync",
        provider: "linear",
        connectionId: "4d63dc05-cbcb-4ecc-a80d-4e3f1ec1b48e",
        providerConfigKey: "linear-relay",
        workspaceId: "rw_91c99e4d",
        syncName: "fetch-linear-issues",
        model: "Issue",
      }),
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Nango sync webhook self-healed missing workspace_integrations row",
      expect.objectContaining({
        workspaceId: "rw_91c99e4d",
        connectionId: "4d63dc05-cbcb-4ecc-a80d-4e3f1ec1b48e",
      }),
    );
  });

  it("skips self-heal when the Nango connection was explicitly disconnected recently", async () => {
    // No row in cloud and Nango can still recover the workspace. A recent
    // disconnect tombstone means this is likely a late webhook from a
    // connection the operator explicitly removed, so self-heal must not
    // recreate the workspace_integrations row.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    isValidWorkspaceIdAnyMock.mockImplementation(
      (value: string) => value === "rw_91c99e4d",
    );
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { end_user: { id: "rw_91c99e4d" } },
      installationId: null,
    });
    getRecentWorkspaceIntegrationDisconnectMock.mockResolvedValue({
      workspaceId: "rw_91c99e4d",
      provider: "linear",
      connectionId: "explicitly-disconnected-connection-id",
      providerConfigKey: "linear-relay",
      disconnectedAt: new Date("2026-05-12T08:00:00.000Z"),
      expiresAt: new Date("2026-05-19T08:00:00.000Z"),
      createdAt: new Date("2026-05-12T08:00:00.000Z"),
      updatedAt: new Date("2026-05-12T08:00:00.000Z"),
    });

    await handleSyncEvent(
      makeEnvelope({
        from: "linear-relay",
        providerConfigKey: "linear-relay",
        connectionId: "explicitly-disconnected-connection-id",
        model: "Issue",
        syncName: "fetch-linear-issues",
      }),
    );

    expect(getRecentWorkspaceIntegrationDisconnectMock).toHaveBeenCalledWith({
      workspaceId: "rw_91c99e4d",
      provider: "linear",
      connectionId: "explicitly-disconnected-connection-id",
    });
    expect(insertWorkspaceIntegrationIfAbsentMock).not.toHaveBeenCalled();
    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook self-heal skipped: connection was explicitly disconnected",
      expect.objectContaining({
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "explicitly-disconnected-connection-id",
      }),
    );
  });

  it("skips self-heal upsert when workspace already has a different active connection", async () => {
    // No row matched by (provider, connectionId) — so we look like we need to
    // self-heal — but the workspace already has a row pointing at a *different*
    // (newer) connectionId. The atomic insert reports the conflict and hands
    // back the live row so we can bail on a connection mismatch without ever
    // entering the upsert's conflict-update path.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    isValidWorkspaceIdAnyMock.mockImplementation(
      (value: string) => value === "rw_91c99e4d",
    );
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { end_user: { id: "rw_91c99e4d" } },
      installationId: null,
    });
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "newer-active-connection-id",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {},
      },
    });

    await handleSyncEvent(
      makeEnvelope({
        from: "linear-relay",
        providerConfigKey: "linear-relay",
        connectionId: "stale-replay-connection-id",
        model: "Issue",
        syncName: "fetch-linear-issues",
      }),
    );

    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook self-heal skipped: workspace already has a different active connection",
      expect.objectContaining({
        workspaceId: "rw_91c99e4d",
        connectionId: "stale-replay-connection-id",
        currentConnectionId: "newer-active-connection-id",
      }),
    );
  });

  it("replaces a stale workspace_integrations row when the existing connection is gone upstream", async () => {
    // The operator reconnected via Nango directly, minting a new
    // connection. Cloud's row still points at the prior connection, which
    // the operator deleted upstream. The webhook for the new connection
    // would otherwise be refused (mismatch with the row). With the smart
    // self-heal: probe finds the prior connection returns 404 on Nango,
    // so we atomically replace the row's connectionId with the new one
    // and enqueue the sync.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    isValidWorkspaceIdAnyMock.mockImplementation(
      (value: string) => value === "rw_91c99e4d",
    );
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { end_user: { id: "rw_91c99e4d" } },
      installationId: null,
    });
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "deleted-old-connection-id",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {},
      },
    });
    probeNangoConnectionLivenessMock.mockResolvedValue("gone");
    replaceWorkspaceIntegrationConnectionIfStaleMock.mockResolvedValue({
      workspaceId: "rw_91c99e4d",
      provider: "linear",
      connectionId: "fresh-replay-connection-id",
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await handleSyncEvent(
      makeEnvelope({
        from: "linear-relay",
        providerConfigKey: "linear-relay",
        connectionId: "fresh-replay-connection-id",
        model: "Issue",
        syncName: "fetch-linear-issues",
      }),
    );

    expect(probeNangoConnectionLivenessMock).toHaveBeenCalledWith(
      "deleted-old-connection-id",
      "linear-relay",
    );
    expect(replaceWorkspaceIntegrationConnectionIfStaleMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "fresh-replay-connection-id",
        expectedConnectionId: "deleted-old-connection-id",
      }),
    );
    expect(enqueueNangoSyncJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "linear",
        connectionId: "fresh-replay-connection-id",
        workspaceId: "rw_91c99e4d",
      }),
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Nango sync webhook self-heal replaced stale workspace_integrations row",
      expect.objectContaining({
        replacedConnectionId: "deleted-old-connection-id",
        connectionId: "fresh-replay-connection-id",
      }),
    );
  });

  it("refuses replacement when the existing connection is still alive upstream", async () => {
    // Two genuinely live tenants must not be swapped — that's the
    // original safety property of the conflict-bailout. The probe
    // returning "alive" means the existing connection is still
    // syncing; refuse and let the operator resolve manually.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    isValidWorkspaceIdAnyMock.mockImplementation(
      (value: string) => value === "rw_91c99e4d",
    );
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { end_user: { id: "rw_91c99e4d" } },
      installationId: null,
    });
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "still-live-connection-id",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {},
      },
    });
    probeNangoConnectionLivenessMock.mockResolvedValue("alive");

    await handleSyncEvent(
      makeEnvelope({
        from: "linear-relay",
        providerConfigKey: "linear-relay",
        connectionId: "rival-connection-id",
        model: "Issue",
        syncName: "fetch-linear-issues",
      }),
    );

    expect(replaceWorkspaceIntegrationConnectionIfStaleMock).not.toHaveBeenCalled();
    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook self-heal skipped: workspace already has a different active connection",
      expect.objectContaining({
        currentConnectionId: "still-live-connection-id",
        existingLiveness: "alive",
      }),
    );
  });

  it("refuses replacement when liveness is indeterminate (transient Nango error)", async () => {
    // A 401/5xx from Nango must NOT cause us to replace the row — that
    // could trample a live tenant when Nango is briefly unreachable.
    // The "unknown" liveness preserves the conservative refusal.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    isValidWorkspaceIdAnyMock.mockImplementation(
      (value: string) => value === "rw_91c99e4d",
    );
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { end_user: { id: "rw_91c99e4d" } },
      installationId: null,
    });
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "maybe-live-connection-id",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {},
      },
    });
    probeNangoConnectionLivenessMock.mockResolvedValue("unknown");

    await handleSyncEvent(
      makeEnvelope({
        from: "linear-relay",
        providerConfigKey: "linear-relay",
        connectionId: "incoming-connection-id",
        model: "Issue",
        syncName: "fetch-linear-issues",
      }),
    );

    expect(replaceWorkspaceIntegrationConnectionIfStaleMock).not.toHaveBeenCalled();
    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook self-heal skipped: workspace already has a different active connection",
      expect.objectContaining({
        existingLiveness: "unknown",
      }),
    );
  });

  it("falls through to refusal when CAS replace loses to a concurrent writer", async () => {
    // Race: two self-heals fire in parallel. Both probe and find the
    // existing connection gone. Both call replaceWorkspaceIntegration
    // ConnectionIfStale. Only one CAS succeeds (the other returns null
    // because the row's connectionId no longer matches expectedConnectionId).
    // The losing writer must bail out — not retry with the new state and
    // not enqueue.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    isValidWorkspaceIdAnyMock.mockImplementation(
      (value: string) => value === "rw_91c99e4d",
    );
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { end_user: { id: "rw_91c99e4d" } },
      installationId: null,
    });
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "stale-connection-id",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {},
      },
    });
    probeNangoConnectionLivenessMock.mockResolvedValue("gone");
    replaceWorkspaceIntegrationConnectionIfStaleMock.mockResolvedValue(null);

    await handleSyncEvent(
      makeEnvelope({
        from: "linear-relay",
        providerConfigKey: "linear-relay",
        connectionId: "loser-connection-id",
        model: "Issue",
        syncName: "fetch-linear-issues",
      }),
    );

    expect(replaceWorkspaceIntegrationConnectionIfStaleMock).toHaveBeenCalled();
    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook self-heal skipped: workspace already has a different active connection",
      expect.anything(),
    );
  });

  it("proceeds with self-heal when the conflicting row already points at the same connection", async () => {
    // Race regression: simulate the auth webhook (or a parallel self-heal)
    // landing the real row between our connection-details fetch and our
    // INSERT, but the row points at the *same* connectionId we were going
    // to write. The helper reports `inserted: false` with that existing
    // row — we must treat this as a successful self-heal (row exists,
    // sync can proceed) rather than re-running the upsert and racing.
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    isValidWorkspaceIdAnyMock.mockImplementation(
      (value: string) => value === "rw_91c99e4d",
    );
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { end_user: { id: "rw_91c99e4d" } },
      installationId: null,
    });
    insertWorkspaceIntegrationIfAbsentMock.mockResolvedValue({
      inserted: false,
      existing: {
        workspaceId: "rw_91c99e4d",
        provider: "linear",
        connectionId: "4d63dc05-cbcb-4ecc-a80d-4e3f1ec1b48e",
        providerConfigKey: "linear-relay",
        installationId: null,
        metadata: {},
      },
    });

    await handleSyncEvent(
      makeEnvelope({
        from: "linear-relay",
        providerConfigKey: "linear-relay",
        connectionId: "4d63dc05-cbcb-4ecc-a80d-4e3f1ec1b48e",
        model: "Issue",
        syncName: "fetch-linear-issues",
      }),
    );

    // No upsert, but enqueue still happens because the row is there.
    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      "Nango sync webhook self-heal skipped: workspace already has a different active connection",
      expect.anything(),
    );
    expect(enqueueNangoSyncJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "linear",
        connectionId: "4d63dc05-cbcb-4ecc-a80d-4e3f1ec1b48e",
        workspaceId: "rw_91c99e4d",
      }),
    );
  });

  it("warns and does not enqueue when self-heal cannot recover a workspaceId from Nango", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue(null);
    // Nango returns connection details but no end_user.id we can map.
    getNangoConnectionDetailsMock.mockResolvedValue({
      payload: { end_user: {} },
      installationId: null,
    });

    await handleSyncEvent(makeEnvelope({ model: "Issue" }));

    expect(upsertWorkspaceIntegrationMock).not.toHaveBeenCalled();
    expect(enqueueNangoSyncJobMock).not.toHaveBeenCalled();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook self-heal could not recover workspaceId from connection details",
      expect.objectContaining({ provider: "github" }),
    );
    expect(loggerWarnMock).toHaveBeenCalledWith(
      "Nango sync webhook could not resolve workspace",
      expect.objectContaining({ provider: "github" }),
    );
  });
});

describe("routeForwardEvent RelayFile routing", () => {
  let routeForwardEvent: HandleSyncEventModule["routeForwardEvent"];

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    resetWebhookRegistryMock();
    getRecentWorkspaceIntegrationDisconnectMock.mockResolvedValue(null);

    createGitHubRelayfileClientMock.mockReturnValue({
      ingestWebhook: ingestWebhookMock,
      writeFile: writeFileMock,
      deleteFile: deleteFileMock,
    });

    const mod = await loadModule();
    routeForwardEvent = mod.routeForwardEvent;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("materializes GitHub forward webhooks as RelayFile file updates", async () => {
    const repository = {
      full_name: "AgentWorkforce/cloud",
      name: "cloud",
      owner: { login: "AgentWorkforce" },
    };
    const pullRequest = { id: 123, number: 17, title: "Fix webhook writes" };
    const payload = {
      action: "opened",
      repository,
      pull_request: pullRequest,
    };

    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-github-123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
    });
    normalizeWebhookMock.mockReturnValue({
      provider: "github",
      connectionId: "conn-github-123",
      eventType: "pull_request.opened",
      objectType: "pull_request",
      objectId: "17",
      payload,
    });
    computePathMock.mockReturnValue(
      "/github/repos/AgentWorkforce/cloud/pulls/17/metadata.json",
    );

    await routeForwardEvent({
      from: "github-sage",
      type: "forward",
      providerConfigKey: "github-sage",
      connectionId: "conn-github-123",
      payload: {
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-123",
        },
        body: payload,
      },
    });

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/github/repos/AgentWorkforce/cloud/pulls/17/metadata.json",
        contentType: "application/json; charset=utf-8",
      }),
    );
    expect(JSON.parse(String(writeFileMock.mock.calls[0]?.[0]?.content))).toMatchObject({
      ...pullRequest,
      repository,
    });
  });

  it("keeps closed GitHub pull requests as RelayFile file updates", async () => {
    const repository = {
      full_name: "AgentWorkforce/cloud",
      name: "cloud",
      owner: { login: "AgentWorkforce" },
    };
    const pullRequest = { id: 123, number: 17, title: "Fix webhook writes", state: "closed" };
    const payload = {
      action: "closed",
      repository,
      pull_request: pullRequest,
    };

    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-github-123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
    });
    normalizeWebhookMock.mockReturnValue({
      provider: "github",
      connectionId: "conn-github-123",
      eventType: "pull_request.closed",
      objectType: "pull_request",
      objectId: "17",
      payload,
    });
    computePathMock.mockReturnValue(
      "/github/repos/AgentWorkforce/cloud/pulls/17/metadata.json",
    );

    await routeForwardEvent({
      from: "github-sage",
      type: "forward",
      providerConfigKey: "github-sage",
      connectionId: "conn-github-123",
      payload: {
        headers: {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-closed-pr",
        },
        body: payload,
      },
    });

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/github/repos/AgentWorkforce/cloud/pulls/17/metadata.json",
        contentType: "application/json; charset=utf-8",
      }),
    );
  });

  it("keeps closed GitHub issues as RelayFile file updates", async () => {
    const repository = {
      full_name: "AgentWorkforce/cloud",
      name: "cloud",
      owner: { login: "AgentWorkforce" },
    };
    const issue = { id: 456, number: 22, title: "Track webhook routing", state: "closed" };
    const payload = {
      action: "closed",
      repository,
      issue,
    };

    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "github",
      connectionId: "conn-github-123",
      providerConfigKey: "github-sage",
      installationId: null,
      metadata: {},
    });
    normalizeWebhookMock.mockReturnValue({
      provider: "github",
      connectionId: "conn-github-123",
      eventType: "issues.closed",
      objectType: "issue",
      objectId: "22",
      payload,
    });
    computePathMock.mockReturnValue(
      "/github/repos/AgentWorkforce/cloud/issues/22/metadata.json",
    );

    await routeForwardEvent({
      from: "github-sage",
      type: "forward",
      providerConfigKey: "github-sage",
      connectionId: "conn-github-123",
      payload: {
        headers: {
          "x-github-event": "issues",
          "x-github-delivery": "delivery-closed-issue",
        },
        body: payload,
      },
    });

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/github/repos/AgentWorkforce/cloud/issues/22/metadata.json",
        contentType: "application/json; charset=utf-8",
      }),
    );
  });

  it("materializes Linear forward webhooks instead of dropping them", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: "conn-linear-123",
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });
    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: "conn-linear-123",
      eventType: "issue.update",
      objectType: "issue",
      objectId: "issue-123",
      payload: {
        data: {
          id: "issue-123",
          identifier: "ENG-123",
          title: "Updated from Linear",
          description: "Full webhook payload",
          state: { name: "In Progress", type: "started" },
          priority: 2,
          url: "https://linear.app/acme/issue/ENG-123",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        },
        _webhook: {
          action: "update",
          objectType: "issue",
          objectId: "issue-123",
        },
      },
    });

    await routeForwardEvent({
      from: "linear-relay",
      type: "forward",
      providerConfigKey: "linear-relay",
      connectionId: "conn-linear-123",
      payload: {
        body: {
          action: "update",
          type: "Issue",
          data: {
            id: "issue-123",
            identifier: "ENG-123",
            title: "Updated from Linear",
            description: "Full webhook payload",
            state: { name: "In Progress", type: "started" },
            priority: 2,
            url: "https://linear.app/acme/issue/ENG-123",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
          },
        },
      },
    });

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/linear/issues/issue-123.json",
        contentType: "application/json; charset=utf-8",
      }),
    );
    expect(JSON.parse(String(writeFileMock.mock.calls[0]?.[0]?.content))).toMatchObject({
          id: "issue-123",
          identifier: "ENG-123",
          title: "Updated from Linear",
          description: "Full webhook payload",
          state: { name: "In Progress", type: "started" },
          priority: 2,
          url: "https://linear.app/acme/issue/ENG-123",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
          _webhook: {
            action: "update",
            objectType: "issue",
            objectId: "issue-123",
          },
    });
  });

  it("keeps done Linear issues as RelayFile file updates", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: "conn-linear-123",
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });
    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: "conn-linear-123",
      eventType: "issue.update",
      objectType: "issue",
      objectId: "issue-123",
      payload: {
        data: {
          id: "issue-123",
          identifier: "ENG-123",
          title: "Completed from Linear",
          description: "Done issue payload",
          state: { name: "Done", type: "done" },
          priority: 2,
          url: "https://linear.app/acme/issue/ENG-123",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        },
        _webhook: {
          action: "update",
          objectType: "issue",
          objectId: "issue-123",
        },
      },
    });

    await routeForwardEvent({
      from: "linear-relay",
      type: "forward",
      providerConfigKey: "linear-relay",
      connectionId: "conn-linear-123",
      payload: {
        body: {
          action: "update",
          type: "Issue",
          data: {
            id: "issue-123",
            identifier: "ENG-123",
            title: "Completed from Linear",
            description: "Done issue payload",
            state: { name: "Done", type: "done" },
            priority: 2,
            url: "https://linear.app/acme/issue/ENG-123",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
          },
        },
      },
    });

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/linear/issues/issue-123.json",
        contentType: "application/json; charset=utf-8",
      }),
    );
  });

  it("keeps canceled Linear issues as RelayFile file updates", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: "conn-linear-123",
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });
    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: "conn-linear-123",
      eventType: "issue.update",
      objectType: "issue",
      objectId: "issue-123",
      payload: {
        data: {
          id: "issue-123",
          identifier: "ENG-123",
          title: "Canceled from Linear",
          description: "Canceled issue payload",
          state: { name: "Canceled", type: "canceled" },
          priority: 2,
          url: "https://linear.app/acme/issue/ENG-123",
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-20T00:00:00.000Z",
        },
        _webhook: {
          action: "update",
          objectType: "issue",
          objectId: "issue-123",
        },
      },
    });

    await routeForwardEvent({
      from: "linear-relay",
      type: "forward",
      providerConfigKey: "linear-relay",
      connectionId: "conn-linear-123",
      payload: {
        body: {
          action: "update",
          type: "Issue",
          data: {
            id: "issue-123",
            identifier: "ENG-123",
            title: "Canceled from Linear",
            description: "Canceled issue payload",
            state: { name: "Canceled", type: "canceled" },
            priority: 2,
            url: "https://linear.app/acme/issue/ENG-123",
            createdAt: "2026-04-01T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
          },
        },
      },
    });

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/linear/issues/issue-123.json",
        contentType: "application/json; charset=utf-8",
      }),
    );
  });

  it("does not overwrite Linear files with sparse forward payloads", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "linear",
      connectionId: "conn-linear-123",
      providerConfigKey: "linear-relay",
      installationId: null,
      metadata: {},
    });
    normalizeLinearWebhookMock.mockReturnValue({
      provider: "linear",
      connectionId: "conn-linear-123",
      eventType: "issue.update",
      objectType: "issue",
      objectId: "issue-123",
      payload: {
        data: {
          id: "issue-123",
          title: "Sparse update only",
        },
        _webhook: {
          action: "update",
          objectType: "issue",
          objectId: "issue-123",
        },
      },
    });

    await routeForwardEvent({
      from: "linear-relay",
      type: "forward",
      providerConfigKey: "linear-relay",
      connectionId: "conn-linear-123",
      payload: {
        body: {
          action: "update",
          type: "Issue",
          data: {
            id: "issue-123",
            title: "Sparse update only",
          },
        },
      },
    });

    expect(ingestWebhookMock).not.toHaveBeenCalled();
    expect(loggerInfoMock).toHaveBeenCalledWith(
      "Linear forward webhook skipped direct file write because payload is incomplete",
      expect.objectContaining({
        area: "nango-webhook",
        workspaceId: TEST_WORKSPACE_ID,
        objectType: "issue",
        objectId: "issue-123",
      }),
    );
  });

  it("materializes Slack relay forwards into RelayFile", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "slack-relay",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-123",
      payload: {
        body: {
          type: "event_callback",
          event_id: "Ev123",
          event: {
            type: "message",
            channel: "C123",
            user: "U123",
            text: "hello relayfile",
            ts: "1712345678.000100",
          },
        },
      },
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/slack/message/C123:1712345678.000100.json",
        contentType: "application/json; charset=utf-8",
      }),
    );
    expect(pathMatches("/slack/**", writeFileMock.mock.calls[0]?.[0]?.path ?? "")).toBe(true);
    expect(fanoutMock).not.toHaveBeenCalled();
  });

  it("materializes Slack message edits with the updated message body", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "slack-relay",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-123",
      payload: {
        body: {
          type: "event_callback",
          event_id: "EvChanged123",
          event: {
            type: "message",
            subtype: "message_changed",
            channel: "C123",
            previous_message: {
              type: "message",
              channel: "C123",
              user: "U123",
              text: "old text",
              ts: "1712345678.000300",
            },
            message: {
              type: "message",
              channel: "C123",
              user: "U123",
              text: "new text",
              ts: "1712345678.000300",
              edited: { ts: "1712345680.000000" },
            },
          },
        },
      },
    });

    const write = writeFileMock.mock.calls[0]?.[0];
    expect(write).toEqual(expect.objectContaining({
      workspaceId: TEST_WORKSPACE_ID,
      path: "/slack/message/C123:1712345678.000300.json",
    }));
    expect(JSON.parse(String(write?.content))).toEqual(
      expect.objectContaining({
        text: "new text",
        edited_ts: "1712345680.000000",
      }),
    );
  });

  it("preserves Slack channel membership actions in webhook metadata", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-123",
      providerConfigKey: "slack-relay",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "slack-relay",
      type: "forward",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-123",
      payload: {
        body: {
          type: "event_callback",
          event_id: "EvJoin123",
          event: {
            type: "member_joined_channel",
            channel: "C123",
            user: "U123",
          },
        },
      },
    });

    const write = writeFileMock.mock.calls[0]?.[0];
    expect(write).toEqual(expect.objectContaining({
      workspaceId: TEST_WORKSPACE_ID,
      path: "/slack/channel/C123.json",
    }));
    expect(JSON.parse(String(write?.content))).toEqual(
      expect.objectContaining({
        _webhook: expect.objectContaining({
          eventType: "member.joined.channel",
          action: "joined_channel",
        }),
      }),
    );
  });

  it("routes slack-sage forwards to Sage without writing RelayFile records", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "slack",
      connectionId: "conn-slack-sage-123",
      providerConfigKey: "slack-sage",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "slack-sage",
      type: "forward",
      providerConfigKey: "slack-sage",
      connectionId: "conn-slack-sage-123",
      payload: {
        body: {
          type: "event_callback",
          event_id: "EvSage123",
          event: {
            type: "message",
            channel: "C123",
            user: "U123",
            text: "hello sage",
            ts: "1712345678.000200",
          },
        },
      },
    });

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(fanoutMock).toHaveBeenCalledWith(
      "slack",
      expect.objectContaining({
        from: "slack",
        provider: "slack",
        eventType: "forward",
        providerConfigKey: "slack-sage",
      }),
    );
  });

  it("materializes Jira forward webhooks through the RelayFile record writer", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "jira",
      connectionId: "conn-jira-123",
      providerConfigKey: "jira-relay",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "jira-relay",
      type: "forward",
      providerConfigKey: "jira-relay",
      connectionId: "conn-jira-123",
      payload: {
        body: {
          webhookEvent: "jira:issue_updated",
          issue: {
            id: "10001",
            key: "ENG-42",
            fields: {
              summary: "Webhook routed issue",
              status: { name: "In Progress" },
              project: { key: "ENG" },
            },
          },
        },
      },
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/jira/issues/webhook-routed-issue__10001.json",
      }),
    );
    expect(pathMatches("/jira/**", writeFileMock.mock.calls[0]?.[0]?.path ?? "")).toBe(true);
    expect(fanoutExceptMock).toHaveBeenCalledWith(
      "jira",
      expect.objectContaining({
        provider: "jira",
        connectionId: "conn-jira-123",
        workspaceId: TEST_WORKSPACE_ID,
        eventType: "jira:issue_updated",
      }),
      ["relayfile-primary"],
    );
  });

  it("materializes Confluence forward webhooks through the RelayFile record writer", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "confluence",
      connectionId: "conn-confluence-123",
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "confluence-relay",
      type: "forward",
      providerConfigKey: "confluence-relay",
      connectionId: "conn-confluence-123",
      payload: {
        body: {
          event: "page_updated",
          page: {
            id: "98765",
            title: "Webhook Routed Page",
            spaceId: "ENG",
            status: "current",
          },
          space: {
            id: "space-1",
            key: "ENG",
            name: "Engineering",
          },
        },
      },
    });

    expect(writeFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/confluence/spaces/ENG/pages/webhook-routed-page__98765.json",
      }),
    );
    expect(pathMatches("/confluence/**", writeFileMock.mock.calls[0]?.[0]?.path ?? "")).toBe(true);
    expect(fanoutExceptMock).toHaveBeenCalledWith(
      "confluence",
      expect.objectContaining({
        provider: "confluence",
        connectionId: "conn-confluence-123",
        workspaceId: TEST_WORKSPACE_ID,
        eventType: "page_updated",
      }),
      ["relayfile-primary"],
    );
  });

  it("skips Confluence forward payloads without a concrete entity", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "confluence",
      connectionId: "conn-confluence-123",
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "confluence-relay",
      type: "forward",
      providerConfigKey: "confluence-relay",
      connectionId: "conn-confluence-123",
      payload: {
        body: {
          event: "page_updated",
          timestamp: "2026-05-11T21:00:00.000Z",
        },
      },
    });

    expect(writeFileMock).not.toHaveBeenCalled();
    expect(deleteFileMock).not.toHaveBeenCalled();
    expect(fanoutExceptMock).not.toHaveBeenCalled();
  });

  it("deletes RelayFile records for Jira delete forwards", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "jira",
      connectionId: "conn-jira-123",
      providerConfigKey: "jira-relay",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "jira-relay",
      type: "forward",
      providerConfigKey: "jira-relay",
      connectionId: "conn-jira-123",
      payload: {
        body: {
          webhookEvent: "jira:issue_deleted",
          issue: {
            id: "10001",
            key: "ENG-42",
            fields: { summary: "Removed issue" },
          },
        },
      },
    });

    expect(deleteFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/jira/issues/10001.json",
      }),
    );
    expect(pathMatches("/jira/**", deleteFileMock.mock.calls[0]?.[0]?.path ?? "")).toBe(true);
  });

  it("deletes RelayFile records for Confluence delete forwards", async () => {
    findWorkspaceIntegrationByConnectionMock.mockResolvedValue({
      workspaceId: TEST_WORKSPACE_ID,
      provider: "confluence",
      connectionId: "conn-confluence-123",
      providerConfigKey: "confluence-relay",
      installationId: null,
      metadata: {},
    });

    await routeForwardEvent({
      from: "confluence-relay",
      type: "forward",
      providerConfigKey: "confluence-relay",
      connectionId: "conn-confluence-123",
      payload: {
        body: {
          event: "page_removed",
          page: {
            id: "98765",
            title: "Removed Page",
            spaceId: "ENG",
          },
        },
      },
    });

    expect(deleteFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: TEST_WORKSPACE_ID,
        path: "/confluence/pages/98765.json",
      }),
    );
    expect(pathMatches("/confluence/**", deleteFileMock.mock.calls[0]?.[0]?.path ?? "")).toBe(true);
  });
});
