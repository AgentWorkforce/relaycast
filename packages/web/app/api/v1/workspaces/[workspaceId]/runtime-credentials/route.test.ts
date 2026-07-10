import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCloudWorkspaceRegistry: vi.fn(),
  resolveRequestAuth: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
  resolveRelayAuthConfig: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  resolveRelayfileCredentialWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
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

vi.mock("@/lib/integrations/relayfile-integration-push", () => ({
  resolveRelayfileCredentialWorkspaceId: mocks.resolveRelayfileCredentialWorkspaceId,
}));

import { POST as mintRuntimeCredentials } from "./route";

const APP_WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const RELAY_WORKSPACE_ID = "rw_1234abcd";
const RELAYFILE_WORKSPACE_ID = "rf_runtime";
const TOKEN_PAIR = {
  accessToken: "relay_pa_scoped",
  refreshToken: "relay_pa_refresh",
  accessTokenExpiresAt: "2026-06-13T19:00:00.000Z",
  refreshTokenExpiresAt: "2026-06-14T18:00:00.000Z",
  tokenType: "Bearer",
};
const RUNTIME_CREDENTIAL_HEADERS = {
  authorization: "Bearer cld_at_cli",
  "x-relayauth-workspace-token": "relay_ws_workspace",
};

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: APP_WORKSPACE_ID,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token",
  scopes: ["cli:auth"],
};

