import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mintPathScopedRelayfileTokenPair: vi.fn(),
  mintWorkspacePathScopedRelayfileTokenPair: vi.fn(),
  mintWorkspaceScopedRelayfileTokenPair: vi.fn(),
  resolveRelayAuthConfig: vi.fn(),
  resolveRelayfileConfig: vi.fn(),
  resolveRelayfileCredentialWorkspaceId: vi.fn(),
}));

vi.mock("@cloud/core/relayfile/client.js", () => ({
  mintPathScopedRelayfileTokenPair: mocks.mintPathScopedRelayfileTokenPair,
  mintWorkspacePathScopedRelayfileTokenPair: mocks.mintWorkspacePathScopedRelayfileTokenPair,
  mintWorkspaceScopedRelayfileTokenPair: mocks.mintWorkspaceScopedRelayfileTokenPair,
}));

vi.mock("@/lib/relayfile", () => ({
  resolveRelayAuthConfig: mocks.resolveRelayAuthConfig,
  resolveRelayfileConfig: mocks.resolveRelayfileConfig,
}));

vi.mock("./relayfile-integration-push", () => ({
  resolveRelayfileCredentialWorkspaceId: mocks.resolveRelayfileCredentialWorkspaceId,
}));

import {
  mintRuntimeRelayfileCredentials,
  normalizePersonaIntegrationConfigs,
  normalizeRelayfileMountPaths,
  resolveRuntimeRelayfileMountPaths,
} from "./mint-runtime-relayfile-credentials";

const TOKEN_PAIR = {
  accessToken: "relay_ag_runtime",
  refreshToken: "relay_ag_runtime_refresh",
  accessTokenExpiresAt: "2026-06-19T13:30:00.000Z",
  refreshTokenExpiresAt: "2026-09-17T12:30:00.000Z",
  tokenType: "Bearer",
};

