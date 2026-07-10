import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import delegatedTokenContract from "../../../../../../../../../tests/contracts/relayfile-delegated-token-request.json";

const mocks = vi.hoisted(() => ({
  createCloudWorkspaceRegistry: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
  resolveRelayAuthConfig: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  resolveRequestAuth: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: vi.fn((auth, scope: string) => auth?.scopes?.includes(scope) === true),
  requireSessionAuth: vi.fn((auth) => auth?.source === "session"),
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
  isAppWorkspaceId: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim()),
  isRelayWorkspaceId: (value: string) => /^rw_[A-Za-z0-9_-]+$/.test(value.trim()),
  readBoundRelayWorkspaceId: vi.fn(async () => null),
  resolveAppWorkspaceByRelayWorkspaceId: mocks.resolveAppWorkspaceByRelayWorkspaceId,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));

import { POST } from "./route";

const APP_WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const RELAY_WORKSPACE_ID = "rw_1234abcd";
const RELAYFILE_WORKSPACE_ID = "rf_runtime";
const TOKEN_PAIR = {
  accessToken: "relay_pa_local",
  refreshToken: "relay_pa_local_refresh",
  accessTokenExpiresAt: "2026-06-13T19:00:00.000Z",
  refreshTokenExpiresAt: "2026-06-14T18:00:00.000Z",
  tokenType: "Bearer",
  delegationNotAfter: "2026-06-14T18:30:00.000Z",
};
const AGENT_TOKEN_PAIR = {
  accessToken: "relay_ag_local",
  refreshToken: "relay_ag_local_refresh",
  accessTokenExpiresAt: "2026-06-13T19:00:00.000Z",
  refreshTokenExpiresAt: "2026-06-14T18:00:00.000Z",
  tokenType: "Bearer",
  tokenClass: "relay_ag",
  agentId: "id_relayfile_cli",
  workspaceId: RELAYFILE_WORKSPACE_ID,
};

