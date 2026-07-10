import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchIntegrationWatchEvent: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getProviderConfigKey: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
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

describe("Dropbox forward webhooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-dropbox-1",
      providerConfigKey: "dropbox-relay",
    });
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("dropbox-relay");
    mocks.triggerNangoSyncs.mockResolvedValue({ ok: true });
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 0,
      delivered: 0,
      failed: 0,
    });
  });

  it("triggers incremental Dropbox syncs and emits watch events", async () => {
    const payload = {
      list_folder: {
        accounts: ["dbid:AAH4f99T0taONIb-OurWxbNQ6ywGRopQngc"],
      },
    };
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "dropbox",
      type: "forward",
      providerConfigKey: "dropbox-relay",
      connectionId: "conn-dropbox-1",
      payload,
    });

    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "dropbox",
      "conn-dropbox-1",
    );
    expect(mocks.triggerNangoSyncs).toHaveBeenCalledWith({
      providerConfigKey: "dropbox-relay",
      connectionId: "conn-dropbox-1",
      syncs: [
        "fetch-files",
        "fetch-folders",
        "fetch-shared-folders",
        "fetch-shared-links",
      ],
      syncMode: "incremental",
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "dropbox",
        connectionId: "conn-dropbox-1",
      }),
    );
    expect(
      mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.triggerNangoSyncs.mock.invocationCallOrder[0]);
  });

  it("warns and skips when connectionId is missing", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "dropbox",
      type: "forward",
      providerConfigKey: "dropbox-relay",
      connectionId: null,
      payload: {},
    });

    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Dropbox forward webhook received without a connection id",
      expect.any(Object),
    );
  });
});
