import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimWebhookDelivery: vi.fn(),
  dispatchIntegrationWatchEvent: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getNangoSecretKey: vi.fn(),
  getProviderConfigKey: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  releaseWebhookDelivery: vi.fn(),
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

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: vi.fn(),
  },
}));

vi.mock("@/lib/ricky/webhook-dedup", () => ({
  claimWebhookDelivery: mocks.claimWebhookDelivery,
  releaseWebhookDelivery: mocks.releaseWebhookDelivery,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceIntegrationByConnection: mocks.findWorkspaceIntegrationByConnection,
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

vi.mock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
  dispatchIntegrationWatchEvent: mocks.dispatchIntegrationWatchEvent,
}));

import { routeNangoWebhook } from "./nango-webhook-router";

function daytonaEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    from: "daytona",
    type: "forward",
    providerConfigKey: "daytona-relay",
    connectionId: "conn_daytona",
    payload: {
      event: "sandbox.state.updated",
      id: "sbx_1",
      organizationId: "org_1",
      timestamp: "2026-05-01T00:00:00.000Z",
      newState: "error",
      ...overrides,
    },
  };
}

describe("Daytona forward webhook routing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.claimWebhookDelivery.mockResolvedValue(true);
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    mocks.findWorkspaceIntegrationByConnection.mockResolvedValue({
      workspaceId: "ws_daytona",
      connectionId: "conn_daytona",
      providerConfigKey: "daytona-relay",
    });
    mocks.getNangoConnectionDetails.mockResolvedValue(null);
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.getProviderConfigKey.mockReturnValue("daytona-relay");
    mocks.triggerNangoSyncs.mockResolvedValue({ ok: true });
  });

  it("routes Daytona forward payloads into the integration watch dispatcher", async () => {
    await routeNangoWebhook(daytonaEnvelope());

    expect(mocks.findWorkspaceIntegrationByConnection).toHaveBeenCalledWith(
      "daytona",
      "conn_daytona",
    );
    expect(mocks.claimWebhookDelivery).toHaveBeenCalledWith({
      surface: "daytona",
      deliveryId: "sbx_1:sandbox.state.updated:2026-05-01T00:00:00.000Z",
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws_daytona",
        provider: "daytona",
        eventType: "incident",
        connectionId: "conn_daytona",
        paths: ["/daytona/sandboxes/sbx_1.json"],
        payload: expect.objectContaining({
          id: "sbx_1",
          organizationId: "org_1",
          newState: "error",
        }),
      }),
    );
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      "Daytona webhook accepted",
      expect.objectContaining({
        area: "daytona-webhook",
        workspaceId: "ws_daytona",
      }),
    );
  });
});
