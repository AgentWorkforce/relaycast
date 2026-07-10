import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchIntegrationWatchEvent: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getProviderConfigKey: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  resolveAppWorkspaceIdForRelayRuntime: vi.fn(),
  resolveAppWorkspaceIdForRuntime: vi.fn(),
  triggerNangoSyncs: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@nangohq/node", () => ({
  Nango: vi.fn(function Nango() {
    return {
      proxy: vi.fn(),
    };
  }),
}));

vi.mock("@cloud/core/provider-readiness.js", () => ({
  markProviderInitialSyncComplete: vi.fn(),
  markProviderInitialSyncFailed: vi.fn(),
  markProviderInitialSyncQueued: vi.fn(),
  markProviderOAuthConnected: vi.fn(),
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
  enqueueNangoSyncJob: vi.fn(),
}));

vi.mock("@/lib/integrations/github-relayfile", async () => {
  const actual = await vi.importActual<
    typeof import("./github-relayfile")
  >("@/lib/integrations/github-relayfile");
  return {
    ...actual,
    createGitHubRelayfileClient: vi.fn(() => ({ mocked: "relayfile-client" })),
  };
});

vi.mock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
  dispatchIntegrationWatchEvent: mocks.dispatchIntegrationWatchEvent,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveAppWorkspaceIdForRelayRuntime:
    mocks.resolveAppWorkspaceIdForRelayRuntime,
  resolveAppWorkspaceIdForRuntime: mocks.resolveAppWorkspaceIdForRuntime,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity-core", () => ({
  resolveAppWorkspaceIdForRelayRuntime:
    mocks.resolveAppWorkspaceIdForRelayRuntime,
  resolveAppWorkspaceIdForRuntime: mocks.resolveAppWorkspaceIdForRuntime,
}));

vi.mock("@/lib/integrations/nango-service", async () => {
  const actual = await vi.importActual<
    typeof import("./nango-service")
  >("@/lib/integrations/nango-service");
  return {
    ...actual,
    getProviderConfigKey: mocks.getProviderConfigKey,
    getNangoConnectionDetails: mocks.getNangoConnectionDetails,
    getNangoSecretKey: mocks.getNangoSecretKey,
    triggerNangoSyncs: mocks.triggerNangoSyncs,
  };
});

vi.mock("@/lib/integrations/workspace-integrations", async () => {
  const actual = await vi.importActual<
    typeof import("./workspace-integrations")
  >("@/lib/integrations/workspace-integrations");
  return {
    ...actual,
    findWorkspaceIntegrationByConnection:
      mocks.findWorkspaceIntegrationByConnection,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

describe("Granola forward webhooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-granola-1",
      providerConfigKey: "granola-relay",
    });
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("granola-relay");
    mocks.resolveAppWorkspaceIdForRuntime.mockResolvedValue(
      "55555555-5555-4555-8555-555555555555",
    );
    mocks.resolveAppWorkspaceIdForRelayRuntime.mockResolvedValue(
      "55555555-5555-4555-8555-555555555555",
    );
    mocks.triggerNangoSyncs.mockResolvedValue({ ok: true });
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 0,
      delivered: 0,
      failed: 0,
    });
  });

  it("triggers incremental Granola syncs and emits note/folder watch events", async () => {
    const payload = { object: "note", id: "not_123" };
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "granola",
      type: "forward",
      providerConfigKey: "granola-relay",
      connectionId: "conn-granola-1",
      payload,
    });

    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "granola",
      "conn-granola-1",
    );
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "granola-relay",
      connectionId: "conn-granola-1",
      syncs: ["fetch-notes", "fetch-folders"],
      syncMode: "incremental",
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "granola",
        connectionId: "conn-granola-1",
        payload,
      }),
    );
    expect(
      mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.triggerNangoSyncs.mock.invocationCallOrder[0]);
  });

  it("warns and skips when connectionId is missing", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "granola",
      type: "forward",
      providerConfigKey: "granola-relay",
      connectionId: null,
      payload: {},
    });

    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Granola forward webhook received without a connection id",
      expect.any(Object),
    );
  });
});
