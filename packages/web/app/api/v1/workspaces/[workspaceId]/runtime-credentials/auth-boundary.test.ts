import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSessionFromRequest: vi.fn(),
  resolveApiTokenSession: vi.fn(),
  createCloudWorkspaceRegistry: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  resolveRelayAuthConfig: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    AuthSessionSecret: { value: "test-session-secret" },
    CatalogingCloudApiToken: { value: "cataloging-service-token" },
    SageCloudApiToken: { value: "sage-service-token" },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  readSessionFromRequest: mocks.readSessionFromRequest,
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  resolveApiTokenSession: mocks.resolveApiTokenSession,
}));

vi.mock("@relayauth/sdk", () => ({
  TokenVerifier: class {
    async verifyOrNull() {
      return null;
    }
  },
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayAuthConfig: mocks.resolveRelayAuthConfig,
  resolveRelayfileConfig: mocks.resolveRelayfileConfig,
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: mocks.createCloudWorkspaceRegistry,
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", () => ({
  resolveAppWorkspaceByRelayWorkspaceId: mocks.resolveAppWorkspaceByRelayWorkspaceId,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";

function request(headers: Record<string, string>) {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/runtime-credentials`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify({
        personaId: "local-review-agent",
        relayfileMountPaths: ["/github/repos/acme/cloud/pulls/**"],
        ttlSeconds: 1800,
      }),
    },
  );
}

function context() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

describe("runtime credentials auth boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.readSessionFromRequest.mockReturnValue(null);
    mocks.resolveApiTokenSession.mockResolvedValue({
      userId: "user_123",
      workspaceId: WORKSPACE_ID,
      organizationId: "org_123",
      scopes: ["cli:auth"],
      subjectType: "cli",
      runId: null,
    });
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayfileUrl: "https://relayfile.test",
      relayAuthUrl: "https://relayauth.test",
      relayAuthApiKey: "",
    });
    mocks.resolveRelayAuthConfig.mockReturnValue({
      relayAuthUrl: "https://relayauth.test",
      relayAuthApiKey: "",
    });
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: null,
      organizationId: null,
    });
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: { get: vi.fn() },
    });
  });

  it("uses real cloud auth admission while forwarding the dedicated RelayAuth workspace token for minting", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          accessToken: "relay_pa_scoped",
          refreshToken: "relay_pa_refresh",
          accessTokenExpiresAt: "2026-06-13T19:00:00.000Z",
          refreshTokenExpiresAt: "2026-06-14T18:00:00.000Z",
          tokenType: "Bearer",
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({
        authorization: "Bearer cld_at_cli_session",
        "x-relayauth-workspace-token": "relay_ws_runtime_mint",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveApiTokenSession).toHaveBeenCalledWith("cld_at_cli_session");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    const headers = init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer relay_ws_runtime_mint");
    await expect(response.json()).resolves.toMatchObject({
      relayfileToken: "relay_pa_scoped",
      relayfileRefreshToken: "relay_pa_refresh",
      relayauthUrl: "https://relayauth.test",
    });
  });
});
