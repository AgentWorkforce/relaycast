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
  triggerNangoSyncs: vi.fn(),
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
    error: mocks.loggerError,
  },
}));

describe("Cloudflare forward webhooks", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();

    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-cloudflare-1",
      providerConfigKey: "cloudflare-relay",
    });
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("cloudflare-relay");
    mocks.triggerNangoSyncs.mockResolvedValue({
      ok: true,
    });
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

  it("materializes notification events via writeBatchToRelayfile", async () => {
    const payload = {
      alert_type: "workers_alert",
      alert_event: "WORKERS_ANOMALY_DETECTED_START",
      alert_correlation_id: "corr-1",
      policy_id: "workers-alerts",
      policy_name: "Workers alerts",
      text: "relayfile request anomalies detected",
      ts: 1781681184,
      data: {
        zone_tag: "zone-1",
        zone_name: "relayfile.dev",
      },
    };
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "cloudflare",
      type: "forward",
      providerConfigKey: "cloudflare-relay",
      connectionId: "conn-cloudflare-1",
      payload,
    });

    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "cloudflare",
      "conn-cloudflare-1",
    );
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledTimes(1);
    expect(mocks.triggerNangoSyncs).not.toHaveBeenCalled();
    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          id: "corr-1",
          alert_type: "workers_alert",
          alert_event: "WORKERS_ANOMALY_DETECTED_START",
          state: "active",
          source: "cloudflare",
          kind: "runtime",
        }),
      ],
      expect.objectContaining({
        provider: "cloudflare",
        syncName: "fetch-notification-events",
        model: "CloudflareNotificationEvent",
      }),
    );
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_fc7b534b",
        provider: "cloudflare",
        eventType: "workers_alert",
        connectionId: "conn-cloudflare-1",
        paths: ["/cloudflare/notifications/events/corr-1.json"],
      }),
    );
    expect(
      mocks.dispatchIntegrationWatchEvent.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.writeBatchToRelayfile.mock.invocationCallOrder[0]);
  });

  it("preserves resolved notification events instead of deleting the canonical record", async () => {
    const payload = {
      alert_type: "workers_alert",
      alert_event: "WORKERS_ANOMALY_DETECTED_END",
      alert_correlation_id: "corr-1",
      policy_id: "workers-alerts",
      policy_name: "Workers alerts",
      ts: 1781681284,
      data: {
        zone_tag: "zone-1",
        zone_name: "relayfile.dev",
      },
    };
    const { routeNangoWebhook } = await import("./nango-webhook-router");

    await routeNangoWebhook({
      from: "cloudflare",
      type: "forward",
      providerConfigKey: "cloudflare-relay",
      connectionId: "conn-cloudflare-1",
      payload,
    });

    expect(mocks.writeBatchToRelayfile).toHaveBeenCalledWith(
      expect.anything(),
      [
        expect.objectContaining({
          id: "corr-1",
          state: "resolved",
          severity: "low",
        }),
      ],
      expect.objectContaining({
        provider: "cloudflare",
        model: "CloudflareNotificationEvent",
      }),
    );
    expect(mocks.writeBatchToRelayfile.mock.calls[0][1][0]).not.toHaveProperty(
      "_deleted",
    );
  });
});
