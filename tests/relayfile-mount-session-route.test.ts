import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "rw_12345678";
const OTHER_WORKSPACE_ID = "rw_87654321";
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

const {
  createCloudWorkspaceRegistryMock,
  createWorkspaceJoinAccessMock,
  getAuthContextMock,
  hasWorkspaceOwnerAccessMock,
  readSessionFromRequestMock,
  relayfileVerifyMock,
  registryGetMock,
  resolveApiTokenSessionMock,
} = vi.hoisted(() => ({
  createCloudWorkspaceRegistryMock: vi.fn(),
  createWorkspaceJoinAccessMock: vi.fn(),
  getAuthContextMock: vi.fn(),
  hasWorkspaceOwnerAccessMock: vi.fn(),
  readSessionFromRequestMock: vi.fn(),
  relayfileVerifyMock: vi.fn(),
  registryGetMock: vi.fn(),
  resolveApiTokenSessionMock: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    AuthSessionSecret: { value: "test-auth-session-secret" },
  },
}));

vi.mock("next/server", () => ({
  NextRequest: Request,
  NextResponse: {
    json(body: unknown, init?: { status?: number }) {
      return new Response(JSON.stringify(body), {
        status: init?.status ?? 200,
        headers: {
          "Content-Type": "application/json",
        },
      });
    },
  },
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  readBearerToken(authHeader: string | null): string | null {
    if (!authHeader) {
      return null;
    }

    const trimmed = authHeader.trim();
    if (!trimmed.toLowerCase().startsWith("bearer ")) {
      return null;
    }

    const token = trimmed.slice(7).trim();
    return token.length > 0 ? token : null;
  },
  resolveApiTokenSession: (...args: unknown[]) =>
    resolveApiTokenSessionMock(...args),
}));

vi.mock("@/lib/auth/session", () => ({
  readSessionFromRequest: (...args: unknown[]) =>
    readSessionFromRequestMock(...args),
}));

vi.mock("@relayauth/sdk", () => ({
  TokenVerifier: class {
    async verifyOrNull(token: string) {
      return relayfileVerifyMock(token);
    }
  },
}));

vi.mock("../packages/web/lib/auth/auth-api.ts", () => ({
  getAuthContext: (...args: unknown[]) => getAuthContextMock(...args),
}));

vi.mock("@/lib/relay-workspaces", () => ({
  areValidRequestedScopes: (scopes: unknown) =>
    Array.isArray(scopes) &&
    scopes.length > 0 &&
    scopes.every(
      (scope) =>
        typeof scope === "string" &&
        /^relayfile:fs:(read|write)(?::.+)?$/i.test(scope),
    ),
  createWorkspaceJoinAccess: (...args: unknown[]) =>
    createWorkspaceJoinAccessMock(...args),
  isValidWorkspaceId: (workspaceId: string) => /^rw_[a-z0-9]{8}$/i.test(workspaceId),
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: (...args: unknown[]) =>
    createCloudWorkspaceRegistryMock(...args),
  hasWorkspaceOwnerAccess: (...args: unknown[]) =>
    hasWorkspaceOwnerAccessMock(...args),
  resolveConfiguredRelaycastUrl: () =>
    process.env.RELAYCAST_URL ?? process.env.RELAYCAST_API_URL,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess(
    auth: {
      source: string;
      workspaceId: string;
      context?: { workspaces?: Array<{ id: string }> };
    } | null,
    workspaceId: string,
  ) {
    if (!auth) {
      return false;
    }

    if (auth.source === "session") {
      return auth.context?.workspaces?.some((workspace) => workspace.id === workspaceId) ?? false;
    }

    return auth.workspaceId === workspaceId;
  },
}));

