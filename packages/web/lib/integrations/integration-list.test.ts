import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloud/core/provider-readiness.js", async () => {
  return import("../../../core/src/provider-readiness.ts");
});

vi.mock("@cloud/core/sync/nango-provider-parity.js", async () => {
  return import("../../../core/src/sync/nango-provider-parity.ts");
});

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintScopedRelayfileToken: vi.fn(async () => "relayfile-token"),
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayfileConfig: () => ({
    relayfileUrl: "https://relayfile.test",
    relayAuthUrl: "https://relayauth.test",
    relayAuthApiKey: "relayauth-key",
  }),
}));

import { buildIntegrationListEntry } from "./integration-list";

function slackReadinessByModel(overrides: {
  channelHistory?: "queued" | "running" | "complete" | "failed";
  users?: "queued" | "running" | "complete" | "failed";
  channels?: "queued" | "running" | "complete" | "failed";
}) {
  const model = (
    state: "queued" | "running" | "complete" | "failed",
    syncName: string,
    modelName: string,
    completedAt: string | null,
  ) => ({
    state,
    providerConfigKey: "slack-relay",
    enqueuedAt: null,
    startedAt: null,
    completedAt,
    failedAt: null,
    lastError: null,
    syncName,
    model: modelName,
    modifiedAfter: null,
  });

  return {
    _relayfileProviderReadiness: {
      connectionId: "conn_slack",
      providerConfigKey: "slack-relay",
      updatedAt: "2026-05-02T10:00:04.000Z",
      initialSync: {
        state: "running",
        byModel: {
          "slack-relay:fetch-channel-history:SlackMessage": model(
            overrides.channelHistory ?? "complete",
            "fetch-channel-history",
            "SlackMessage",
            "2026-05-02T10:00:02.000Z",
          ),
          "slack-relay:fetch-users:SlackUser": model(
            overrides.users ?? "complete",
            "fetch-users",
            "SlackUser",
            "2026-05-02T10:00:03.000Z",
          ),
          "slack-relay:fetch-channels:SlackChannel": model(
            overrides.channels ?? "complete",
            "fetch-channels",
            "SlackChannel",
            overrides.channels === "running"
              ? null
              : "2026-05-02T10:00:04.000Z",
          ),
        },
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildIntegrationListEntry", () => {
  it("marks Slack ready after every generated enabled model completes and falls back to readiness lastEventAt", async () => {
    await expect(
      buildIntegrationListEntry({
        provider: "slack",
        connectionId: "conn_slack",
        providerConfigKey: "slack-relay",
        metadata: slackReadinessByModel({}),
      }),
    ).resolves.toMatchObject({
      provider: "slack",
      status: "ready",
      lastEventAt: "2026-05-02T10:00:04.000Z",
      connectionId: "conn_slack",
    });
  });

  it("keeps Slack syncing while an expected generated model is still active", async () => {
    await expect(
      buildIntegrationListEntry({
        provider: "slack",
        connectionId: "conn_slack",
        providerConfigKey: "slack-relay",
        metadata: slackReadinessByModel({ channels: "running" }),
      }),
    ).resolves.toMatchObject({
      provider: "slack",
      status: "syncing",
    });
  });

  it("does not use a Relayfile watermark to mark model-aware Slack readiness ready before every expected model completes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({
        providers: [
          {
            provider: "slack",
            status: "healthy",
            lagSeconds: 0,
            watermarkTs: "2026-05-02T10:00:03.000Z",
          },
        ],
      }), { status: 200 })),
    );

    await expect(
      buildIntegrationListEntry({
        workspaceId: "workspace-1",
        provider: "slack",
        connectionId: "conn_slack",
        providerConfigKey: "slack-relay",
        metadata: slackReadinessByModel({ channels: "running" }),
      }),
    ).resolves.toMatchObject({
      provider: "slack",
      status: "syncing",
      lastEventAt: "2026-05-02T10:00:03.000Z",
    });
  });
});
