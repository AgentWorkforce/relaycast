import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureError: vi.fn(),
  handleDaytonaHookdeckWebhook: vi.fn(),
  handleGcpHookdeckWebhook: vi.fn(),
  handleCloudflareHookdeckWebhook: vi.fn(),
  handleRecallHookdeckWebhook: vi.fn(),
  getNangoSecretKey: vi.fn(),
  handleGitLabHookdeckWebhook: vi.fn(),
  looksLikeGitLabWebhook: vi.fn(),
  looksLikeDaytonaWebhook: vi.fn(),
  looksLikeGcpWebhook: vi.fn(),
  looksLikeCloudflareWebhook: vi.fn(),
  looksLikeRecallWebhook: vi.fn(),
  optionalEnv: vi.fn(),
  parseNangoWebhookEnvelope: vi.fn(),
  routeNangoWebhook: vi.fn(),
  tryResourceValue: vi.fn(),
  verifyNangoWebhookSignature: vi.fn(),
  RelayfilePrimaryWriteError: class RelayfilePrimaryWriteError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "RelayfilePrimaryWriteError";
    }
  },
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoSecretKey: mocks.getNangoSecretKey,
}));

vi.mock("@/lib/integrations/gitlab-hookdeck-webhook", () => ({
  handleGitLabHookdeckWebhook: mocks.handleGitLabHookdeckWebhook,
  looksLikeGitLabWebhook: mocks.looksLikeGitLabWebhook,
}));

vi.mock("@/lib/integrations/daytona-hookdeck-webhook", () => ({
  handleDaytonaHookdeckWebhook: mocks.handleDaytonaHookdeckWebhook,
  looksLikeDaytonaWebhook: mocks.looksLikeDaytonaWebhook,
}));

vi.mock("@/lib/integrations/gcp-hookdeck-webhook", () => ({
  handleGcpHookdeckWebhook: mocks.handleGcpHookdeckWebhook,
  looksLikeGcpWebhook: mocks.looksLikeGcpWebhook,
}));

vi.mock("@/lib/integrations/cloudflare-hookdeck-webhook", () => ({
  handleCloudflareHookdeckWebhook: mocks.handleCloudflareHookdeckWebhook,
  looksLikeCloudflareWebhook: mocks.looksLikeCloudflareWebhook,
}));

vi.mock("@/lib/integrations/recall-hookdeck-webhook", () => ({
  handleRecallHookdeckWebhook: mocks.handleRecallHookdeckWebhook,
  looksLikeRecallWebhook: mocks.looksLikeRecallWebhook,
}));

vi.mock("@/lib/integrations/nango-webhook-router", () => ({
  isRickySlackForwardEnvelope: vi.fn(() => false),
  parseNangoWebhookEnvelope: mocks.parseNangoWebhookEnvelope,
  RelayfilePrimaryWriteError: mocks.RelayfilePrimaryWriteError,
  routeNangoWebhook: mocks.routeNangoWebhook,
  verifyNangoWebhookSignature: mocks.verifyNangoWebhookSignature,
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
  tryResourceValue: mocks.tryResourceValue,
}));

vi.mock("@/lib/logger", () => ({
  captureError: mocks.captureError,
  logger: { info: vi.fn() },
}));

import { handleNangoWebhookPost } from "./nango-webhook-route-handler";

function hookdeckRequest(): NextRequest {
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/hookdeck", {
    method: "POST",
    body: JSON.stringify({ event_type: "merge_request" }),
    headers: {
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-token": "secret-token",
    },
  });
}

function nangoRequest(): NextRequest {
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/nango", {
    method: "POST",
    body: JSON.stringify({
      from: "github",
      type: "webhook",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-123",
      payload: {},
    }),
    headers: {
      "x-nango-signature": "test-signature",
    },
  });
}

function daytonaRequest(): NextRequest {
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/hookdeck", {
    method: "POST",
    body: JSON.stringify({
      event: "sandbox.state.updated",
      id: "sbx_1",
      organizationId: "org_1",
      timestamp: "2026-05-01T00:00:00.000Z",
      newState: "error",
    }),
    headers: {
      "x-hookdeck-signature": "hookdeck-signature",
    },
  });
}

function recallRequest(): NextRequest {
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/hookdeck", {
    method: "POST",
    body: JSON.stringify({
      event: "sdk_upload.complete",
      data: { recording_id: "rec_123" },
    }),
  });
}

function gcpRequest(): NextRequest {
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/hookdeck", {
    method: "POST",
    body: JSON.stringify({
      subscription: "projects/nightcto-production/subscriptions/nango-gcp-monitoring-conn-gcp-1",
      message: {
        messageId: "msg-gcp-1",
        data: Buffer.from(
          JSON.stringify({
            incident: {
              policy_name: "projects/nightcto-production/alertPolicies/17163008471956214188",
              state: "open",
              started_at: 1781681184,
            },
          }),
        ).toString("base64"),
      },
    }),
    headers: {
      "x-hookdeck-signature": "hookdeck-signature",
    },
  });
}

