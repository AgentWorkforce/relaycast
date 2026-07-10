import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  listWorkspaceIntegrationsForProvider: vi.fn(),
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
  listWorkspaceIntegrationsForProvider: mocks.listWorkspaceIntegrationsForProvider,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  },
}));

import {
  handleGcpHookdeckWebhook,
  looksLikeGcpWebhook,
} from "./gcp-hookdeck-webhook";

function monitoringEnvelope(subscriptionName = "projects/nightcto-production/subscriptions/nango-gcp-monitoring-conn-gcp-1") {
  return {
    subscription: subscriptionName,
    message: {
      messageId: "msg-gcp-1",
      data: Buffer.from(
        JSON.stringify({
          incident: {
            policy_name: "projects/nightcto-production/alertPolicies/17163008471956214188",
            condition_name: "relay-entrypoint ERROR logs",
            state: "open",
            started_at: 1781681184,
          },
        }),
      ).toString("base64"),
    },
  };
}

describe("gcp-hookdeck-webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listWorkspaceIntegrationsForProvider.mockResolvedValue([
      {
        workspaceId: "rw_fc7b534b",
        connectionId: "conn-gcp-1",
        providerConfigKey: "gcp-relay",
        metadata: {
          gcpMonitoringPubsubSubscriptionName:
            "projects/nightcto-production/subscriptions/nango-gcp-monitoring-conn-gcp-1",
        },
      },
    ]);
    mocks.routeNangoWebhook.mockResolvedValue(undefined);
    mocks.getConnection.mockResolvedValue({ metadata: {} });
  });

  it("recognizes GCP Pub/Sub monitoring envelopes", () => {
    expect(looksLikeGcpWebhook(JSON.stringify(monitoringEnvelope()))).toBe(true);
  });

  it("routes a Hookdeck Pub/Sub envelope through the existing GCP forward path", async () => {
    const rawBody = JSON.stringify(monitoringEnvelope());

    const result = await handleGcpHookdeckWebhook(rawBody, new Headers({
      "content-type": "application/json",
    }));

    expect(result.handled).toBe(true);
    if (result.handled) {
      expect(result.response.status).toBe(200);
      await expect(result.response.json()).resolves.toEqual({
        accepted: true,
        type: "monitoring.incident.open",
        ingress: "hookdeck",
      });
    }
    expect(mocks.listWorkspaceIntegrationsForProvider).toHaveBeenCalledWith("gcp");
    expect(mocks.routeNangoWebhook).toHaveBeenCalledWith(
      expect.objectContaining({
        from: "gcp",
        type: "forward",
        providerConfigKey: "gcp-relay",
        connectionId: "conn-gcp-1",
        payload: expect.objectContaining({
          deliveryId: "msg-gcp-1",
          request: expect.objectContaining({
            body: expect.objectContaining({
              subscription:
                "projects/nightcto-production/subscriptions/nango-gcp-monitoring-conn-gcp-1",
            }),
          }),
        }),
      }),
    );
  });
});