function request(
  body?: unknown,
  headers?: Record<string, string>,
  workspaceId = APP_WORKSPACE_ID,
): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/runtime-credentials`,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
    },
  );
}

function context(workspaceId = APP_WORKSPACE_ID) {
  return {
    params: Promise.resolve({
      workspaceId,
    }),
  };
}

function tokenPairResponse(): Response {
  return new Response(JSON.stringify(TOKEN_PAIR), { status: 200 });
}

function expectTokenPairFields(payload: Record<string, unknown>) {
  expect(payload).toMatchObject({
    relayauthUrl: "https://relayauth.test",
    relayfileToken: TOKEN_PAIR.accessToken,
    relayfileTokenExpiresAt: TOKEN_PAIR.accessTokenExpiresAt,
    relayfileRefreshToken: TOKEN_PAIR.refreshToken,
    relayfileRefreshTokenExpiresAt: TOKEN_PAIR.refreshTokenExpiresAt,
    relayfileScopes: expect.arrayContaining([
      expect.stringMatching(/^relayfile:fs:read:/),
      expect.stringMatching(/^relayfile:fs:write:/),
    ]),
    delegationNotAfter: expect.any(String),
  });
}

function expectNullTokenPayload(payload: unknown, workspaceId = auth.workspaceId) {
  expect(payload).toEqual({
    relayfileUrl: "https://relayfile.test",
    relayauthUrl: "https://relayauth.test",
    refreshUrl: "https://relayauth.test/v1/tokens/refresh",
    relayfileWorkspaceId: workspaceId,
    relayfileToken: null,
    relayfileTokenExpiresAt: null,
    relayfileRefreshToken: null,
    relayfileRefreshTokenExpiresAt: null,
    relayfileScopes: [],
    delegationNotAfter: null,
    relayfileMountPaths: [],
  });
}

describe("workspace runtime credentials route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
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
      appWorkspaceId: APP_WORKSPACE_ID,
      organizationId: auth.organizationId,
    });
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn(async (workspaceId: string) =>
          workspaceId === RELAY_WORKSPACE_ID
            ? {
                id: RELAY_WORKSPACE_ID,
                name: "Runtime Relay",
                createdBy: auth.userId,
                relaycastApiKey: "rk_live_runtime",
                relayfileWorkspaceId: RELAYFILE_WORKSPACE_ID,
                relayauthWorkspaceId: "ra_runtime",
                permissions: { ignored: [], readonly: [] },
              }
            : null,
        ),
      },
    });
    mocks.resolveRelayfileCredentialWorkspaceId.mockImplementation(async (id: string) => id);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("mints scoped relayfile credentials from posted integration triggers without leaking provider grants", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T18:00:00.000Z"));
    const fetchMock = vi.fn(async () =>
      tokenPairResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          agentId: "agent_123",
          integrations: {
            github: {
              source: { kind: "workspace" },
              triggers: [{ trigger: { on: "pull_request.opened" } }],
              backendConnection: {
                access_token: "raw-provider-token-that-must-not-leak",
              },
              tokenEnvName: "WORKFORCE_INTEGRATION_GITHUB_TOKEN",
            },
          },
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("https://relayauth.test/v1/tokens/path");
    const headers = init?.headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer relay_ws_workspace");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspaceId: auth.workspaceId,
      paths: ["/github/repos/**/**/pulls/**"],
      ttlSeconds: 1800,
      delegationNotAfter: "2026-06-14T18:00:00.000Z",
      agentName: "agent_123",
    });

    const payload = await response.json();
    expect(payload).toEqual({
      relayfileUrl: "https://relayfile.test",
      relayauthUrl: "https://relayauth.test",
      refreshUrl: "https://relayauth.test/v1/tokens/refresh",
      relayfileWorkspaceId: auth.workspaceId,
      relayfileToken: TOKEN_PAIR.accessToken,
      relayfileTokenExpiresAt: TOKEN_PAIR.accessTokenExpiresAt,
      relayfileRefreshToken: TOKEN_PAIR.refreshToken,
      relayfileRefreshTokenExpiresAt: TOKEN_PAIR.refreshTokenExpiresAt,
      relayfileScopes: [
        "relayfile:fs:read:/github/repos/**/**/pulls/**",
        "relayfile:fs:write:/github/repos/**/**/pulls/**",
      ],
      delegationNotAfter: "2026-06-14T18:00:00.000Z",
      relayfileMountPaths: ["/github/repos/**/**/pulls/**"],
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("raw-provider-token");
    expect(serialized).not.toContain("backendConnection");
    expect(serialized).not.toContain("WORKFORCE_INTEGRATION_GITHUB_TOKEN");
  });

  it("accepts a canonical rw_ workspace and mints against its relayfile workspace id", async () => {
    const fetchMock = vi.fn(async () =>
      tokenPairResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          relayfileMountPaths: ["/github/repos/acme/cloud/pulls/**"],
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
        RELAY_WORKSPACE_ID,
      ),
      context(RELAY_WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspaceId: RELAYFILE_WORKSPACE_ID,
      paths: ["/github/repos/acme/cloud/pulls/**"],
    });
    await expect(response.json()).resolves.toMatchObject({
      relayfileWorkspaceId: RELAYFILE_WORKSPACE_ID,
      relayfileToken: TOKEN_PAIR.accessToken,
      relayfileRefreshToken: TOKEN_PAIR.refreshToken,
    });
  });

  it("mints scoped relayfile credentials from top-level agent triggers", async () => {
    const fetchMock = vi.fn(async () =>
      tokenPairResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          agentId: "agent_123",
          integrations: {
            github: {
              source: { kind: "workspace" },
              backendConnection: {
                access_token: "raw-provider-token-that-must-not-leak",
              },
            },
          },
          agent: {
            triggers: {
              github: [{ on: "pull_request.opened" }],
            },
          },
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspaceId: auth.workspaceId,
      paths: ["/github/repos/**/**/pulls/**"],
      ttlSeconds: 1800,
      delegationNotAfter: expect.any(String),
      agentName: "agent_123",
    });
    const payload = await response.json();
    expectTokenPairFields(payload);
    expect(payload).toMatchObject({
      relayfileMountPaths: ["/github/repos/**/**/pulls/**"],
    });
  });

  it("mints issue resolver relayfile credentials from top-level agent triggers", async () => {
    const fetchMock = vi.fn(async () =>
      tokenPairResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "cloud-small-issue-codex",
          agentId: "agent_issue_resolver",
          integrations: {
            github: { source: { kind: "workspace" } },
            slack: { source: { kind: "workspace" }, scope: { channel: "proj-cloud" } },
          },
          agent: {
            triggers: {
              github: [
                {
                  on: "issues.opened",
                  paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
                },
                {
                  on: "issues.labeled",
                  paths: ["/github/repos/AgentWorkforce/cloud/issues/**"],
                },
              ],
              slack: [
                {
                  on: "message",
                  paths: ["/slack/channels/proj-cloud/messages/**"],
                },
              ],
            },
          },
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      workspaceId: auth.workspaceId,
      paths: [
        "/github/repos/AgentWorkforce/cloud/issues/**",
        "/slack/channels/proj-cloud/messages/**",
      ],
      ttlSeconds: 1800,
      delegationNotAfter: expect.any(String),
      agentName: "agent_issue_resolver",
    });
    const payload = await response.json();
    expectTokenPairFields(payload);
    expect(payload).toMatchObject({
      relayfileMountPaths: [
        "/github/repos/AgentWorkforce/cloud/issues/**",
        "/slack/channels/proj-cloud/messages/**",
      ],
    });
  });

  it("does not union legacy integration triggers when top-level agent triggers are present", async () => {
    const fetchMock = vi.fn(async () =>
      tokenPairResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          integrations: {
            github: {
              source: { kind: "workspace" },
              triggers: [{ on: "issues.opened" }],
            },
          },
          agent: {
            triggers: {
              github: [{ on: "pull_request.opened" }],
            },
          },
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      paths: ["/github/repos/**/**/pulls/**"],
    });
  });

  it("rejects agent triggers without a matching provider integration", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          integrations: {},
          agent: {
            triggers: {
              github: [{ on: "pull_request.opened" }],
            },
          },
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "invalid_persona_integrations",
      error: expect.stringContaining("agent.triggers.github requires a matching integrations.github"),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a null token without minting when posted integrations have no writeback triggers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-readonly-agent",
          integrations: {
            github: { source: { kind: "workspace" } },
          },
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNullTokenPayload(await response.json());
  });

  it("does not require a bearer token when no runtime relayfile token is needed", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request({
        personaId: "local-readonly-agent",
        integrations: {
          github: { source: { kind: "workspace" } },
        },
        ttlSeconds: 1800,
      }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expectNullTokenPayload(await response.json());
  });

  it("normalizes explicit relayfile mount paths before minting and returning credentials", async () => {
    const fetchMock = vi.fn(async () =>
      tokenPairResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          relayfileMountPaths: [
            "github/repos/acme/cloud/pulls/",
            "\\github\\repos\\acme\\cloud\\issues",
          ],
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      paths: [
        "/github/repos/acme/cloud/issues",
        "/github/repos/acme/cloud/pulls/**",
      ],
    });
    const payload = await response.json();
    expectTokenPairFields(payload);
    expect(payload).toMatchObject({
      relayfileMountPaths: [
        "/github/repos/acme/cloud/issues",
        "/github/repos/acme/cloud/pulls/**",
      ],
    });
  });

  it("treats explicit empty relayfile mount paths as an override instead of deriving integration paths", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          integrations: {
            github: {
              source: { kind: "workspace" },
              triggers: [{ trigger: { on: "pull_request.opened" } }],
            },
          },
          relayfileMountPaths: [" ", "*", "/*", "/", "//", "///", "/**", "/..", "/github/../pulls"],
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      relayfileToken: null,
      relayfileRefreshToken: null,
      relayfileMountPaths: [],
    });
  });

  it("rejects malformed integration source payloads cleanly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request({
        personaId: "local-review-agent",
        integrations: {
          github: { source: 123 },
        },
        ttlSeconds: 1800,
      }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects falsy malformed integration source payloads cleanly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request({
        personaId: "local-review-agent",
        integrations: {
          github: { source: false },
        },
        ttlSeconds: 1800,
      }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-string workspace service account names cleanly", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request({
        personaId: "local-review-agent",
        integrations: {
          github: {
            source: { kind: "workspace_service_account", name: 123 },
          },
        },
        ttlSeconds: 1800,
      }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops invalid runtime mount paths without rejecting the request", async () => {
    const fetchMock = vi.fn(async () =>
      tokenPairResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          relayfileMountPaths: [
            "/",
            "//",
            "/**",
            "/*",
            "*",
            "",
            " ",
            "/..",
            "/github/../pulls",
            "/github/repos/acme/cloud/pulls/",
          ],
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      paths: ["/github/repos/acme/cloud/pulls/**"],
    });
    await expect(response.json()).resolves.toMatchObject({
      relayfileToken: "relay_pa_scoped",
      relayfileMountPaths: ["/github/repos/acme/cloud/pulls/**"],
    });
  });

  it("rejects connected writeback integrations when bearer workspace token minting is unavailable", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request({
        personaId: "local-review-agent",
        integrations: {
          github: {
            source: { kind: "workspace" },
            triggers: [{ trigger: { on: "pull_request.opened" } }],
          },
        },
        ttlSeconds: 1800,
      }),
      context(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "RelayAuth workspace token required",
      code: "relayauth_workspace_token_required",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects relayfile path tokens as runtime credential mint authority", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          integrations: {
            github: {
              source: { kind: "workspace" },
              triggers: [{ trigger: { on: "pull_request.opened" } }],
            },
          },
          ttlSeconds: 1800,
        },
        {
          authorization: "Bearer cld_at_cli",
          "x-relayauth-workspace-token": "relay_pa_path_token",
        },
      ),
      context(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Relayfile path tokens cannot mint runtime credentials",
      code: "relayfile_path_token_not_allowed",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-workspace RelayAuth tokens as runtime credential mint authority", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          integrations: {
            github: {
              source: { kind: "workspace" },
              triggers: [{ trigger: { on: "pull_request.opened" } }],
            },
          },
          ttlSeconds: 1800,
        },
        {
          authorization: "Bearer cld_at_cli",
          "x-relayauth-workspace-token": "relay_id_identity_token",
        },
      ),
      context(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "RelayAuth workspace token must be a relay_ws_ token",
      code: "relayauth_workspace_token_invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not fetch provider backend connections before minting runtime credentials", async () => {
    const fetchMock = vi.fn(async () =>
      tokenPairResponse(),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await mintRuntimeCredentials(
      request(
        {
          personaId: "local-review-agent",
          integrations: {
            github: {
              source: { kind: "workspace" },
              triggers: [{ trigger: { on: "pull_request.opened" } }],
            },
          },
          ttlSeconds: 1800,
        },
        RUNTIME_CREDENTIAL_HEADERS,
      ),
      context(),
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = await response.json();
    expectTokenPairFields(payload);
    expect(JSON.stringify(payload)).not.toContain("backendConnection");
    expect(JSON.stringify(payload)).not.toContain("WORKFORCE_INTEGRATION_GITHUB_TOKEN");
  });
});
