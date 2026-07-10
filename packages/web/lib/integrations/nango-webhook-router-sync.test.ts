import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteWorkspaceIntegration: vi.fn(),
  deleteUserIntegration: vi.fn(),
  enqueueNangoSyncJob: vi.fn(),
  findUserIntegrationByConnection: vi.fn(),
  findWorkspaceIntegrationByProviderAliasAndConnection: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getProviderConfigKey: vi.fn(),
  getRecentWorkspaceIntegrationDisconnect: vi.fn(),
  insertWorkspaceIntegrationIfAbsent: vi.fn(),
  logNangoDbWorkspaceDiagnostic: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  markProviderInitialSyncComplete: vi.fn(),
  markProviderInitialSyncFailed: vi.fn(),
  markProviderInitialSyncQueued: vi.fn(),
  markProviderOAuthConnected: vi.fn(),
  recordWorkspaceIntegrationDisconnect: vi.fn(),
  startNangoSyncSchedules: vi.fn(),
  triggerNangoSyncs: vi.fn(),
  upsertWorkspaceIntegration: vi.fn(),
  upsertUserIntegration: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  markProviderInitialSyncComplete: mocks.markProviderInitialSyncComplete,
  markProviderInitialSyncFailed: mocks.markProviderInitialSyncFailed,
  markProviderInitialSyncQueued: mocks.markProviderInitialSyncQueued,
  markProviderOAuthConnected: mocks.markProviderOAuthConnected,
}));

vi.mock("@cloud/core/sync/record-writer.js", () => ({
  buildDeletionRecord: vi.fn((id: string, metadata: Record<string, unknown>) => ({
    id,
    _deleted: true,
    ...metadata,
  })),
  createWebhookSyncJob: vi.fn((job: Record<string, unknown>) => job),
  writeBatchToRelayfile: vi.fn(),
}));

vi.mock("@/lib/integrations/nango-sync-queue", () => ({
  enqueueNangoSyncJob: mocks.enqueueNangoSyncJob,
}));

vi.mock("@/lib/integrations/nango-db-workspace-diagnostic", () => ({
  logNangoDbWorkspaceDiagnostic: mocks.logNangoDbWorkspaceDiagnostic,
}));

vi.mock("@/lib/integrations/nango-service", async () => {
  const actual = await vi.importActual<
    typeof import("./nango-service")
  >("@/lib/integrations/nango-service");
  return {
    ...actual,
    getNangoConnectionDetails: mocks.getNangoConnectionDetails,
    getProviderConfigKey: mocks.getProviderConfigKey,
    startNangoSyncSchedules: mocks.startNangoSyncSchedules,
    triggerNangoSyncs: mocks.triggerNangoSyncs,
  };
});

vi.mock("@/lib/integrations/user-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("./user-integrations")
  >("@/lib/integrations/user-integrations");
  return {
    ...actual,
    deleteUserIntegration: mocks.deleteUserIntegration,
    findUserIntegrationByConnection: mocks.findUserIntegrationByConnection,
    upsertUserIntegration: mocks.upsertUserIntegration,
  };
});

vi.mock("@/lib/integrations/workspace-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("./workspace-integrations")
  >("@/lib/integrations/workspace-integrations");
  return {
    ...actual,
    deleteWorkspaceIntegration: mocks.deleteWorkspaceIntegration,
    findWorkspaceIntegrationByConnection:
      mocks.findWorkspaceIntegrationByConnection,
    findWorkspaceIntegrationByProviderAliasAndConnection:
      mocks.findWorkspaceIntegrationByProviderAliasAndConnection,
    getRecentWorkspaceIntegrationDisconnect:
      mocks.getRecentWorkspaceIntegrationDisconnect,
    insertWorkspaceIntegrationIfAbsent: mocks.insertWorkspaceIntegrationIfAbsent,
    recordWorkspaceIntegrationDisconnect:
      mocks.recordWorkspaceIntegrationDisconnect,
    upsertWorkspaceIntegration: mocks.upsertWorkspaceIntegration,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
  },
}));