function request(
  body: unknown = {
    agentName: "relayfile-local",
    relayfileMountPaths: ["/github/repos/acme/cloud/pulls/**"],
    ttlSeconds: 1800,
    delegationTtlSeconds: 86_400,
  },
) {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${RELAY_WORKSPACE_ID}/relayfile/delegated-token`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

function context(workspaceId = RELAY_WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

describe("relayfile delegated token bootstrap route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      workspaceId: APP_WORKSPACE_ID,
      organizationId: "org_123",
      source: "token",
      scopes: ["cli:auth"],
    });
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayfileUrl: "https://relayfile.test",
      relayAuthUrl: "https://relayauth.test",
      relayAuthApiKey: "relay_ws_cloud_minter",
    });
    mocks.resolveRelayAuthConfig.mockReturnValue({
      relayAuthUrl: "https://relayauth.test",
      relayAuthApiKey: "relay_ws_cloud_minter",
    });
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: APP_WORKSPACE_ID,
      organizationId: "org_123",
    });
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn(async (workspaceId: string) =>
          workspaceId === RELAY_WORKSPACE_ID
            ? {
                id: RELAY_WORKSPACE_ID,
                relayfileWorkspaceId: RELAYFILE_WORKSPACE_ID,
                permissions: { ignored: [], readonly: [] },
              }
            : null,
        ),
      },
    });
  });

  it("mints a delegated relayfile TokenPair without exposing cloud session material", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/v1/tokens/path")) {
        return new Response(
          JSON.stringify({
            error: "workspace_token_required",
            code: "workspace_token_required",
          }),
          { status: 401 },
        );
      }
      if (url.endsWith("/v1/tokens/workspace-path")) {
        return new Response(JSON.stringify(TOKEN_PAIR), { status: 200 });
      }
      return new Response("unexpected relayauth endpoint", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(), context());

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [input, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    expect(String(input)).toBe("https://relayauth.test/v1/tokens/workspace-path");
    const headers = init.headers as Headers;
    expect(headers.get("x-api-key")).toBe("relay_ws_cloud_minter");
    expect(headers.get("authorization")).toBeNull();
    const mintBody = JSON.parse(String(init.body));
    expect(mintBody).toMatchObject({
      workspaceId: RELAYFILE_WORKSPACE_ID,
      paths: ["/github/repos/acme/cloud/pulls/**"],
      audience: ["relayfile"],
      ttlSeconds: 1800,
      refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
      delegationNotAfter: expect.any(String),
      agentName: "relayfile-local",
    });
    // `/workspace-path` is fs-only; ops/sync capabilities must be minted by
    // the workspace-scoped token chain instead.
    expect(mintBody.scopes).toEqual(expect.arrayContaining([
      "relayfile:fs:read:/github/repos/acme/cloud/pulls/**",
      "relayfile:fs:write:/github/repos/acme/cloud/pulls/**",
    ]));
    expect(mintBody.scopes).not.toEqual(expect.arrayContaining([
      "relayfile:ops:read:*",
      "relayfile:sync:read:*",
      "relayfile:sync:trigger:*",
    ]));
    const payload = await response.json();
    expect(payload).toMatchObject({
      relayfileUrl: "https://relayfile.test",
      relayauthUrl: "https://relayauth.test",
      refreshUrl: "https://relayauth.test/v1/tokens/refresh",
      relayfileWorkspaceId: RELAYFILE_WORKSPACE_ID,
      relayfileToken: TOKEN_PAIR.accessToken,
      relayfileTokenExpiresAt: TOKEN_PAIR.accessTokenExpiresAt,
      relayfileRefreshToken: TOKEN_PAIR.refreshToken,
      relayfileRefreshTokenExpiresAt: TOKEN_PAIR.refreshTokenExpiresAt,
      delegationNotAfter: expect.any(String),
      relayfileMountPaths: ["/github/repos/acme/cloud/pulls/**"],
    });
    expect(payload.relayfileScopes).toEqual(expect.arrayContaining([
      "relayfile:fs:read:/github/repos/acme/cloud/pulls/**",
      "relayfile:fs:write:/github/repos/acme/cloud/pulls/**",
    ]));
    expect(payload.relayfileScopes).not.toEqual(expect.arrayContaining([
      "relayfile:ops:read:*",
      "relayfile:sync:read:*",
      "relayfile:sync:trigger:*",
    ]));
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("cld_at");
    expect(serialized).not.toContain("cloudRefresh");
  });

  it("applies readonly permissions to explicit relayfileMountPaths requests", async () => {
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn(async (workspaceId: string) =>
          workspaceId === RELAY_WORKSPACE_ID
            ? {
                id: RELAY_WORKSPACE_ID,
                relayfileWorkspaceId: RELAYFILE_WORKSPACE_ID,
                permissions: { ignored: [], readonly: ["/docs/protected/**"] },
              }
            : null,
        ),
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://relayfile.test/v1/workspaces/")) {
        if (_init?.method === "GET") {
          return new Response("not found", { status: 404 });
        }
        if (_init?.method === "PUT") {
          return new Response(
            JSON.stringify({
              revision: "rev_acl",
              content: "# Managed by workspace API\n",
              semantics: { permissions: [] },
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected relayfile method", { status: 500 });
      }
      if (url.endsWith("/v1/tokens/workspace-path")) {
        return new Response(JSON.stringify(TOKEN_PAIR), { status: 200 });
      }
      if (url.endsWith("/v1/identities")) {
        return new Response(JSON.stringify({ id: "id_acl_admin" }), { status: 201 });
      }
      if (url.endsWith("/v1/tokens")) {
        return new Response(JSON.stringify({ accessToken: "relay_acl_admin" }), { status: 201 });
      }
      return new Response("unexpected relayauth endpoint", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({
        agentName: "relayfile-local",
        relayfileMountPaths: ["/docs/**"],
        scopes: ["fs:read", "fs:write"],
      }),
      context(),
    );

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    }));
    const aclWrite = calls.find(
      (call) => call.url.startsWith("https://relayfile.test/v1/workspaces/") && call.method === "PUT",
    );
    const mint = calls.find((call) => call.url.endsWith("/v1/tokens/workspace-path"));
    expect(aclWrite?.body).toMatchObject({
      semantics: {
        permissions: expect.arrayContaining([
          "deny:scope:relayfile:fs:write:/docs/protected/*",
        ]),
      },
    });
    expect(JSON.stringify(aclWrite?.body)).not.toContain("relayfile:fs:write:/protected/*");
    expect(mint?.body).toMatchObject({
      paths: ["/docs/**"],
      scopes: expect.arrayContaining([
        "relayfile:fs:read:/docs/**",
        "relayfile:fs:write:/docs/**",
      ]),
      refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
    });
    expect(mint?.body?.scopes).not.toEqual(expect.arrayContaining([
      "relayfile:ops:read:*",
      "relayfile:sync:read:*",
      "relayfile:sync:trigger:*",
    ]));
    await expect(response.json()).resolves.toMatchObject({
      relayfileMountPaths: ["/docs/**"],
      relayfileScopes: expect.arrayContaining([
        "relayfile:fs:read:/docs/**",
        "relayfile:fs:write:/docs/**",
      ]),
      refreshUrl: "https://relayauth.test/v1/tokens/refresh",
    });
  });

  it("filters ignored paths out of explicit relayfileMountPaths requests", async () => {
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn(async (workspaceId: string) =>
          workspaceId === RELAY_WORKSPACE_ID
            ? {
                id: RELAY_WORKSPACE_ID,
                relayfileWorkspaceId: RELAYFILE_WORKSPACE_ID,
                permissions: { ignored: ["/ignored/**", "/shared/ignored/**"], readonly: [] },
              }
            : null,
        ),
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://relayfile.test/v1/workspaces/")) {
        if (_init?.method === "GET") {
          return new Response("not found", { status: 404 });
        }
        if (_init?.method === "PUT") {
          return new Response(
            JSON.stringify({
              revision: "rev_acl",
              content: "# Managed by workspace API\n",
              semantics: { permissions: [] },
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected relayfile method", { status: 500 });
      }
      if (url.endsWith("/v1/tokens/workspace-path")) {
        return new Response(JSON.stringify(TOKEN_PAIR), { status: 200 });
      }
      if (url.endsWith("/v1/identities")) {
        return new Response(JSON.stringify({ id: "id_acl_admin" }), { status: 201 });
      }
      if (url.endsWith("/v1/tokens")) {
        return new Response(JSON.stringify({ accessToken: "relay_acl_admin" }), { status: 201 });
      }
      return new Response("unexpected relayauth endpoint", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({
        agentName: "relayfile-local",
        relayfileMountPaths: ["/allowed/**", "/ignored/**", "/shared/**"],
      }),
      context(),
    );

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    }));
    const aclWrite = calls.find(
      (call) => call.url.startsWith("https://relayfile.test/v1/workspaces/") && call.method === "PUT",
    );
    const mint = calls.find((call) => call.url.endsWith("/v1/tokens/workspace-path"));
    expect(aclWrite?.body).toMatchObject({
      semantics: {
        permissions: expect.arrayContaining([
          "deny:scope:relayfile:fs:read:/shared/ignored/*",
          "deny:scope:relayfile:fs:write:/shared/ignored/*",
        ]),
      },
    });
    expect(JSON.stringify(aclWrite?.body)).not.toContain("relayfile:fs:read:/ignored/*");
    expect(mint?.body).toMatchObject({
      paths: ["/allowed/**", "/shared/**"],
      scopes: expect.arrayContaining([
        "relayfile:fs:read:/allowed/**",
        "relayfile:fs:write:/allowed/**",
        "relayfile:fs:read:/shared/**",
        "relayfile:fs:write:/shared/**",
      ]),
    });
    expect(mint?.body?.scopes).not.toEqual(expect.arrayContaining([
      "relayfile:ops:read:*",
      "relayfile:sync:read:*",
      "relayfile:sync:trigger:*",
    ]));
    await expect(response.json()).resolves.toMatchObject({
      relayfileMountPaths: ["/allowed/**", "/shared/**"],
      relayfileScopes: expect.arrayContaining([
        "relayfile:fs:read:/allowed/**",
        "relayfile:fs:write:/allowed/**",
        "relayfile:fs:read:/shared/**",
        "relayfile:fs:write:/shared/**",
      ]),
    });
  });

  it("accepts the shipped Go CLI delegated-token body from the checked contract", async () => {
    expect(delegatedTokenContract.shippedCliCoarse).toEqual({
      agentName: "relayfile-cli",
      scopes: ["fs:read", "fs:write"],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://relayfile.test/v1/workspaces/")) {
        if (_init?.method === "GET") {
          return new Response("not found", { status: 404 });
        }
        if (_init?.method === "PUT") {
          return new Response(
            JSON.stringify({
              revision: "rev_acl",
              content: "# Managed by workspace API\n",
              semantics: { permissions: [] },
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected relayfile method", { status: 500 });
      }
      if (url.endsWith("/v1/identities")) {
        return new Response(JSON.stringify({ id: "id_relayfile_cli" }), { status: 201 });
      }
      if (url.endsWith("/v1/tokens")) {
        return new Response(
          JSON.stringify({
            accessToken: "relay_join_access",
            refreshToken: "relay_join_refresh",
            accessTokenExpiresAt: "2026-06-13T19:00:00.000Z",
            refreshTokenExpiresAt: "2026-06-14T18:00:00.000Z",
            tokenType: "Bearer",
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/v1/tokens/workspace")) {
        return new Response(JSON.stringify({ key: "relay_ws_delegated" }), { status: 201 });
      }
      if (url.endsWith("/v1/tokens/agent")) {
        return new Response(JSON.stringify(AGENT_TOKEN_PAIR), { status: 201 });
      }
      return new Response("unexpected relayauth endpoint", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(delegatedTokenContract.shippedCliCoarse), context());

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    }));
    expect(calls.map((call) => call.url)).toEqual([
      "https://relayauth.test/v1/identities",
      "https://relayauth.test/v1/tokens",
      "https://relayauth.test/v1/identities",
      "https://relayauth.test/v1/tokens/workspace",
      "https://relayauth.test/v1/tokens/agent",
    ]);
    expect(calls[1].body).toMatchObject({
      identityId: "id_relayfile_cli",
      scopes: expect.arrayContaining([
        "fs:read",
        "fs:write",
        "workspace:relayfile-cli:read:*",
        "workspace:relayfile-cli:write:*",
      ]),
      audience: ["relayfile"],
    });
    // The strict RelayAuth `/v1/tokens/{workspace,agent}` mints receive
    // 4-segment `relayfile:` scopes — NOT bare `fs:read` or `workspace:`-plane
    // ACL scopes, which `parseScope` rejects. The daemon's `scopeMatches`
    // translates these to satisfy its bare requirements.
    expect(calls[3].body).toMatchObject({
      workspaceId: RELAYFILE_WORKSPACE_ID,
      scopes: expect.arrayContaining([
        "relayauth:token:create:*",
        "relayfile:fs:read:*",
        "relayfile:fs:write:*",
        "relayfile:sync:read:*",
        "relayfile:sync:trigger:*",
        "relayfile:ops:read:*",
      ]),
    });
    expect(calls[4].body).toMatchObject({
      agentId: "id_relayfile_cli",
      scopes: expect.arrayContaining([
        "relayfile:fs:read:*",
        "relayfile:fs:write:*",
        "relayfile:sync:read:*",
        "relayfile:sync:trigger:*",
        "relayfile:ops:read:*",
      ]),
      audience: ["relayfile"],
      expiresIn: 3600,
      refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
      delegationNotAfter: expect.any(String),
    });
    // The strict-chain mints (calls[3]/[4]) must carry NO daemon-vocabulary
    // scopes — those would 403 at RelayAuth. (calls[1], the legacy
    // `/v1/tokens` mint, legitimately still uses them.)
    const strictChainBodies = JSON.stringify([calls[3].body, calls[4].body]);
    expect(strictChainBodies).not.toContain('"fs:read"');
    expect(strictChainBodies).not.toContain('"fs:write"');
    expect(strictChainBodies).not.toContain("workspace:relayfile-cli");
    expect(JSON.stringify(calls)).not.toContain('"/"');
    expect(JSON.stringify(calls)).not.toContain("relayfile:fs:read:/**");
    const payload = await response.json();
    expect(payload).toMatchObject({
      relayfileToken: AGENT_TOKEN_PAIR.accessToken,
      relayfileRefreshToken: AGENT_TOKEN_PAIR.refreshToken,
      relayfileMountPaths: [],
      relayfileScopes: expect.arrayContaining([
        "relayfile:fs:read:*",
        "relayfile:fs:write:*",
        "relayfile:sync:trigger:*",
      ]),
    });
  });

  it("mints strict delegated tokens for workspaces with readonly overrides", async () => {
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn(async (workspaceId: string) =>
          workspaceId === RELAY_WORKSPACE_ID
            ? {
                id: RELAY_WORKSPACE_ID,
                relayfileWorkspaceId: RELAYFILE_WORKSPACE_ID,
                permissions: { ignored: [], readonly: ["/protected/**"] },
              }
            : null,
        ),
      },
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://relayfile.test/v1/workspaces/")) {
        if (_init?.method === "GET") {
          return new Response("not found", { status: 404 });
        }
        if (_init?.method === "PUT") {
          return new Response(
            JSON.stringify({
              revision: "rev_acl",
              content: "# Managed by workspace API\n",
              semantics: { permissions: [] },
            }),
            { status: 200 },
          );
        }
        return new Response("unexpected relayfile method", { status: 500 });
      }
      if (url.endsWith("/v1/identities")) {
        return new Response(JSON.stringify({ id: "id_relayfile_cli" }), { status: 201 });
      }
      if (url.endsWith("/v1/tokens")) {
        return new Response(
          JSON.stringify({
            accessToken: "relay_join_access",
            refreshToken: "relay_join_refresh",
            accessTokenExpiresAt: "2026-06-13T19:00:00.000Z",
            refreshTokenExpiresAt: "2026-06-14T18:00:00.000Z",
            tokenType: "Bearer",
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/v1/tokens/workspace")) {
        return new Response(JSON.stringify({ key: "relay_ws_delegated" }), { status: 201 });
      }
      if (url.endsWith("/v1/tokens/agent")) {
        return new Response(JSON.stringify(AGENT_TOKEN_PAIR), { status: 201 });
      }
      return new Response("unexpected relayauth endpoint", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(delegatedTokenContract.shippedCliCoarse), context());

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const calls = fetchMock.mock.calls.map(([input, init]) => ({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null,
    }));
    const workspaceMint = calls.find((call) => call.url.endsWith("/v1/tokens/workspace"));
    const agentMint = calls.find((call) => call.url.endsWith("/v1/tokens/agent"));
    const aclWrite = calls.find(
      (call) =>
        call.url.startsWith("https://relayfile.test/v1/workspaces/") &&
        call.body !== null &&
        "semantics" in call.body,
    );

    expect(workspaceMint?.body).toMatchObject({
      workspaceId: RELAYFILE_WORKSPACE_ID,
      scopes: expect.arrayContaining([
        "relayfile:fs:read:*",
        "relayfile:fs:write:*",
        "relayfile:sync:read:*",
        "relayfile:sync:trigger:*",
        "relayfile:ops:read:*",
      ]),
    });
    expect(agentMint?.body).toMatchObject({
      agentId: "id_relayfile_cli",
      scopes: expect.arrayContaining([
        "relayfile:fs:read:*",
        "relayfile:fs:write:*",
        "relayfile:sync:read:*",
        "relayfile:sync:trigger:*",
        "relayfile:ops:read:*",
      ]),
      refreshTokenTtlSeconds: 60 * 60 * 24 * 90,
    });
    expect(JSON.stringify([workspaceMint?.body?.scopes, agentMint?.body?.scopes])).not.toContain(
      "workspace:",
    );
    expect(JSON.stringify([workspaceMint?.body?.scopes, agentMint?.body?.scopes])).not.toContain(
      "relayfile:fs:write:/protected/*",
    );
    expect(aclWrite?.body).toMatchObject({
      semantics: {
        permissions: expect.arrayContaining([
          "allow:scope:workspace:relayfile-cli:read:*",
          "allow:scope:workspace:relayfile-cli:write:*",
          "deny:scope:relayfile:fs:write:/protected/*",
        ]),
      },
    });
  });

  it("accepts the v0.8.30 path-scoped CLI body from `relayfile writeback push`", async () => {
    // Regression for AR-272: pre-fix, the relayfile-delegated-token-contract's
    // normalizeCliCoarseRelayfileScope only handled the bare `fs:read`/`fs:write`
    // strings, so the v0.8.30 CLI's path-scoped `fs:write:/<provider>/**` form
    // (writebackPushJoinScopes) fell through unchanged and the gate at L80
    // ("must contain a `relayfile:fs:*` scope") returned null → 400.
    expect(delegatedTokenContract.shippedCliCoarsePathScoped).toEqual({
      _comment: expect.any(String),
      agentName: "relayfile-cli",
      scopes: ["fs:write:/linear/**", "ops:read"],
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/tokens/workspace-path")) {
        return new Response(JSON.stringify(TOKEN_PAIR), { status: 200 });
      }
      return new Response("unexpected relayauth endpoint", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { _comment: _ignored, ...cliBody } = delegatedTokenContract.shippedCliCoarsePathScoped;
    const response = await POST(request(cliBody), context());

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit];
    const body = JSON.parse(String(init.body)) as { paths: string[]; scopes: string[] };
    // The normalizer must preserve the path the CLI requested — least-privilege
    // mint, not a wildcard upgrade.
    expect(body.paths).toEqual(["/linear/**"]);
    expect(body.scopes).toEqual(expect.arrayContaining([
      "relayfile:fs:write:/linear/**",
    ]));
    expect(body.scopes).not.toContain("relayfile:fs:read:/linear/**");
    expect(body.scopes).not.toContain("relayfile:fs:write:*");
    const payload = await response.json();
    expect(payload).toMatchObject({
      relayfileToken: TOKEN_PAIR.accessToken,
      relayfileMountPaths: ["/linear/**"],
      relayfileScopes: expect.arrayContaining([
        "relayfile:fs:write:/linear/**",
      ]),
    });
  });

  it("does not grant write scopes when the CLI-shaped request only asks for fs:read", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/v1/identities")) {
        return new Response(JSON.stringify({ id: "id_relayfile_cli" }), { status: 201 });
      }
      if (url.endsWith("/v1/tokens")) {
        return new Response(
          JSON.stringify({
            accessToken: "relay_join_access",
            refreshToken: "relay_join_refresh",
            accessTokenExpiresAt: "2026-06-13T19:00:00.000Z",
            refreshTokenExpiresAt: "2026-06-14T18:00:00.000Z",
            tokenType: "Bearer",
          }),
          { status: 201 },
        );
      }
      if (url.endsWith("/v1/tokens/workspace")) {
        return new Response(JSON.stringify({ key: "relay_ws_delegated" }), { status: 201 });
      }
      if (url.endsWith("/v1/tokens/agent")) {
        return new Response(JSON.stringify(AGENT_TOKEN_PAIR), { status: 201 });
      }
      return new Response("unexpected relayauth endpoint", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({ agentName: "relayfile-cli", scopes: ["fs:read"] }),
      context(),
    );

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    const finalTokenBody = JSON.parse(String(fetchMock.mock.calls[4][1]?.body)) as {
      scopes: string[];
    };
    expect(finalTokenBody.scopes).toEqual(expect.arrayContaining([
      "relayfile:fs:read:*",
      "relayfile:sync:read:*",
      "relayfile:sync:trigger:*",
      "relayfile:ops:read:*",
    ]));
    expect(finalTokenBody.scopes).not.toContain("relayfile:fs:write:*");
    expect(JSON.stringify(finalTokenBody.scopes)).not.toContain("workspace:relayfile-cli");
    await expect(response.json()).resolves.toMatchObject({
      relayfileScopes: expect.not.arrayContaining([
        "relayfile:fs:write:*",
      ]),
    });
  });

  it("rejects delegated-token requests with no relayfile fs scopes instead of falling back to defaults", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      request({ agentName: "relayfile-cli", scopes: ["relayauth:token:create:*"] }),
      context(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors granular factory scopes from the same delegated-token contract", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/v1/tokens/workspace-path")) {
        return new Response(JSON.stringify(TOKEN_PAIR), { status: 200 });
      }
      return new Response("unexpected relayauth endpoint", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(delegatedTokenContract.factoryGranular), context());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      RequestInfo | URL,
      RequestInit,
    ];
    const mintBody = JSON.parse(String(init.body));
    expect(mintBody).toMatchObject({
      workspaceId: RELAYFILE_WORKSPACE_ID,
      paths: ["/linear/issues/**"],
      agentName: "pear-factory-sdk",
    });
    expect(mintBody.scopes).toEqual(expect.arrayContaining([
      "relayfile:fs:read:/linear/issues/**",
      "relayfile:fs:write:/linear/issues/**",
    ]));
    expect(mintBody.scopes).not.toEqual(expect.arrayContaining([
      "relayfile:ops:read:*",
      "relayfile:sync:read:*",
      "relayfile:sync:trigger:*",
    ]));
    await expect(response.json()).resolves.toMatchObject({
      relayfileMountPaths: ["/linear/issues/**"],
      relayfileScopes: expect.arrayContaining([
        "relayfile:fs:read:/linear/issues/**",
        "relayfile:fs:write:/linear/issues/**",
      ]),
    });
  });

  it("rejects relayfile path-token callers as bootstrap authority before minting", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "relayfile-agent",
      workspaceId: RELAYFILE_WORKSPACE_ID,
      organizationId: "org_123",
      source: "relayfile",
      scopes: ["relayfile:fs:read:/github/*"],
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Forbidden",
      code: "forbidden",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a session caller with workspace membership to mint a delegated token", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify(TOKEN_PAIR), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      workspaceId: "different-current-workspace",
      organizationId: "org_123",
      source: "session",
      context: {
        user: { id: "user_123", email: null, name: null, avatarUrl: null },
        currentOrganization: {
          id: "org_123",
          slug: "acme",
          name: "Acme",
          role: "admin",
          status: "active",
        },
        organizations: [],
        currentWorkspace: {
          id: "different-current-workspace",
          organization_id: "org_123",
          slug: "other",
          name: "Other",
        },
        workspaces: [
          {
            id: APP_WORKSPACE_ID,
            organization_id: "org_123",
            slug: "cloud",
            name: "Cloud",
          },
        ],
      },
      scopes: [],
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns needs_reauth code when RelayAuth rejects with 401", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://relayauth.test/v1/tokens/workspace-path");
      return new Response(
        JSON.stringify({
          error: "workspace_token_required",
          code: "workspace_token_required",
        }),
        { status: 401 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(), context());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "needs_reauth",
      error: expect.stringContaining("workspace_token_required"),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns relayauth_unavailable code when RelayAuth returns 5xx", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://relayauth.test/v1/tokens/workspace-path");
      return new Response("internal server error", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(), context());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "relayauth_unavailable",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns scope_insufficient code when RelayAuth returns 400 with insufficient_scope", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://relayauth.test/v1/tokens/workspace-path");
      return new Response(
        JSON.stringify({ error: "insufficient_scope", code: "insufficient_scope" }),
        { status: 400 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "scope_insufficient",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns scope_insufficient code when RelayAuth returns 400 with invalid_scope", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({ error: "invalid_scope", code: "invalid_scope" }),
        { status: 400 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "scope_insufficient",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns scope_insufficient code when RelayAuth returns 403 with insufficient_scope body", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("https://relayauth.test/v1/tokens/workspace-path");
      return new Response(
        JSON.stringify({ error: "insufficient_scope", code: "insufficient_scope" }),
        { status: 403 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(request(), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "scope_insufficient",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails before minting when the server RelayAuth API key is missing", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    mocks.resolveRelayAuthConfig.mockReturnValue({
      relayAuthUrl: "https://relayauth.test",
      relayAuthApiKey: "",
    });

    const response = await POST(request(), context());

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "RelayAuth API key is not configured",
      code: "relayauth_api_key_missing",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