type MountSessionRouteModule = {
  POST: (
    request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => Promise<Response>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function mintRelayfileToken(
  workspaceId: string,
  scopes: string[] = ["fs:read", "fs:write"],
) {
  const token = `relayfile:${workspaceId}:${scopes.join(",")}`;
  relayfileVerifyMock.mockImplementation(async (candidate: string) => {
    if (candidate !== token) {
      return null;
    }

    return {
      sub: "agent-test",
      org: "org-test",
      wks: workspaceId,
      scopes,
    };
  });
  return token;
}

async function buildRouteRequest(
  workspaceId = WORKSPACE_ID,
  options?: {
    bearerToken?: string;
    body?: Record<string, unknown>;
  },
): Promise<Request> {
  return new Request(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/relayfile/mount-session`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options?.bearerToken
          ? { Authorization: `Bearer ${options.bearerToken}` }
          : {}),
      },
      body: JSON.stringify(
        options?.body ?? {
          localDir: "/tmp/project",
        },
      ),
    },
  );
}

function routeContext(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

async function loadRoute(): Promise<MountSessionRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/relayfile/mount-session/route.ts",
      import.meta.url,
    ).href
  ) as Promise<MountSessionRouteModule>;
}

beforeEach(() => {
  vi.doUnmock("@/lib/auth/request-auth");
  createCloudWorkspaceRegistryMock.mockReset();
  createWorkspaceJoinAccessMock.mockReset();
  getAuthContextMock.mockReset();
  hasWorkspaceOwnerAccessMock.mockReset();
  readSessionFromRequestMock.mockReset();
  relayfileVerifyMock.mockReset();
  registryGetMock.mockReset();
  resolveApiTokenSessionMock.mockReset();

  readSessionFromRequestMock.mockReturnValue(null);
  resolveApiTokenSessionMock.mockResolvedValue(null);
  getAuthContextMock.mockResolvedValue({
    user: { id: "user_123" },
    currentWorkspace: { id: WORKSPACE_ID },
    currentOrganization: { id: "org_123" },
    workspaces: [{ id: WORKSPACE_ID }],
  });
  hasWorkspaceOwnerAccessMock.mockReturnValue(false);
  registryGetMock.mockResolvedValue({
    id: WORKSPACE_ID,
    createdBy: "user_123",
    relaycastApiKey: "rk_live_workspace",
    permissions: { ignored: [], readonly: [] },
  });
  createCloudWorkspaceRegistryMock.mockReturnValue({
    registry: {
      get: registryGetMock,
    },
  });
  createWorkspaceJoinAccessMock.mockResolvedValue({
    token: "relayfile-token",
    relayfileUrl: "https://relayfile.test",
    wsUrl: `wss://relayfile.test/v1/workspaces/${WORKSPACE_ID}/fs/ws`,
    scopes: ["relayfile:fs:read:*", "relayfile:fs:write:*"],
    tokenIssuedAt: "2026-05-09T09:55:00.000Z",
    tokenExpiresAt: "2026-05-09T11:55:00.000Z",
    suggestedRefreshAt: "2026-05-09T11:40:00.000Z",
  });

  vi.stubEnv("RELAYCAST_URL", "https://relaycast.staging.test");
});

