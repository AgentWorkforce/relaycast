import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const WORKSPACE_ID = "rw_12345678";

const {
  createCloudWorkspaceRegistryMock,
  hasWorkspaceOwnerAccessMock,
  registryGetMock,
  registryJoinMock,
  requireAuthScopeMock,
  requireSessionAuthMock,
  resolveRequestAuthMock,
} = vi.hoisted(() => ({
  createCloudWorkspaceRegistryMock: vi.fn(),
  hasWorkspaceOwnerAccessMock: vi.fn(),
  registryGetMock: vi.fn(),
  registryJoinMock: vi.fn(),
  requireAuthScopeMock: vi.fn(),
  requireSessionAuthMock: vi.fn(),
  resolveRequestAuthMock: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: (...args: unknown[]) => resolveRequestAuthMock(...args),
  requireSessionAuth: (...args: unknown[]) => requireSessionAuthMock(...args),
  requireAuthScope: (...args: unknown[]) => requireAuthScopeMock(...args),
}));

vi.mock("@/lib/relay-workspaces", () => ({
  areValidRequestedScopes: (scopes: unknown) =>
    Array.isArray(scopes) && scopes.every((scope) => typeof scope === "string"),
  isValidAgentName: (agentName: string) => agentName.length > 0,
  isValidWorkspaceId: (workspaceId: string) => workspaceId.length > 0,
  normalizeWorkspacePermissions: (permissions: unknown) => permissions,
}));

vi.mock("@/lib/workspace-registry", () => {
  return {
    createCloudWorkspaceRegistry: (...args: unknown[]) =>
      createCloudWorkspaceRegistryMock(...args),
    hasWorkspaceOwnerAccess: (...args: unknown[]) =>
      hasWorkspaceOwnerAccessMock(...args),
    resolveConfiguredRelaycastUrl: () =>
      process.env.RELAYCAST_URL ?? process.env.RELAYCAST_API_URL,
  };
});

type JoinRouteModule = {
  POST: (
    request: Request,
    context: { params: Promise<{ workspaceId: string }> },
  ) => Promise<Response>;
};

function buildJoinRequest(): Request {
  return new Request(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/join`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentName: "golden-agent",
      }),
    },
  );
}

function joinContext() {
  return {
    params: Promise.resolve({ workspaceId: WORKSPACE_ID }),
  };
}

async function loadJoinRoute(): Promise<JoinRouteModule> {
  return import(
    new URL(
      "../packages/web/app/api/v1/workspaces/[workspaceId]/join/route.ts",
      import.meta.url,
    ).href
  ) as Promise<JoinRouteModule>;
}

beforeEach(() => {
  createCloudWorkspaceRegistryMock.mockReset();
  hasWorkspaceOwnerAccessMock.mockReset();
  registryGetMock.mockReset();
  registryJoinMock.mockReset();
  requireAuthScopeMock.mockReset();
  requireSessionAuthMock.mockReset();
  resolveRequestAuthMock.mockReset();

  resolveRequestAuthMock.mockResolvedValue({
    userId: "user_123",
    workspaceId: "ws_local",
    organizationId: "org_123",
    source: "session",
    context: {
      user: { id: "user_123" },
      currentWorkspace: { id: "ws_local" },
      currentOrganization: { id: "org_123" },
      workspaces: [{ id: WORKSPACE_ID }],
    },
  });
  requireSessionAuthMock.mockReturnValue(true);
  requireAuthScopeMock.mockReturnValue(true);
  hasWorkspaceOwnerAccessMock.mockReturnValue(true);
  registryGetMock.mockResolvedValue({
    id: WORKSPACE_ID,
    createdBy: "user_123",
  });
  registryJoinMock.mockResolvedValue({
    entry: { id: WORKSPACE_ID },
    token: "relayfile-token",
    relayfileUrl: "https://relayfile.test",
    wsUrl: `wss://relayfile.test/v1/workspaces/${WORKSPACE_ID}/fs/ws`,
    relaycastApiKey: "rk_live_workspace",
  });
  createCloudWorkspaceRegistryMock.mockReturnValue({
    registry: {
      get: registryGetMock,
      join: registryJoinMock,
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("agent workspace golden path join route", () => {
  it("includes relaycastBaseUrl when cloud has a configured relaycast URL", async () => {
    vi.stubEnv("RELAYCAST_URL", "https://relaycast.staging.test");
    const { POST } = await loadJoinRoute();

    const response = await POST(buildJoinRequest(), joinContext());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId: WORKSPACE_ID,
      token: "relayfile-token",
      relayfileUrl: "https://relayfile.test",
      wsUrl: `wss://relayfile.test/v1/workspaces/${WORKSPACE_ID}/fs/ws`,
      relaycastApiKey: "rk_live_workspace",
      relaycastBaseUrl: "https://relaycast.staging.test",
    });
  });

  it("omits relaycastBaseUrl when cloud relaycast URL is not configured", async () => {
    const { POST } = await loadJoinRoute();

    const response = await POST(buildJoinRequest(), joinContext());
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workspaceId: WORKSPACE_ID,
      token: "relayfile-token",
      relayfileUrl: "https://relayfile.test",
      wsUrl: `wss://relayfile.test/v1/workspaces/${WORKSPACE_ID}/fs/ws`,
      relaycastApiKey: "rk_live_workspace",
    });
    expect(body).not.toHaveProperty("relaycastBaseUrl");
  });
});
