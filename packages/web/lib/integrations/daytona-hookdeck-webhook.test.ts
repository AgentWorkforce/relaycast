import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claimWebhookDelivery: vi.fn(),
  dispatchIntegrationWatchEvent: vi.fn(),
  getNangoClient: vi.fn(),
  getProviderConfigKey: vi.fn(),
  listWorkspaceIntegrationsForProvider: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  releaseWebhookDelivery: vi.fn(),
  findWorkspaceIntegrationByConnection: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: mocks.getNangoClient,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

vi.mock("@/lib/ricky/webhook-dedup", () => ({
  claimWebhookDelivery: mocks.claimWebhookDelivery,
  releaseWebhookDelivery: mocks.releaseWebhookDelivery,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceIntegrationByConnection: mocks.findWorkspaceIntegrationByConnection,
  listWorkspaceIntegrationsForProvider: mocks.listWorkspaceIntegrationsForProvider,
}));

vi.mock("@/lib/proactive-runtime/integration-watch-dispatcher", () => ({
  dispatchIntegrationWatchEvent: mocks.dispatchIntegrationWatchEvent,
}));

import {
  handleDaytonaHookdeckWebhook,
  looksLikeDaytonaWebhook,
} from "./daytona-hookdeck-webhook";

function hookdeckHeaders(): Headers {
  return new Headers({
    "x-hookdeck-signature": "signature",
  });
}

function daytonaPayload(overrides: Record<string, unknown> = {}) {
  return {
    event: "sandbox.state.updated",
    id: "sbx_1",
    organizationId: "org_1",
    timestamp: "2026-05-01T00:00:00.000Z",
    newState: "error",
    ...overrides,
  };
}

describe("Daytona hookdeck webhook handling", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.claimWebhookDelivery.mockResolvedValue(true);
    mocks.dispatchIntegrationWatchEvent.mockResolvedValue({
      matched: 1,
      delivered: 1,
      failed: 0,
    });
    mocks.getProviderConfigKey.mockReturnValue("daytona-relay");
    mocks.listWorkspaceIntegrationsForProvider.mockResolvedValue([
      {
        workspaceId: "ws_daytona",
        provider: "daytona",
        connectionId: "conn_daytona",
        providerConfigKey: "daytona-relay",
      },
    ]);
    mocks.getNangoClient.mockReturnValue({
      getConnection: vi.fn().mockResolvedValue({
        metadata: {
          organizationId: "org_1",
        },
      }),
    });
  });

  it("recognizes Daytona webhook payloads", () => {
    expect(looksLikeDaytonaWebhook(daytonaPayload())).toBe(true);
    expect(looksLikeDaytonaWebhook({ event: "unknown", id: "1" })).toBe(false);
  });

  it("dispatches sandbox.state.updated error events as incidents", async () => {
    const response = await handleDaytonaHookdeckWebhook(
      JSON.stringify(daytonaPayload()),
      hookdeckHeaders(),
    );

    expect(response.handled).toBe(true);
    if (!response.handled) return;

    expect(response.response.status).toBe(200);
    await expect(response.response.json()).resolves.toEqual({
      accepted: true,
      type: "sandbox.state.updated",
      ingress: "hookdeck",
    });
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
        deliveryId: "sbx_1:sandbox.state.updated:2026-05-01T00:00:00.000Z",
        paths: ["/daytona/sandboxes/sbx_1.json"],
        payload: expect.objectContaining({
          id: "sbx_1",
          organizationId: "org_1",
          newState: "error",
        }),
      }),
    );
    expect(mocks.releaseWebhookDelivery).not.toHaveBeenCalled();
  });

  it("returns duplicate when the same delivery is replayed", async () => {
    mocks.claimWebhookDelivery
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    const first = await handleDaytonaHookdeckWebhook(
      JSON.stringify(daytonaPayload()),
      hookdeckHeaders(),
    );
    const second = await handleDaytonaHookdeckWebhook(
      JSON.stringify(daytonaPayload()),
      hookdeckHeaders(),
    );

    expect(first.handled).toBe(true);
    expect(second.handled).toBe(true);
    if (!second.handled) return;

    await expect(second.response.json()).resolves.toEqual({
      accepted: true,
      type: "sandbox.state.updated",
      ingress: "hookdeck",
      duplicate: true,
    });
    expect(mocks.dispatchIntegrationWatchEvent).toHaveBeenCalledTimes(1);
  });
});
