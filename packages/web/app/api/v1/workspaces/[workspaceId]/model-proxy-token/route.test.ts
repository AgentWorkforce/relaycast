import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Tier-2 GenUI fallback mint route: turns the recorder's cli:auth login token
// into a short-lived relay-llm-proxy token (provider anthropic) for the cloud
// credential-proxy. Auth mirrors connect-session via hasCloudControlScope —
// session OR cli:auth/cloud-write scope, and REJECTS relayfile-source tokens
// (so a relayfile path token carrying cli:auth can't mint a house-key proxy
// JWT). The house key is never returned — only the scoped JWT.

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
  mintCredentialProxyToken: vi.fn(),
  optionalEnv: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

// Faithful reimplementation of hasCloudControlScope's contract (the real helper
// drags in DB/Nango deps, so it's mocked here; its relayfile rejection is also
// covered directly by integration-route-handler.test.ts). Mirrors the source:
// reject relayfile, then session OR the named scope OR cli:auth.
vi.mock("@/lib/integrations/integration-route-handler", () => ({
  CLOUD_INTEGRATIONS_WRITE_SCOPE: "cloud:integrations:write",
  hasCloudControlScope: (
    auth: { source?: string; scopes?: string[] } | null,
    scope: string,
  ) =>
    !!auth &&
    auth.source !== "relayfile" &&
    (auth.source === "session" ||
      (auth.scopes?.includes(scope) ?? false) ||
      (auth.scopes?.includes("cli:auth") ?? false)),
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceIntegrationAccess,
}));

vi.mock("@cloud/core/auth/proxy-token.js", () => ({
  mintCredentialProxyToken: mocks.mintCredentialProxyToken,
}));

vi.mock("@/lib/env", () => ({
  optionalEnv: mocks.optionalEnv,
}));

vi.mock("sst", () => ({ Resource: {} }));

import { POST } from "./route";

const WORKSPACE_ID = "ws_app_123";
const RELAY_WORKSPACE_ID = "rw_relay_123";

function makeRequest(body?: unknown): NextRequest {
  return new NextRequest("https://app.test/api/v1/workspaces/ws_app_123/model-proxy-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const context = { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveRequestAuth.mockResolvedValue({
    userId: "user_1",
    workspaceId: RELAY_WORKSPACE_ID,
    source: "token",
    scopes: ["cli:auth"],
  });
  mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
    requestedWorkspaceId: WORKSPACE_ID,
    relayWorkspaceId: RELAY_WORKSPACE_ID,
    candidateWorkspaceIds: [WORKSPACE_ID, RELAY_WORKSPACE_ID],
  });
  mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
  mocks.mintCredentialProxyToken.mockResolvedValue("proxy.jwt.token");
  mocks.optionalEnv.mockImplementation((name: string) => {
    if (name === "CREDENTIAL_PROXY_URL") return "https://llm-proxy.relayauth.dev";
    if (name === "CREDENTIAL_PROXY_JWT_SECRET") return "jwt-secret";
    return undefined;
  });
});

describe("POST /api/v1/workspaces/{id}/model-proxy-token", () => {
  it("401 when unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const res = await POST(makeRequest({ provider: "anthropic" }), context);
    expect(res.status).toBe(401);
  });

  it("403 when the caller lacks workspace access", async () => {
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(false);
    const res = await POST(makeRequest({ provider: "anthropic" }), context);
    expect(res.status).toBe(403);
    expect(mocks.mintCredentialProxyToken).not.toHaveBeenCalled();
  });

  it("403 for a relayfile-source token even with cli:auth scope and workspace access", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_1",
      workspaceId: RELAY_WORKSPACE_ID,
      source: "relayfile",
      scopes: ["cli:auth"],
      relayfileSponsorId: "agent-x",
    });
    const res = await POST(makeRequest({ provider: "anthropic" }), context);
    expect(res.status).toBe(403);
    expect(mocks.mintCredentialProxyToken).not.toHaveBeenCalled();
  });

  it("403 when a token carries no cloud-control scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_1",
      workspaceId: RELAY_WORKSPACE_ID,
      source: "token",
      scopes: [],
    });
    const res = await POST(makeRequest({ provider: "anthropic" }), context);
    expect(res.status).toBe(403);
  });

  it("400 for an unsupported provider", async () => {
    const res = await POST(makeRequest({ provider: "openai" }), context);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("unsupported_provider");
    expect(mocks.mintCredentialProxyToken).not.toHaveBeenCalled();
  });

  it("503 when the proxy is not configured", async () => {
    mocks.optionalEnv.mockReturnValue(undefined);
    const res = await POST(makeRequest({ provider: "anthropic" }), context);
    expect(res.status).toBe(503);
    expect(mocks.mintCredentialProxyToken).not.toHaveBeenCalled();
  });

  it("mints an anthropic token scoped to the relay workspace (happy path, default 2h TTL)", async () => {
    const res = await POST(makeRequest({ provider: "anthropic" }), context);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      token: "proxy.jwt.token",
      baseURL: "https://llm-proxy.relayauth.dev",
      provider: "anthropic",
      workspaceId: WORKSPACE_ID,
      relayWorkspaceId: RELAY_WORKSPACE_ID,
    });
    expect(typeof json.expiresAt).toBe("string");
    expect(mocks.mintCredentialProxyToken).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: RELAY_WORKSPACE_ID,
        provider: "anthropic",
        credentialId: "user_1",
        secret: "jwt-secret",
        ttlSeconds: 2 * 60 * 60,
      }),
    );
  });

  it("defaults provider to anthropic when omitted", async () => {
    const res = await POST(makeRequest({}), context);
    expect(res.status).toBe(200);
    expect(mocks.mintCredentialProxyToken).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic" }),
    );
  });

  it("clamps ttlSeconds to the [60, 7200] range", async () => {
    await POST(makeRequest({ provider: "anthropic", ttlSeconds: 999999 }), context);
    expect(mocks.mintCredentialProxyToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ ttlSeconds: 7200 }),
    );
    await POST(makeRequest({ provider: "anthropic", ttlSeconds: 5 }), context);
    expect(mocks.mintCredentialProxyToken).toHaveBeenLastCalledWith(
      expect.objectContaining({ ttlSeconds: 60 }),
    );
  });

  it("400 when ttlSeconds is not a number", async () => {
    const res = await POST(makeRequest({ provider: "anthropic", ttlSeconds: "soon" }), context);
    expect(res.status).toBe(400);
  });
});