describe("resolveRuntimeRelayfileMountPaths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRelayAuthConfig.mockReturnValue({
      relayAuthUrl: "https://relayauth.test",
      relayAuthApiKey: "relay_ws_cloud_minter",
    });
    mocks.resolveRelayfileConfig.mockReturnValue({
      relayfileUrl: "https://relayfile.test",
      relayAuthUrl: "https://relayauth.test",
      relayAuthApiKey: "relay_ws_cloud_minter",
    });
    // Default: pass through workspace ID as-is (covers rw_* inputs)
    mocks.resolveRelayfileCredentialWorkspaceId.mockImplementation((id: string) => Promise.resolve(id));
    mocks.mintPathScopedRelayfileTokenPair.mockResolvedValue({
      ...TOKEN_PAIR,
      accessToken: "relay_pa_runtime",
      refreshToken: "relay_pa_runtime_refresh",
      scopes: ["relayfile:fs:write:/slack/**"],
    });
    mocks.mintWorkspacePathScopedRelayfileTokenPair.mockResolvedValue({
      ...TOKEN_PAIR,
      accessToken: "relay_pa_workspace_path",
      refreshToken: "relay_pa_workspace_path_refresh",
      scopes: ["relayfile:fs:write:/slack/**"],
    });
    mocks.mintWorkspaceScopedRelayfileTokenPair.mockResolvedValue({
      ...TOKEN_PAIR,
      scopes: [
        "relayfile:fs:read:/slack/*",
        "relayfile:fs:write:/slack/*",
        "relayfile:ops:read:*",
      ],
    });
  });

  it("drops degenerate root paths while keeping normal mount paths", () => {
    expect(
      resolveRuntimeRelayfileMountPaths({
        relayfileMountPaths: [
          "/",
          "//",
          "///",
          "/**",
          "/*",
          "*",
          "",
          " ",
          "////**",
          "/github/repos/acme/cloud/issues",
        ],
      }),
    ).toEqual(["/github/repos/acme/cloud/issues"]);
  });

  it("drops parent traversal segments while keeping similarly named path segments", () => {
    expect(
      resolveRuntimeRelayfileMountPaths({
        relayfileMountPaths: [
          "/..",
          "/github/../pulls",
          "/packages/..foo",
          "/github/repos/acme/cloud/pulls/",
        ],
      }),
    ).toEqual(["/github/repos/acme/cloud/pulls/**", "/packages/..foo"]);
  });

  it("normalizes relayfile mount paths idempotently", () => {
    const normalized = normalizeRelayfileMountPaths([
      "/github/repos/acme/cloud/pulls/",
      "/github/repos/acme/cloud/pulls/**",
    ]);

    expect(normalized).toEqual(["/github/repos/acme/cloud/pulls/**"]);
    expect(normalizeRelayfileMountPaths(normalized)).toEqual(normalized);
  });

  it("narrows broad GitHub repo mounts to metadata branches", () => {
    const normalized = normalizeRelayfileMountPaths([
      "/github/repos",
      "/github/repos/**",
    ]);

    expect(normalized).toEqual([
      "/github/repos/*/*/checks/**",
      "/github/repos/*/*/issues/**",
      "/github/repos/*/*/pulls/**",
    ]);
    expect(JSON.stringify(normalized)).not.toContain("/contents");
    expect(normalizeRelayfileMountPaths(normalized)).toEqual(normalized);
  });

  it("rejects malformed falsy integration source payloads instead of defaulting", () => {
    for (const source of [0, ""]) {
      expect(
        normalizePersonaIntegrationConfigs({
          github: { source },
        }),
      ).toBeNull();
    }
  });

  it("uses the workspace-scoped mint chain when runtime mount credentials need ops read", async () => {
    const credentials = await mintRuntimeRelayfileCredentials({
      workspaceId: "rw_runtime",
      useRelayAuthApiKey: true,
      relayfileMountPaths: ["/slack/**"],
      ttlSeconds: 1800,
      agentName: "hn-monitor",
      agentId: "agent_hn",
    });

    expect(mocks.mintWorkspacePathScopedRelayfileTokenPair).not.toHaveBeenCalled();
    expect(mocks.mintWorkspaceScopedRelayfileTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "rw_runtime",
        relayAuthUrl: "https://relayauth.test",
        relayAuthApiKey: "relay_ws_cloud_minter",
        ttlSeconds: 1800,
        agentName: "hn-monitor",
        agentId: "agent_hn",
        scopes: expect.arrayContaining([
          "relayfile:fs:read:/slack/*",
          "relayfile:fs:write:/slack/*",
          "relayfile:ops:read:*",
        ]),
      }),
    );
    const scopes = mocks.mintWorkspaceScopedRelayfileTokenPair.mock.calls[0]?.[0]?.scopes;
    expect(scopes).not.toContain("relayfile:sync:read:*");
    expect(scopes).not.toContain("relayfile:sync:trigger:*");
    expect(scopes).not.toContain("relayfile:fs:read:/slack/**");
    expect(scopes).not.toContain("relayfile:fs:write:/slack/**");
    expect(credentials.relayfileToken).toBe("relay_ag_runtime");
    expect(credentials.relayfileScopes).toEqual(expect.arrayContaining([
      "relayfile:ops:read:*",
    ]));
  });

  it("keeps direct workspace-path mints fs-only when explicit runtime scopes are fs-only", async () => {
    const credentials = await mintRuntimeRelayfileCredentials({
      workspaceId: "rw_runtime",
      useRelayAuthApiKey: true,
      relayfileMountPaths: ["/slack/**"],
      relayfileScopes: ["relayfile:fs:write:/slack/**"],
      ttlSeconds: 1800,
      agentName: "hn-monitor",
    });

    expect(mocks.mintWorkspaceScopedRelayfileTokenPair).not.toHaveBeenCalled();
    expect(mocks.mintWorkspacePathScopedRelayfileTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({
        paths: ["/slack/**"],
        scopes: ["relayfile:fs:write:/slack/**"],
      }),
    );
    expect(JSON.stringify(
      mocks.mintWorkspacePathScopedRelayfileTokenPair.mock.calls[0]?.[0]?.scopes,
    )).not.toContain("relayfile:ops:read:*");
    expect(credentials.relayfileToken).toBe("relay_pa_workspace_path");
  });

  it("translates app workspace UUID to relay workspace ID so tokens target the correct DO", async () => {
    mocks.resolveRelayfileCredentialWorkspaceId.mockResolvedValue("rw_7ccfea89");

    const credentials = await mintRuntimeRelayfileCredentials({
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      useRelayAuthApiKey: true,
      relayfileMountPaths: ["/linear/**"],
      ttlSeconds: 1800,
      agentName: "linear-agent",
    });

    expect(mocks.resolveRelayfileCredentialWorkspaceId).toHaveBeenCalledWith(
      "50587328-441d-4acb-b8f3-dbe1b3c5de99",
    );
    expect(mocks.mintWorkspaceScopedRelayfileTokenPair).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "rw_7ccfea89" }),
    );
    expect(credentials.relayfileWorkspaceId).toBe("rw_7ccfea89");
  });
});