function cloudflareRequest(): NextRequest {
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/hookdeck", {
    method: "POST",
    body: JSON.stringify({
      account_id: "f7232cb80f6fab86a95426302af243e4",
      alert_type: "workers_alert",
      alert_event: "WORKERS_ANOMALY_DETECTED_START",
      alert_correlation_id: "corr-1",
      ts: 1781681184,
      data: {
        zone_tag: "a647241ae955e711b22a421e623db733",
        zone_name: "relayfile.dev",
      },
    }),
    headers: {
      "x-hookdeck-signature": "hookdeck-signature",
    },
  });
}

function nangoSyncRequest(headers: Record<string, string> = {
  "x-nango-hmac-sha256": "test-signature",
}): NextRequest {
  return new NextRequest("https://agentrelay.test/api/v1/webhooks/nango", {
    method: "POST",
    body: JSON.stringify({
      from: "nango",
      type: "sync",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-123",
      syncName: "fetch-open-prs",
      model: "PullRequest",
      success: true,
    }),
    headers,
  });
}

describe("handleNangoWebhookPost", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.captureError.mockResolvedValue(undefined);
    mocks.handleDaytonaHookdeckWebhook.mockResolvedValue({
      handled: true,
      response: NextResponse.json({
        accepted: true,
        type: "sandbox.state.updated",
        ingress: "hookdeck",
      }),
    });
    mocks.handleRecallHookdeckWebhook.mockResolvedValue({
      handled: true,
      response: NextResponse.json({
        accepted: true,
        recording_id: "rec_123",
      }),
    });
    mocks.handleGcpHookdeckWebhook.mockResolvedValue({
      handled: true,
      response: NextResponse.json({
        accepted: true,
        type: "monitoring.incident.open",
        ingress: "hookdeck",
      }),
    });
    mocks.handleCloudflareHookdeckWebhook.mockResolvedValue({
      handled: true,
      response: NextResponse.json({
        accepted: true,
        type: "workers_alert",
        ingress: "hookdeck",
      }),
    });
    mocks.getNangoSecretKey.mockReturnValue("nango-secret");
    mocks.looksLikeGitLabWebhook.mockReturnValue(true);
    mocks.looksLikeDaytonaWebhook.mockReturnValue(false);
    mocks.looksLikeGcpWebhook.mockReturnValue(false);
    mocks.looksLikeCloudflareWebhook.mockReturnValue(false);
    mocks.looksLikeRecallWebhook.mockReturnValue(false);
    mocks.optionalEnv.mockReturnValue(undefined);
    mocks.tryResourceValue.mockReturnValue(undefined);
    mocks.verifyNangoWebhookSignature.mockReturnValue(true);
    mocks.parseNangoWebhookEnvelope.mockReturnValue({
      from: "github",
      type: "webhook",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-123",
      payload: {},
    });
  });

  it("captures GitLab Hookdeck handler failures instead of throwing through the route", async () => {
    const failure = new Error("nango sync unavailable");
    mocks.handleGitLabHookdeckWebhook.mockRejectedValue(failure);

    const response = await handleNangoWebhookPost(hookdeckRequest(), {
      ingress: "hookdeck",
      route: "/api/v1/webhooks/hookdeck",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      accepted: false,
      error: "GitLab webhook handling failed",
    });
    expect(mocks.captureError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        area: "gitlab-webhook",
        ingress: "hookdeck",
        route: "/api/v1/webhooks/hookdeck",
      }),
    );
  });

  it("routes Daytona Hookdeck webhooks before the Nango signature check", async () => {
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);
    mocks.looksLikeDaytonaWebhook.mockReturnValue(true);

    const response = await handleNangoWebhookPost(daytonaRequest(), {
      ingress: "hookdeck",
      route: "/api/v1/webhooks/hookdeck",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      type: "sandbox.state.updated",
      ingress: "hookdeck",
    });
    expect(mocks.handleDaytonaHookdeckWebhook).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Headers),
    );
    expect(mocks.routeNangoWebhook).not.toHaveBeenCalled();
  });

  it("routes Recall Hookdeck webhooks before requiring the Nango secret", async () => {
    mocks.getNangoSecretKey.mockReturnValue(null);
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);
    mocks.looksLikeRecallWebhook.mockReturnValue(true);

    const response = await handleNangoWebhookPost(recallRequest(), {
      ingress: "hookdeck",
      route: "/api/v1/webhooks/hookdeck",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      recording_id: "rec_123",
    });
    expect(mocks.handleRecallHookdeckWebhook).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Headers),
    );
    expect(mocks.verifyNangoWebhookSignature).not.toHaveBeenCalled();
    expect(mocks.routeNangoWebhook).not.toHaveBeenCalled();
  });

  it("routes GCP Hookdeck webhooks before requiring the Nango secret", async () => {
    mocks.getNangoSecretKey.mockReturnValue(null);
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);
    mocks.looksLikeGcpWebhook.mockReturnValue(true);

    const response = await handleNangoWebhookPost(gcpRequest(), {
      ingress: "hookdeck",
      route: "/api/v1/webhooks/hookdeck",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      type: "monitoring.incident.open",
      ingress: "hookdeck",
    });
    expect(mocks.handleGcpHookdeckWebhook).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Headers),
    );
    expect(mocks.verifyNangoWebhookSignature).not.toHaveBeenCalled();
    expect(mocks.routeNangoWebhook).not.toHaveBeenCalled();
  });

  it("routes Cloudflare Hookdeck webhooks before requiring the Nango secret", async () => {
    mocks.getNangoSecretKey.mockReturnValue(null);
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);
    mocks.looksLikeCloudflareWebhook.mockReturnValue(true);

    const response = await handleNangoWebhookPost(cloudflareRequest(), {
      ingress: "hookdeck",
      route: "/api/v1/webhooks/hookdeck",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      type: "workers_alert",
      ingress: "hookdeck",
    });
    expect(mocks.handleCloudflareHookdeckWebhook).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Headers),
    );
    expect(mocks.verifyNangoWebhookSignature).not.toHaveBeenCalled();
    expect(mocks.routeNangoWebhook).not.toHaveBeenCalled();
  });

  it("returns 502 for Relayfile primary write failures so webhook delivery can retry", async () => {
    const failure = new mocks.RelayfilePrimaryWriteError(
      "Relayfile provider write failed for github/PullRequest: 1 error(s)",
    );
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);
    mocks.routeNangoWebhook.mockRejectedValue(failure);

    const response = await handleNangoWebhookPost(nangoRequest(), {
      ingress: "nango",
      route: "/api/v1/webhooks/nango",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      accepted: false,
      error: "Relayfile primary webhook write failed",
      type: "webhook",
    });
    expect(mocks.captureError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        area: "nango-webhook",
        provider: "github",
        connectionId: "conn-github-123",
      }),
    );
  });

  it("returns 502 for generic router failures so primary fallback write exceptions retry", async () => {
    const failure = new Error("Relayfile ingestWebhook unavailable");
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);
    mocks.routeNangoWebhook.mockRejectedValue(failure);

    const response = await handleNangoWebhookPost(nangoRequest(), {
      ingress: "nango",
      route: "/api/v1/webhooks/nango",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      accepted: false,
      error: "Nango webhook handling failed",
      type: "webhook",
    });
    expect(mocks.captureError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        area: "nango-webhook",
        provider: "github",
        connectionId: "conn-github-123",
      }),
    );
  });

  it("returns 200 for a signed sync webhook when routing succeeds", async () => {
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);
    mocks.parseNangoWebhookEnvelope.mockReturnValue({
      from: "nango",
      type: "sync",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-123",
      payload: {
        syncName: "fetch-open-prs",
        model: "PullRequest",
        success: true,
      },
    });

    const response = await handleNangoWebhookPost(nangoSyncRequest(), {
      ingress: "nango",
      route: "/api/v1/webhooks/nango",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      accepted: true,
      type: "sync",
      ingress: "nango",
    });
    expect(mocks.routeNangoWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ type: "sync" }),
    );
  });

  it("returns 502 and attributes sync enqueue failures", async () => {
    const failure = new Error("queue bridge unavailable");
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);
    mocks.parseNangoWebhookEnvelope.mockReturnValue({
      from: "nango",
      type: "sync",
      providerConfigKey: "github-relay",
      connectionId: "conn-github-123",
      payload: {
        syncName: "fetch-open-prs",
        model: "PullRequest",
        success: true,
      },
    });
    mocks.routeNangoWebhook.mockRejectedValue(failure);

    const response = await handleNangoWebhookPost(nangoSyncRequest(), {
      ingress: "nango",
      route: "/api/v1/webhooks/nango",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      accepted: false,
      error: "Nango webhook handling failed",
      type: "sync",
    });
    expect(mocks.captureError).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        area: "nango-webhook",
        subsystem: "nango-sync-queue",
        type: "sync",
        errorMessage: "queue bridge unavailable",
      }),
    );
  });

  it("rejects unsigned Nango webhooks when the Nango secret is configured", async () => {
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);

    const response = await handleNangoWebhookPost(nangoSyncRequest({}), {
      ingress: "nango",
      route: "/api/v1/webhooks/nango",
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid signature",
    });
    expect(mocks.parseNangoWebhookEnvelope).not.toHaveBeenCalled();
    expect(mocks.routeNangoWebhook).not.toHaveBeenCalled();
  });

  it("fails closed when the Nango webhook secret is missing", async () => {
    mocks.getNangoSecretKey.mockReturnValue(null);
    mocks.looksLikeGitLabWebhook.mockReturnValue(false);

    const response = await handleNangoWebhookPost(nangoSyncRequest(), {
      ingress: "nango",
      route: "/api/v1/webhooks/nango",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Nango webhook secret is not configured",
    });
    expect(mocks.verifyNangoWebhookSignature).not.toHaveBeenCalled();
    expect(mocks.parseNangoWebhookEnvelope).not.toHaveBeenCalled();
    expect(mocks.routeNangoWebhook).not.toHaveBeenCalled();
  });
});