describe("Nango webhook router sync and auth handling", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue({
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
    mocks.getProviderConfigKey.mockReturnValue("confluence-relay");
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getRecentWorkspaceIntegrationDisconnect.mockResolvedValue(null);
    mocks.insertWorkspaceIntegrationIfAbsent.mockResolvedValue({ inserted: true });
    mocks.findUserIntegrationByConnection.mockResolvedValue(null);
    mocks.recordWorkspaceIntegrationDisconnect.mockResolvedValue(undefined);
    mocks.deleteWorkspaceIntegration.mockResolvedValue(undefined);
    mocks.deleteUserIntegration.mockResolvedValue(undefined);
    mocks.markProviderInitialSyncQueued.mockResolvedValue(undefined);
    mocks.markProviderOAuthConnected.mockResolvedValue(undefined);
    mocks.enqueueNangoSyncJob.mockResolvedValue(undefined);
    mocks.startNangoSyncSchedules.mockResolvedValue({
      ok: true,
      syncs: ["fetch-active-issues"],
    });
    mocks.triggerNangoSyncs.mockResolvedValue({ ok: true });
    mocks.upsertWorkspaceIntegration.mockResolvedValue(undefined);
    mocks.upsertUserIntegration.mockResolvedValue(undefined);
  });

  it("marks readiness queued before enqueueing the Nango sync job", async () => {
    const order: string[] = [];
    mocks.markProviderInitialSyncQueued.mockImplementation(async () => {
      order.push("readiness");
    });
    mocks.enqueueNangoSyncJob.mockImplementation(async () => {
      order.push("enqueue");
    });
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "confluence-relay",
      connectionId: "conn-confluence-1",
      payload: {
        syncName: "fetch-pages",
        model: "ConfluencePage",
        modifiedAfter: "2026-05-19T10:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.findWorkspaceIntegrationByProviderAliasAndConnection).toHaveBeenCalledWith(
      "confluence",
      "conn-confluence-1",
    );
    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "confluence",
      providerConfigKey: "confluence-relay",
      syncName: "fetch-pages",
      model: "ConfluencePage",
      modifiedAfter: "2026-05-19T10:00:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "confluence",
      connectionId: "conn-confluence-1",
      providerConfigKey: "confluence-relay",
      syncName: "fetch-pages",
      model: "ConfluencePage",
      modifiedAfter: "2026-05-19T10:00:00.000Z",
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
    expect(order).toEqual(["readiness", "enqueue"]);
  });

  it("queues INITIAL sync jobs with no modifiedAfter lower bound", async () => {
    const { handleSyncEvent } = await import("./nango-webhook-router");
    const checkpoints = {
      from: null,
      to: { updatedAtCursor: "2026-06-17T18:14:27.563Z" },
    };
    const responseResults = { added: 20, updated: 0, deleted: 0 };

    await handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "linear-relay",
      connectionId: "conn-linear-1",
      payload: {
        syncName: "fetch-labels",
        model: "LinearLabel",
        syncType: "INITIAL",
        checkpoints,
        modifiedAfter: "2026-06-17T18:42:48.794Z",
        queryTimeStamp: "2026-06-17T18:42:48.794Z",
        responseResults,
        success: true,
      },
    });

    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "linear",
      providerConfigKey: "linear-relay",
      syncName: "fetch-labels",
      model: "LinearLabel",
      modifiedAfter: null,
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "linear",
      connectionId: "conn-linear-1",
      providerConfigKey: "linear-relay",
      syncName: "fetch-labels",
      model: "LinearLabel",
      modifiedAfter: null,
      syncType: "INITIAL",
      checkpoints,
      responseResults,
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("uses checkpoints.from instead of Nango query timestamp for incremental sync jobs", async () => {
    const { handleSyncEvent } = await import("./nango-webhook-router");
    const checkpoints = {
      from: { updatedAtCursor: "2026-06-17T17:10:00.000Z" },
      to: { updatedAtCursor: "2026-06-17T18:14:27.563Z" },
    };

    await handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "confluence-relay",
      connectionId: "conn-confluence-1",
      payload: {
        syncName: "fetch-pages",
        model: "ConfluencePage",
        syncType: "INCREMENTAL",
        checkpoints,
        modifiedAfter: "2026-06-17T18:42:48.794Z",
        queryTimeStamp: "2026-06-17T18:42:48.794Z",
        success: true,
      },
    });

    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "confluence",
      providerConfigKey: "confluence-relay",
      syncName: "fetch-pages",
      model: "ConfluencePage",
      modifiedAfter: "2026-06-17T17:10:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "confluence",
      connectionId: "conn-confluence-1",
      providerConfigKey: "confluence-relay",
      syncName: "fetch-pages",
      model: "ConfluencePage",
      modifiedAfter: "2026-06-17T17:10:00.000Z",
      syncType: "INCREMENTAL",
      checkpoints,
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("uses provider-specific checkpoints.from timestamp keys for incremental sync jobs", async () => {
    const { handleSyncEvent } = await import("./nango-webhook-router");
    const checkpoints = {
      from: { lastModifiedISO: "2026-06-17T16:30:00.000Z" },
      to: { lastModifiedISO: "2026-06-17T18:10:00.000Z" },
    };

    await handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-1",
      payload: {
        syncName: "fetch-repos",
        model: "Repo",
        syncType: "INCREMENTAL",
        checkpoints,
        modifiedAfter: "2026-06-17T18:42:48.794Z",
        success: true,
      },
    });

    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "github",
      providerConfigKey: "github-relay",
      syncName: "fetch-repos",
      model: "Repo",
      modifiedAfter: "2026-06-17T16:30:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "github",
      connectionId: "conn-github-1",
      providerConfigKey: "github-relay",
      syncName: "fetch-repos",
      model: "Repo",
      modifiedAfter: "2026-06-17T16:30:00.000Z",
      syncType: "INCREMENTAL",
      checkpoints,
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("falls back to payload modifiedAfter when checkpoints.from has no timestamp key", async () => {
    const { handleSyncEvent } = await import("./nango-webhook-router");
    const checkpoints = {
      from: { pageCursor: "opaque-provider-cursor" },
      to: { lastUpdated: "2026-06-17T18:10:00.000Z" },
    };

    await handleSyncEvent({
      from: "docker_hub-composio-relay",
      type: "sync",
      providerConfigKey: "docker_hub-composio-relay",
      connectionId: "conn-docker-hub-1",
      payload: {
        syncName: "fetch-repositories",
        model: "DockerHubRepository",
        syncType: "INCREMENTAL",
        checkpoints,
        modifiedAfter: "2026-06-17T17:25:00.000Z",
        success: true,
      },
    });

    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "docker-hub",
      providerConfigKey: "docker_hub-composio-relay",
      syncName: "fetch-repositories",
      model: "DockerHubRepository",
      modifiedAfter: "2026-06-17T17:25:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "docker-hub",
      connectionId: "conn-docker-hub-1",
      providerConfigKey: "docker_hub-composio-relay",
      syncName: "fetch-repositories",
      model: "DockerHubRepository",
      modifiedAfter: "2026-06-17T17:25:00.000Z",
      syncType: "INCREMENTAL",
      checkpoints,
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("maps Docker Hub Composio relay sync webhooks to the docker-hub workspace provider", async () => {
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue({
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "docker_hub-composio-relay",
      type: "sync",
      providerConfigKey: "docker_hub-composio-relay",
      connectionId: "conn-docker-hub-1",
      payload: {
        syncName: "fetch-repositories",
        model: "DockerHubRepository",
        modifiedAfter: "2026-05-22T18:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.findWorkspaceIntegrationByProviderAliasAndConnection).toHaveBeenCalledWith(
      "docker-hub",
      "conn-docker-hub-1",
    );
    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "docker-hub",
      providerConfigKey: "docker_hub-composio-relay",
      syncName: "fetch-repositories",
      model: "DockerHubRepository",
      modifiedAfter: "2026-05-22T18:00:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "docker-hub",
      connectionId: "conn-docker-hub-1",
      providerConfigKey: "docker_hub-composio-relay",
      syncName: "fetch-repositories",
      model: "DockerHubRepository",
      modifiedAfter: "2026-05-22T18:00:00.000Z",
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("maps Reddit Composio relay sync webhooks to the reddit workspace provider", async () => {
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue({
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "reddit-composio-relay",
      type: "sync",
      providerConfigKey: "reddit-composio-relay",
      connectionId: "conn-reddit-1",
      payload: {
        syncName: "fetch-posts",
        model: "RedditPost",
        modifiedAfter: "2026-05-29T12:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.findWorkspaceIntegrationByProviderAliasAndConnection).toHaveBeenCalledWith(
      "reddit",
      "conn-reddit-1",
    );
    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "reddit",
      providerConfigKey: "reddit-composio-relay",
      syncName: "fetch-posts",
      model: "RedditPost",
      modifiedAfter: "2026-05-29T12:00:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "reddit",
      connectionId: "conn-reddit-1",
      providerConfigKey: "reddit-composio-relay",
      syncName: "fetch-posts",
      model: "RedditPost",
      modifiedAfter: "2026-05-29T12:00:00.000Z",
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("maps Dropbox relay sync webhooks to the dropbox workspace provider", async () => {
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue({
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "dropbox-relay",
      type: "sync",
      providerConfigKey: "dropbox-relay",
      connectionId: "conn-dropbox-1",
      payload: {
        syncName: "fetch-files",
        model: "DropboxFile",
        modifiedAfter: "2026-05-25T08:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.findWorkspaceIntegrationByProviderAliasAndConnection).toHaveBeenCalledWith(
      "dropbox",
      "conn-dropbox-1",
    );
    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "dropbox",
      providerConfigKey: "dropbox-relay",
      syncName: "fetch-files",
      model: "DropboxFile",
      modifiedAfter: "2026-05-25T08:00:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "dropbox",
      connectionId: "conn-dropbox-1",
      providerConfigKey: "dropbox-relay",
      syncName: "fetch-files",
      model: "DropboxFile",
      modifiedAfter: "2026-05-25T08:00:00.000Z",
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("maps Neon Composio relay sync webhooks to the neon workspace provider", async () => {
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue({
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "neon-composio-relay",
      type: "sync",
      providerConfigKey: "neon-composio-relay",
      connectionId: "conn-neon-1",
      payload: {
        syncName: "fetch-topology",
        model: "NeonProject",
        modifiedAfter: "2026-06-17T12:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.findWorkspaceIntegrationByProviderAliasAndConnection).toHaveBeenCalledWith(
      "neon",
      "conn-neon-1",
    );
    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "55555555-5555-4555-8555-555555555555",
      provider: "neon",
      providerConfigKey: "neon-composio-relay",
      syncName: "fetch-topology",
      model: "NeonProject",
      modifiedAfter: "2026-06-17T12:00:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "neon",
      connectionId: "conn-neon-1",
      providerConfigKey: "neon-composio-relay",
      syncName: "fetch-topology",
      model: "NeonProject",
      modifiedAfter: "2026-06-17T12:00:00.000Z",
      cursor: null,
      workspaceId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("ignores sync webhooks for provider/sync/model triples absent from the generated Nango registry", async () => {
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "confluence-relay",
      connectionId: "conn-confluence-1",
      payload: {
        syncName: "fetch-pages",
        model: "Page",
        modifiedAfter: "2026-05-19T10:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.markProviderInitialSyncQueued).not.toHaveBeenCalled();
    expect(mocks.enqueueNangoSyncJob).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Nango sync webhook ignored unknown provider/sync/model",
      expect.objectContaining({
        providerConfigKey: "confluence-relay",
        syncName: "fetch-pages",
        model: "Page",
        source: "nango-integrations/.nango/nango.json",
      }),
    );
  });

  it("throws unresolved workspace sync webhooks so ingress retries instead of dropping records", async () => {
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue(null);
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await expect(handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "google-calendar-relay",
      connectionId: "conn-google-calendar-1",
      payload: {
        syncName: "fetch-calendars",
        model: "GoogleCalendar",
        modifiedAfter: "2026-07-01T10:00:00.000Z",
        success: true,
      },
    })).rejects.toThrow(
      "Nango sync webhook could not resolve workspace for google-calendar/conn-google-calendar-1/fetch-calendars/GoogleCalendar",
    );

    expect(mocks.markProviderInitialSyncQueued).not.toHaveBeenCalled();
    expect(mocks.enqueueNangoSyncJob).not.toHaveBeenCalled();
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "Nango sync webhook dropped records: could not resolve workspace",
      expect.objectContaining({
        event: "nango-sync-workspace-unresolved-dropped",
        provider: "google-calendar",
        connectionId: "conn-google-calendar-1",
        providerConfigKey: "google-calendar-relay",
        syncName: "fetch-calendars",
        model: "GoogleCalendar",
      }),
    );
  });

  it("records a disconnect tombstone when Nango reports an auth removal", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_deleted",
      connectionId: "conn-gmail-deleted",
      providerConfigKey: "google-mail-relay",
      installationId: null,
      metadata: {},
      createdAt: new Date("2026-05-20T00:00:00.000Z"),
      updatedAt: new Date("2026-05-20T00:00:00.000Z"),
    });
    const { handleAuthEvent } = await import("./nango-webhook-router");

    await handleAuthEvent({
      from: "google-mail",
      type: "auth",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-deleted",
      payload: {
        operation: "deleted",
        success: true,
      },
    });

    expect(mocks.recordWorkspaceIntegrationDisconnect).toHaveBeenCalledWith({
      workspaceId: "rw_deleted",
      provider: "google-mail",
      connectionId: "conn-gmail-deleted",
      providerConfigKey: "google-mail-relay",
    });
    expect(mocks.deleteWorkspaceIntegration).toHaveBeenCalledWith(
      "rw_deleted",
      "google-mail",
      null,
    );
    expect(
      mocks.recordWorkspaceIntegrationDisconnect.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.deleteWorkspaceIntegration.mock.invocationCallOrder[0],
    );
  });

  it("starts Nango sync schedules after a verified workspace auth webhook", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: null,
      payload: {
        endUser: {
          id: "rw_7ca2b192",
        },
      },
    });
    const { handleAuthEvent } = await import("./nango-webhook-router");

    await handleAuthEvent({
      from: "linear-relay",
      type: "auth",
      providerConfigKey: "linear-relay",
      connectionId: "conn-linear-1",
      payload: {
        operation: "creation",
        success: true,
        endUser: {
          id: "rw_7ca2b192",
        },
      },
    });

    expect(mocks.upsertWorkspaceIntegration).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_7ca2b192",
        provider: "linear",
        connectionId: "conn-linear-1",
        providerConfigKey: "linear-relay",
      }),
    );
    expect(mocks.markProviderOAuthConnected).toHaveBeenCalledWith({
      workspaceId: "rw_7ca2b192",
      provider: "linear",
      connectionId: "conn-linear-1",
      providerConfigKey: "linear-relay",
    });
    expect(mocks.startNangoSyncSchedules).toHaveBeenCalledWith({
      providerConfigKey: "linear-relay",
      connectionId: "conn-linear-1",
    });
    expect(
      mocks.upsertWorkspaceIntegration.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.startNangoSyncSchedules.mock.invocationCallOrder[0],
    );
    expect(
      mocks.markProviderOAuthConnected.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mocks.startNangoSyncSchedules.mock.invocationCallOrder[0],
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Nango sync schedules ensured",
      expect.objectContaining({
        workspaceId: "rw_7ca2b192",
        provider: "linear",
        connectionId: "conn-linear-1",
        providerConfigKey: "linear-relay",
        source: "auth",
        syncs: ["fetch-active-issues"],
      }),
    );
  });

  it("logs Nango sync schedule start failures without rolling back auth", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: null,
      payload: {
        endUser: {
          id: "rw_7ca2b192",
        },
      },
    });
    mocks.startNangoSyncSchedules.mockResolvedValue({
      ok: false,
      status: 400,
      payload: { error: "sync not found" },
      syncs: ["fetch-active-issues"],
    });
    const { handleAuthEvent } = await import("./nango-webhook-router");

    await handleAuthEvent({
      from: "linear-relay",
      type: "connection.created",
      providerConfigKey: "linear-relay",
      connectionId: "conn-linear-1",
      payload: {
        operation: "creation",
        success: true,
        endUser: {
          id: "rw_7ca2b192",
        },
      },
    });

    expect(mocks.upsertWorkspaceIntegration).toHaveBeenCalled();
    expect(mocks.markProviderOAuthConnected).toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Nango sync schedule start failed",
      expect.objectContaining({
        workspaceId: "rw_7ca2b192",
        provider: "linear",
        connectionId: "conn-linear-1",
        providerConfigKey: "linear-relay",
        source: "auth",
        syncs: ["fetch-active-issues"],
        status: 400,
        error: "sync not found",
      }),
    );
  });

  it("triggers Slack discovery syncs after auth so writeback has channel and user ids", async () => {
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue(null);
    mocks.getProviderConfigKey.mockReturnValue("slack-relay");
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: null,
      payload: {
        endUser: {
          id: "rw_7ca2b192",
        },
      },
    });
    mocks.startNangoSyncSchedules.mockResolvedValue({
      ok: true,
      syncs: ["fetch-channel-history", "fetch-users", "fetch-channels"],
    });
    const { handleAuthEvent } = await import("./nango-webhook-router");

    await handleAuthEvent({
      from: "slack",
      type: "connection.created",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        operation: "creation",
        success: true,
        endUser: {
          id: "rw_7ca2b192",
        },
      },
    });

    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      syncs: ["fetch-users", "fetch-channels"],
      syncMode: "full_refresh",
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Slack discovery sync triggered",
      expect.objectContaining({
        workspaceId: "rw_7ca2b192",
        provider: "slack",
        connectionId: "conn-slack-1",
        providerConfigKey: "slack-relay",
        source: "auth",
        syncs: ["fetch-users", "fetch-channels"],
      }),
    );
  });

  it("resolves Slack discovery sync webhooks through provider aliases", async () => {
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue({
      workspaceId: "rw_7ca2b192",
      provider: "slack-relay",
      connectionId: "conn-slack-1",
      providerConfigKey: "slack-relay",
      metadata: {},
    });
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "slack-relay",
      connectionId: "conn-slack-1",
      payload: {
        syncName: "fetch-channels",
        model: "SlackChannel",
        modifiedAfter: "2026-06-05T10:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.findWorkspaceIntegrationByProviderAliasAndConnection).toHaveBeenCalledWith(
      "slack",
      "conn-slack-1",
    );
    expect(mocks.getNangoConnectionDetails).not.toHaveBeenCalled();
    expect(mocks.markProviderInitialSyncQueued).toHaveBeenCalledWith({
      workspaceId: "rw_7ca2b192",
      provider: "slack",
      providerConfigKey: "slack-relay",
      syncName: "fetch-channels",
      model: "SlackChannel",
      modifiedAfter: "2026-06-05T10:00:00.000Z",
    });
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith({
      type: "nango_sync",
      provider: "slack",
      connectionId: "conn-slack-1",
      providerConfigKey: "slack-relay",
      syncName: "fetch-channels",
      model: "SlackChannel",
      modifiedAfter: "2026-06-05T10:00:00.000Z",
      cursor: null,
      workspaceId: "rw_7ca2b192",
    });
  });

  it("starts sync schedules when a sync webhook self-heals a missing workspace row", async () => {
    // A self-healed row means the auth-webhook path (the only schedule
    // starter before this) never ran for the connection — without starting
    // schedules here, the workspace only ever sees the single sync that
    // triggered the self-heal (the /github-only class).
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue(null);
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: null,
      payload: {
        endUser: {
          id: "rw_7ca2b192",
        },
      },
    });
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "confluence-relay",
      connectionId: "conn-confluence-healed",
      payload: {
        syncName: "fetch-pages",
        model: "ConfluencePage",
        modifiedAfter: "2026-06-04T10:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.insertWorkspaceIntegrationIfAbsent).toHaveBeenCalled();
    expect(mocks.startNangoSyncSchedules).toHaveBeenCalledWith(
      expect.objectContaining({
        providerConfigKey: "confluence-relay",
        connectionId: "conn-confluence-healed",
      }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Nango sync schedules ensured",
      expect.objectContaining({
        workspaceId: "rw_7ca2b192",
        provider: "confluence",
        connectionId: "conn-confluence-healed",
        source: "self-heal",
      }),
    );
    expect(mocks.enqueueNangoSyncJob).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "nango_sync",
        connectionId: "conn-confluence-healed",
        workspaceId: "rw_7ca2b192",
      }),
    );
  });

  it("does not self-heal a sync webhook for a recently disconnected Google Mail connection", async () => {
    mocks.findWorkspaceIntegrationByProviderAliasAndConnection.mockResolvedValue(null);
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: null,
      payload: {
        endUser: {
          id: "rw_fc7b534b",
        },
      },
    });
    mocks.getRecentWorkspaceIntegrationDisconnect.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      connectionId: "conn-gmail-deleted",
      providerConfigKey: "google-mail-relay",
      disconnectedAt: new Date("2026-05-20T00:00:00.000Z"),
      expiresAt: new Date("2026-05-27T00:00:00.000Z"),
      createdAt: new Date("2026-05-20T00:00:00.000Z"),
      updatedAt: new Date("2026-05-20T00:00:00.000Z"),
    });
    const { handleSyncEvent } = await import("./nango-webhook-router");

    await handleSyncEvent({
      from: "nango",
      type: "sync",
      providerConfigKey: "google-mail-relay",
      connectionId: "conn-gmail-deleted",
      payload: {
        syncName: "fetch-messages",
        model: "GoogleMailMessage",
        modifiedAfter: "2026-05-20T10:00:00.000Z",
        success: true,
      },
    });

    expect(mocks.getRecentWorkspaceIntegrationDisconnect).toHaveBeenCalledWith({
      workspaceId: "rw_fc7b534b",
      provider: "google-mail",
      connectionId: "conn-gmail-deleted",
    });
    expect(mocks.insertWorkspaceIntegrationIfAbsent).not.toHaveBeenCalled();
    expect(mocks.markProviderInitialSyncQueued).not.toHaveBeenCalled();
    expect(mocks.enqueueNangoSyncJob).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Nango sync webhook self-heal skipped: connection was explicitly disconnected",
      expect.objectContaining({
        provider: "google-mail",
        workspaceId: "rw_fc7b534b",
        connectionId: "conn-gmail-deleted",
      }),
    );
  });
});
