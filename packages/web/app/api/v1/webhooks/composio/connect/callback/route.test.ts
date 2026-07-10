import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureError: vi.fn(),
  getRelayWorkspace: vi.fn(),
  handleComposioConnectCallback: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock("@/lib/integrations/composio-connect-callback", () => ({
  handleComposioConnectCallback: mocks.handleComposioConnectCallback,
}));

vi.mock("@/lib/logger", () => ({
  captureError: mocks.captureError,
  logger: {
    info: mocks.loggerInfo,
  },
}));

vi.mock("@/lib/relay-workspaces", () => ({
  getRelayWorkspace: mocks.getRelayWorkspace,
}));

import { GET } from "./route";

function request(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers });
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    workspaceId: "rw_9bf21576",
    provider: "docker_hub",
    connectionId: "ca_123",
    providerConfigKey: "docker_hub-composio-relay",
    syncTriggered: false,
    syncs: [],
    returnTo: null,
    integration: {},
    ...overrides,
  };
}

describe("GET /api/v1/webhooks/composio/connect/callback", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.captureError.mockResolvedValue(undefined);
    mocks.loggerInfo.mockResolvedValue(undefined);
    mocks.getRelayWorkspace.mockResolvedValue({ id: "rw_9bf21576", name: "Acme Workspace" });
    mocks.handleComposioConnectCallback.mockResolvedValue(successResult());
  });

  it("renders an HTML success page by default when returnTo is absent", async () => {
    const response = await GET(request(
      "https://agentrelay.test/cloud/api/v1/webhooks/composio/connect/callback?state=s&status=success",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Connected Docker Hub. You can close this window.");
    expect(body).toContain("Acme Workspace");
    expect(body).toContain("Return to your terminal");
    expect(body).not.toContain('{"ok":true');
    expect(mocks.getRelayWorkspace).toHaveBeenCalledWith("rw_9bf21576");
  });

  it("keeps the JSON success body behind explicit JSON negotiation", async () => {
    const response = await GET(request(
      "https://agentrelay.test/cloud/api/v1/webhooks/composio/connect/callback?state=s&format=json",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      ok: true,
      workspaceId: "rw_9bf21576",
      provider: "docker_hub",
      connectionId: "ca_123",
      providerConfigKey: "docker_hub-composio-relay",
      syncTriggered: false,
      syncs: [],
    });
    expect(mocks.getRelayWorkspace).not.toHaveBeenCalled();
  });

  it("redirects to returnTo callbacks unchanged", async () => {
    mocks.handleComposioConnectCallback.mockResolvedValue(successResult({
      returnTo: "/integrations/docker_hub",
    }));

    const response = await GET(request(
      "https://agentrelay.test/cloud/api/v1/webhooks/composio/connect/callback?state=s",
    ));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "https://agentrelay.test/integrations/docker_hub?composioStatus=connected",
    );
  });

  it("renders an HTML error page by default", async () => {
    mocks.handleComposioConnectCallback.mockRejectedValue(new Error("missing_state"));

    const response = await GET(request(
      "https://agentrelay.test/cloud/api/v1/webhooks/composio/connect/callback",
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("The connection did not finish.");
    expect(body).toContain("missing_state");
    expect(body).toContain("Return to your terminal");
  });

  it("keeps the JSON error body behind explicit JSON negotiation", async () => {
    mocks.handleComposioConnectCallback.mockRejectedValue(new Error("missing_state"));

    const response = await GET(request(
      "https://agentrelay.test/cloud/api/v1/webhooks/composio/connect/callback",
      { accept: "application/json" },
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ ok: false, error: "missing_state" });
  });
});
