import { afterEach, describe, expect, it, vi } from "vitest";

const mockSst = vi.hoisted(() => ({
  resources: {} as Record<string, { value?: string }>,
}));

vi.mock("sst", () => ({
  Resource: mockSst.resources,
}));

async function loadRelayWorkspaces() {
  vi.resetModules();
  return import("./relay-workspaces");
}

function relayfileTokenPair(accessToken: string) {
  return {
    accessToken,
    accessTokenExpiresAt: "2027-01-15T08:00:00.000Z",
    refreshToken: "relay_pa_refresh-token",
    refreshTokenExpiresAt: "2027-01-16T08:00:00.000Z",
    tokenType: "Bearer",
  };
}

describe("mintPathScopedRelayfileTokenWithWorkspaceCache", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    for (const key of Object.keys(mockSst.resources)) {
      delete mockSst.resources[key];
    }
  });

  it("evicts a stale cached workspace token on downstream 401 and retries with a fresh mint", async () => {
    vi.stubEnv("WEB_RELAYAUTH_URL", "https://relayauth.test");
    vi.stubEnv("WEB_RELAYAUTH_API_KEY", "org-api-key");

    const workspaceTokens = ["relay_ws_stale", "relay_ws_fresh"];
    const pathAuthorizations: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      if (url === "https://relayauth.test/v1/tokens/workspace") {
        return Response.json({ key: workspaceTokens.shift() });
      }
      if (url === "https://relayauth.test/v1/tokens/path") {
        pathAuthorizations.push(headers.get("authorization") ?? "");
        if (pathAuthorizations.length === 1) {
          return new Response(
            "unauthorized: authentication failed: Bearer token is invalid",
            { status: 401 },
          );
        }
        return Response.json(relayfileTokenPair("relay_pa_fresh"));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { mintPathScopedRelayfileTokenWithWorkspaceCache } = await loadRelayWorkspaces();

    await expect(mintPathScopedRelayfileTokenWithWorkspaceCache({
      workspaceId: "rw_123",
      relayAuthUrl: "https://relayauth.test",
      paths: ["/workspace"],
      agentName: "pr-reviewer",
    })).resolves.toBe("relay_pa_fresh");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url === "https://relayauth.test/v1/tokens/workspace")).toHaveLength(2);
    expect(pathAuthorizations).toEqual([
      "Bearer relay_ws_stale",
      "Bearer relay_ws_fresh",
    ]);
  });

  it("does not evict or retry path-scoped token mint failures that are not authorization failures", async () => {
    vi.stubEnv("WEB_RELAYAUTH_URL", "https://relayauth.test");
    vi.stubEnv("WEB_RELAYAUTH_API_KEY", "org-api-key");

    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://relayauth.test/v1/tokens/workspace") {
        return Response.json({ key: "relay_ws_cached" });
      }
      if (url === "https://relayauth.test/v1/tokens/path") {
        return new Response("bad scope", { status: 403 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { mintPathScopedRelayfileTokenWithWorkspaceCache } = await loadRelayWorkspaces();

    await expect(mintPathScopedRelayfileTokenWithWorkspaceCache({
      workspaceId: "rw_123",
      relayAuthUrl: "https://relayauth.test",
      paths: ["/workspace"],
      agentName: "pr-reviewer",
    })).rejects.toThrow("relayauth path-token mint failed: 403 bad scope");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls
      .map(([input]) => String(input))
      .filter((url) => url === "https://relayauth.test/v1/tokens/workspace")).toHaveLength(1);
  });
});

describe("compileJoinAccess", () => {
  it("mints narrow scopes for selected Slack DM user-message paths", async () => {
    const { compileJoinAccess } = await loadRelayWorkspaces();

    const access = compileJoinAccess(
      "dm-agent",
      [
        "relayfile:fs:read:/slack/users/U123/messages/**",
        "relayfile:fs:write:/slack/users/U123/messages/**",
      ],
      { ignored: [], readonly: [] },
    );

    expect(access.publicScopes).toEqual([
      "relayfile:fs:read:/slack/users/U123/messages/**",
      "relayfile:fs:write:/slack/users/U123/messages/**",
    ]);
    expect(access.tokenScopes).toEqual(expect.arrayContaining([
      "fs:read",
      "fs:write",
      "sync:read",
      "sync:trigger",
      "ops:read",
      "workspace:dm-agent:read:/slack/users/U123/messages/**",
      "workspace:dm-agent:write:/slack/users/U123/messages/**",
    ]));
    expect(access.tokenScopes).not.toContain(
      "workspace:dm-agent:read:/slack/channels/D123/messages/**",
    );
    expect(access.tokenScopes).not.toContain(
      "workspace:dm-agent:write:/slack/users/U999/messages/**",
    );

    // The 4-segment scopes for the strict RelayAuth mint chain: path-scoped fs
    // grants + `relayfile:`-plane capability scopes, and NO bare or
    // `workspace:`-plane scopes (RelayAuth's `parseScope` rejects those).
    expect(access.relayAuthTokenScopes).toEqual(expect.arrayContaining([
      "relayfile:fs:read:/slack/users/U123/messages/**",
      "relayfile:fs:write:/slack/users/U123/messages/**",
      "relayfile:sync:read:*",
      "relayfile:sync:trigger:*",
      "relayfile:ops:read:*",
    ]));
    expect(JSON.stringify(access.relayAuthTokenScopes)).not.toContain("workspace:");
    expect(access.relayAuthTokenScopes).not.toContain("fs:read");
    expect(access.hasDenyOverrides).toBe(false);
  });

  it("flags hasDenyOverrides when a readonly override produces a per-path deny", async () => {
    const { compileJoinAccess } = await loadRelayWorkspaces();

    const access = compileJoinAccess(
      "broad-agent",
      ["relayfile:fs:read:*", "relayfile:fs:write:*"],
      { ignored: [], readonly: ["/protected/**"] },
    );

    // The broad write grant intersects the readonly path, but the durable deny
    // tag is now a RelayAuth-safe 4-segment relayfile scope. The daemon
    // semantically matches it against the token's broad relayfile write grant.
    expect(access.hasDenyOverrides).toBe(true);
    expect(access.aclPermissions).toContain("deny:scope:relayfile:fs:write:/protected/*");
    expect(JSON.stringify(access.aclPermissions)).not.toContain("deny:scope:workspace:");
  });
});