afterEach(() => {
  vi.doUnmock("@/lib/auth/request-auth");
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("relayfile mount-session route", () => {
  it("returns a mount session for authenticated session callers", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    hasWorkspaceOwnerAccessMock.mockReturnValue(true);
    const { POST } = await loadRoute();

    const response = await POST(await buildRouteRequest(), routeContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      relayfileBaseUrl: "https://relayfile.test",
      relayfileToken: "relayfile-token",
      wsUrl: `wss://relayfile.test/v1/workspaces/${WORKSPACE_ID}/fs/ws`,
      remotePath: "/",
      localDir: "/tmp/project",
      mode: "poll",
      scopes: ["relayfile:fs:read:*", "relayfile:fs:write:*"],
      tokenIssuedAt: "2026-05-09T09:55:00.000Z",
      expiresAt: "2026-05-09T11:55:00.000Z",
      suggestedRefreshAt: "2026-05-09T11:40:00.000Z",
      relaycastApiKey: "rk_live_workspace",
      relaycastBaseUrl: "https://relaycast.staging.test",
    });
    expect(createWorkspaceJoinAccessMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      agentName: "relayfile-mount",
      requestedScopes: undefined,
      permissions: { ignored: [], readonly: [] },
    });
  });

  it("returns narrowed scopes when a same-workspace relayfile caller requests a subset", async () => {
    const token = mintRelayfileToken(WORKSPACE_ID, ["relayfile:fs:read:/src/*"]);
    createWorkspaceJoinAccessMock.mockResolvedValueOnce({
      token: "relayfile-token-scoped",
      relayfileUrl: "https://relayfile.test",
      wsUrl: `wss://relayfile.test/v1/workspaces/${WORKSPACE_ID}/fs/ws`,
      scopes: ["relayfile:fs:read:/src/*"],
      tokenIssuedAt: "2026-05-09T09:55:00.000Z",
      tokenExpiresAt: "2026-05-09T11:55:00.000Z",
      suggestedRefreshAt: "2026-05-09T11:40:00.000Z",
    });
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        bearerToken: token,
        body: {
          localDir: "/tmp/project",
          scopes: ["relayfile:fs:read:/src/*"],
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      scopes: ["relayfile:fs:read:/src/*"],
    });
    expect(createWorkspaceJoinAccessMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      agentName: "relayfile-mount",
      requestedScopes: ["relayfile:fs:read:/src/*"],
      permissions: { ignored: [], readonly: [] },
    });
  });

  it("preserves explicit wildcard mount-session scopes", async () => {
    const token = mintRelayfileToken(WORKSPACE_ID, [
      "relayfile:fs:read:*",
      "relayfile:fs:write:*",
    ]);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        bearerToken: token,
        body: {
          localDir: "/tmp/project",
          scopes: ["relayfile:fs:read:*", "relayfile:fs:write:*"],
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(createWorkspaceJoinAccessMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      agentName: "relayfile-mount",
      requestedScopes: ["relayfile:fs:read:*", "relayfile:fs:write:*"],
      permissions: { ignored: [], readonly: [] },
    });
  });

  it("keeps default token scoping for non-GitHub mount sessions without explicit scopes", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    hasWorkspaceOwnerAccessMock.mockReturnValue(true);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        body: {
          localDir: "/tmp/project",
          remotePath: "/linear/issues",
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(createWorkspaceJoinAccessMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      agentName: "relayfile-mount",
      requestedScopes: undefined,
      permissions: { ignored: [], readonly: [] },
    });
  });

  it("scopes GitHub repo-root mount sessions to metadata branches instead of contents", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    hasWorkspaceOwnerAccessMock.mockReturnValue(true);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        body: {
          localDir: "/tmp/project",
          remotePath: "/github/repos",
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(createWorkspaceJoinAccessMock).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      agentName: "relayfile-mount",
      requestedScopes: [
        "relayfile:fs:read:/github/repos/*/*/checks/**",
        "relayfile:fs:write:/github/repos/*/*/checks/**",
        "relayfile:fs:read:/github/repos/*/*/issues/**",
        "relayfile:fs:write:/github/repos/*/*/issues/**",
        "relayfile:fs:read:/github/repos/*/*/pulls/**",
        "relayfile:fs:write:/github/repos/*/*/pulls/**",
      ],
      permissions: { ignored: [], readonly: [] },
    });
    const mintInput = createWorkspaceJoinAccessMock.mock.calls[0]?.[0] as {
      requestedScopes?: string[];
    };
    expect(JSON.stringify(mintInput.requestedScopes)).not.toContain("/contents");
  });

  it("narrows explicit broad GitHub repo scopes before minting mount-session tokens", async () => {
    const token = mintRelayfileToken(WORKSPACE_ID, [
      "relayfile:fs:read:/github/repos/**",
      "relayfile:fs:write:/github/repos/**",
    ]);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        bearerToken: token,
        body: {
          localDir: "/tmp/project",
          remotePath: "/github/repos",
          scopes: [
            "relayfile:fs:read:/github/repos/**",
            "relayfile:fs:write:/github/repos/**",
          ],
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    const mintInput = createWorkspaceJoinAccessMock.mock.calls[0]?.[0] as {
      requestedScopes?: string[];
    };
    expect(mintInput.requestedScopes).toEqual([
      "relayfile:fs:read:/github/repos/*/*/checks/**",
      "relayfile:fs:read:/github/repos/*/*/issues/**",
      "relayfile:fs:read:/github/repos/*/*/pulls/**",
      "relayfile:fs:write:/github/repos/*/*/checks/**",
      "relayfile:fs:write:/github/repos/*/*/issues/**",
      "relayfile:fs:write:/github/repos/*/*/pulls/**",
    ]);
    expect(JSON.stringify(mintInput.requestedScopes)).not.toContain("/contents");
  });

  it("accepts workspace-scoped API tokens", async () => {
    resolveApiTokenSessionMock.mockResolvedValue({
      userId: "user_123",
      workspaceId: WORKSPACE_ID,
      organizationId: "org_123",
      scopes: ["cli:auth"],
      subjectType: "cli",
      runId: null,
    });
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, { bearerToken: "cld_at_test" }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(createWorkspaceJoinAccessMock).toHaveBeenCalledOnce();
  });

  it("accepts a verified relayfile JWT for the same workspace", async () => {
    const token = mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, { bearerToken: token }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(createWorkspaceJoinAccessMock).toHaveBeenCalledOnce();
  });

  it("accepts a verified relayfile JWT for an anonymous workspace", async () => {
    registryGetMock.mockResolvedValueOnce({
      id: WORKSPACE_ID,
      createdBy: NIL_UUID,
      relaycastApiKey: "rk_live_workspace",
      permissions: { ignored: [], readonly: [] },
    });
    const token = mintRelayfileToken(WORKSPACE_ID);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, { bearerToken: token }),
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(createWorkspaceJoinAccessMock).toHaveBeenCalledOnce();
  });

  it("returns 401 when auth is missing", async () => {
    const { POST } = await loadRoute();

    const response = await POST(await buildRouteRequest(), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 401 when a relayfile bearer token is invalid", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        bearerToken: "relayfile:invalid",
      }),
      routeContext(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 401 when auth is missing for an anonymous workspace", async () => {
    registryGetMock.mockResolvedValueOnce({
      id: WORKSPACE_ID,
      createdBy: NIL_UUID,
      relaycastApiKey: "rk_live_workspace",
      permissions: { ignored: [], readonly: [] },
    });
    const { POST } = await loadRoute();

    const response = await POST(await buildRouteRequest(), routeContext());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "unauthorized" });
  });

  it("returns 404 for workspace-scoped auth bound to a different non-anonymous workspace", async () => {
    const token = mintRelayfileToken(OTHER_WORKSPACE_ID);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, { bearerToken: token }),
      routeContext(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "workspace_not_found" });
    expect(createWorkspaceJoinAccessMock).not.toHaveBeenCalled();
  });

  it("returns 403 for foreign relayfile auth on an anonymous workspace", async () => {
    registryGetMock.mockResolvedValueOnce({
      id: WORKSPACE_ID,
      createdBy: NIL_UUID,
      relaycastApiKey: "rk_live_workspace",
      permissions: { ignored: [], readonly: [] },
    });
    const token = mintRelayfileToken(OTHER_WORKSPACE_ID);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, { bearerToken: token }),
      routeContext(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "forbidden" });
    expect(createWorkspaceJoinAccessMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace is unknown", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    registryGetMock.mockResolvedValueOnce(null);
    const { POST } = await loadRoute();

    const response = await POST(await buildRouteRequest(), routeContext());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "workspace_not_found" });
  });

  it("rejects missing localDir", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, { body: { remotePath: "/src" } }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_local_dir" });
  });

  it.each([
    "/",
    "..",
    "/tmp/../escape",
    "bad\0path",
    "a".repeat(1025),
  ])("rejects dangerous localDir %j", async (localDir) => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        body: {
          localDir,
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_local_dir" });
  });

  it("rejects unsupported mount modes", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        body: {
          localDir: "/tmp/project",
          mode: "stream",
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_mode" });
  });

  it("rejects malformed remotePath values", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        body: {
          localDir: "/tmp/project",
          remotePath: "/path/../../escape",
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_remote_path" });
  });

  it("maps token expiry fields and omits provider secrets from the response", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    hasWorkspaceOwnerAccessMock.mockReturnValue(true);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        body: {
          localDir: "/tmp/project",
          remotePath: "src/worktree/",
          mode: "fuse",
        },
      }),
      routeContext(),
    );
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body.expiresAt).toBe("2026-05-09T11:55:00.000Z");
    expect(body.suggestedRefreshAt).toBe("2026-05-09T11:40:00.000Z");
    expect(body.remotePath).toBe("/src/worktree");
    expect(body.mode).toBe("fuse");
    expect(body).not.toHaveProperty("relayAuthApiKey");
    expect(body).not.toHaveProperty("accessToken");
    expect(body).not.toHaveProperty("refreshToken");
    expect(body).not.toHaveProperty("providerSecret");
  });

  it("omits relaycastBaseUrl when the Cloud config does not set one", async () => {
    readSessionFromRequestMock.mockReturnValue({
      userId: "user_123",
      currentWorkspaceId: WORKSPACE_ID,
    });
    hasWorkspaceOwnerAccessMock.mockReturnValue(true);
    vi.unstubAllEnvs();
    const { POST } = await loadRoute();

    const response = await POST(await buildRouteRequest(), routeContext());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("relaycastBaseUrl");
  });

  it("rejects requested scopes that exceed the caller grant", async () => {
    const token = mintRelayfileToken(WORKSPACE_ID, ["fs:read"]);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        bearerToken: token,
        body: {
          localDir: "/tmp/project",
          scopes: ["relayfile:fs:write:/src/*"],
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_scopes" });
    expect(createWorkspaceJoinAccessMock).not.toHaveBeenCalled();
  });

  it("rejects requested scopes that do not normalize as relayfile scopes", async () => {
    const token = mintRelayfileToken(WORKSPACE_ID, ["fs:read"]);
    const { POST } = await loadRoute();

    const response = await POST(
      await buildRouteRequest(WORKSPACE_ID, {
        bearerToken: token,
        body: {
          localDir: "/tmp/project",
          scopes: ["relayauth:token:manage:foo"],
        },
      }),
      routeContext(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_scopes" });
    expect(createWorkspaceJoinAccessMock).not.toHaveBeenCalled();
  });
});
