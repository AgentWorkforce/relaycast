import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findWorkspaceIntegrationByProviderMetadataValue: vi.fn(),
  getConnection: vi.fn(),
  listAllWorkspaceIntegrationsForProvider: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  routeNangoWebhook: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoClient: vi.fn(() => ({
    getConnection: mocks.getConnection,
  })),
}));

vi.mock("@/lib/integrations/nango-webhook-router", () => ({
  routeNangoWebhook: mocks.routeNangoWebhook,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findWorkspaceIntegrationByProviderMetadataValue:
    mocks.findWorkspaceIntegrationByProviderMetadataValue,
  listAllWorkspaceIntegrationsForProvider:
    mocks.listAllWorkspaceIntegrationsForProvider,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

import {
  handleCloudflareHookdeckWebhook,
  looksLikeCloudflareWebhook,
} from "./cloudflare-hookdeck-webhook";

function notificationPayload() {
  return {
    account_id: "f7232cb80f6fab86a95426302af243e4",
    alert_type: "workers_alert",
    alert_event: "WORKERS_ANOMALY_DETECTED_START",
    alert_correlation_id: "corr-1",
    policy_id: "workers-alerts",
    policy_name: "Workers alerts",
    ts: 1781681184,
    text: "relayfile request anomalies detected",
    data: {
      zone_tag: "a647241ae955e711b22a421e623db733",
      zone_name: "relayfile.dev",
    },
  };
}

function testPayload() {
  return {
    text: "Hello World! This is a test message sent from https://cloudflare.com. If you can see this, your webhook is configured properly.",
  };
}

describe("cloudflare-hookdeck-webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findWorkspaceIntegrationByProviderMetadataValue.mockResolvedValue({
      workspaceId: "rw_fc7b534b",
      connectionId: "conn-cloudflare-1",
      providerConfigKey: "cloudflare-relay",
      metadata: {
        accountId: "f7232cb80f6fab86a95426302af243e4",
      },
    });
    mocks.listAllWorkspaceIntegrationsForProvider.mockResolvedValue([
      {
        workspaceId: "rw_fc7b534b",
        connectionId: "conn-cloudflare-1",
        providerConfigKey: "cloudflare-relay",
        metadata: {
          accountId: "f7232cb80f6fab86a95426302af243e4",
        },
      },
    ]);
    mocks.routeNangoWebhook.mockResolvedValue(undefined);
    mocks.getConnection.mockResolvedValue({ metadata: {} });
  });

  it("recognizes Cloudflare notification webhooks", () => {
    expect(looksLikeCloudflareWebhook(JSON.stringify(notificationPayload()))).toBe(true);
  });

  it("recognizes Cloudflare generic test webhooks", () => {
    expect(looksLikeCloudflareWebhook(JSON.stringify(testPayload()))).toBe(true);
  });

  it("routes a Hookdeck Cloudflare notification through the existing forward path", async () => {
    const rawBody = JSON.stringify(notificationPayload());

    const result = await handleCloudflareHookdeckWebhook(
      rawBody,
      new Headers({
        "content-type": "application/json",
      }),
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.response.status).toBe(200);
      await expect(result.response.json()).resolves.toEqual({
        accepted: true,
        type: "workers_alert",
        ingress: "hookdeck",
      });
    }
    expect(mocks.findWorkspaceIntegrationByProviderMetadataValue).toHaveBeenCalledWith(
      "cloudflare",
      ["accountId", "account_id"],
      "f7232cb80f6fab86a95426302af243e4",
    );
    expect(mocks.listAllWorkspaceIntegrationsForProvider).not.toHaveBeenCalled();
    expect(mocks.routeNangoWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "cloudflare",
        type: "forward",
        providerConfigKey: "cloudflare-relay",
        connectionId: "conn-cloudflare-1",
        payload: expect.objectContaining({
          deliveryId: "corr-1",
          request: expect.objectContaining({
            body: expect.objectContaining({
              account_id: "f7232cb80f6fab86a95426302af243e4",
              alert_type: "workers_alert",
            }),
          }),
        }),
      }),
    );
  });

  it("accepts Cloudflare generic test webhooks without routing", async () => {
    const rawBody = JSON.stringify(testPayload());

    const result = await handleCloudflareHookdeckWebhook(
      rawBody,
      new Headers({
        "content-type": "application/json",
      }),
    );

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.response.status).toBe(200);
      await expect(result.response.json()).resolves.toEqual({
        accepted: true,
        provider: "cloudflare",
        ingress: "hookdeck",
        routed: false,
        type: "cloudflare.webhook_test",
      });
    }
    expect(mocks.findWorkspaceIntegrationByProviderMetadataValue).not.toHaveBeenCalled();
    expect(mocks.listAllWorkspaceIntegrationsForProvider).not.toHaveBeenCalled();
    expect(mocks.routeNangoWebhook).not.toHaveBeenCalled();
  });

  it("falls back to an uncapped provider scan when local metadata lookup misses", async () => {
    mocks.findWorkspaceIntegrationByProviderMetadataValue.mockResolvedValueOnce(null);
    mocks.getConnection.mockResolvedValueOnce({
      metadata: {
        accountId: "f7232cb80f6fab86a95426302af243e4",
      },
    });

    const rawBody = JSON.stringify(notificationPayload());

    const result = await handleCloudflareHookdeckWebhook(
      rawBody,
      new Headers({
        "content-type": "application/json",
      }),
    );

    expect(result.handled).toBe(true);
    expect(mocks.listAllWorkspaceIntegrationsForProvider).toHaveBeenCalledWith("cloudflare");
    expect(mocks.getConnection).toHaveBeenCalledWith(
      "cloudflare-relay",
      "conn-cloudflare-1",
    );
    expect(mocks.routeNangoWebhook).toHaveBeenCalled();
  });
});
