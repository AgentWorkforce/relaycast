import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatchIntegrationWatchEvent: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getProviderConfigKey: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  writeBatchToRelayfile: vi.fn(),
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
  writeProviderReadiness: vi.fn(),
}));

vi.mock("@cloud/core/sync/record-writer.js", () => ({
  buildDeletionRecord: vi.fn((id: string, metadata: Record<string, unknown>) => ({
    id,
    _deleted: true,
    ...metadata,
  })),
  createWebhookSyncJob: vi.fn((job: Record<string, unknown>) => job),
  writeBatchToRelayfile: mocks.writeBatchToRelayfile,
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
    error: mocks.loggerError,
  },
}));

describe("Fathom forward webhooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-fathom-1",
      providerConfigKey: "fathom-relay",
    });
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("fathom-relay");
    mocks.writeBatchToRelayfile.mockResolvedValue({
      written: 1,
      deleted: 0,
      errors: 0,
    });
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 0,
      delivered: 0,
      failed: 0,
    });
  });

  it("materializes meeting, summary, and transcript files via writeBatchToRelayfile", async () => {
    const payload = {
      recording_id: 123456789,
      title: "Quarterly Business Review",
      meeting_title: "QBR 2025 Q1",
      url: "https://fathom.video/xyz123",
      share_url: "https://fathom.video/share/xyz123",
      created_at: "2026-05-25T10:00:00.000Z",
      default_summary: {
        template_name: "general",
        markdown_formatted: "## Summary\nDemo\n",
      },
      transcript: [],
    };
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "fathom",
      type: "forward",
      providerConfigKey: "fathom-relay",
      connectionId: "conn-fathom-1",
      payload,
    });

    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "fathom",
      "conn-fathom-1",
    );
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(3);

    const models = mocks.writeBatchToRelayfile.mock.calls.map((call) => call[2].model);
    expect(models).toEqual([
      "FathomMeeting",
      "FathomRecordingSummary",
      "FathomRecordingTranscript",
    ]);

    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "fathom",
        connectionId: "conn-fathom-1",
      }),
    );
    expect(
      mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeBatchToRelayfile.mock.invocationCallOrder[0]);
  });

  it("warns and skips when connectionId is missing", async () => {
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "fathom",
      type: "forward",
      providerConfigKey: "fathom-relay",
      connectionId: null,
      payload: {},
    });

    expect(mocks.writeBatchToRelayfile).not.toHaveBeenCalled();
    expect(mocks.dispatchIntegrationWatchEvent).not.toHaveBeenCalled();
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      "Fathom forward webhook received without a connection id",
      expect.any(Object),
    );
  });
});
