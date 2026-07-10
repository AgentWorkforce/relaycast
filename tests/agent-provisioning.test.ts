import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ProvisionRoute = {
  POST: (request: Request) => Promise<Response>;
};

type WorkspacePermissions = {
  ignored: string[];
  readonly: string[];
};

const resolveRequestAuthMock = vi.fn();
const requireSessionAuthMock = vi.fn();
const requireAuthScopeMock = vi.fn();
const areValidRequestedScopesMock = vi.fn();
const createWorkspaceJoinAccessMock = vi.fn();
const ensureRelayWorkspaceMock = vi.fn();
const getOwnedRelayWorkspaceMock = vi.fn();
const isValidAgentNameMock = vi.fn();
const mergeWorkspacePermissionsMock = vi.fn();
const normalizeWorkspacePermissionsMock = vi.fn();
const assertCloudAgentSpawnQuotaMock = vi.fn();
const getEffectiveCloudAgentSpawnQuotaMock = vi.fn();
const getDbMock = vi.fn();

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: (...args: unknown[]) => resolveRequestAuthMock(...args),
  requireSessionAuth: (...args: unknown[]) => requireSessionAuthMock(...args),
  requireAuthScope: (...args: unknown[]) => requireAuthScopeMock(...args),
}));

vi.mock("@/lib/relay-workspaces", () => ({
  areValidRequestedScopes: (...args: unknown[]) => areValidRequestedScopesMock(...args),
  createWorkspaceJoinAccess: (...args: unknown[]) => createWorkspaceJoinAccessMock(...args),
  ensureRelayWorkspace: (...args: unknown[]) => ensureRelayWorkspaceMock(...args),
  getOwnedRelayWorkspace: (...args: unknown[]) => getOwnedRelayWorkspaceMock(...args),
  isValidAgentName: (...args: unknown[]) => isValidAgentNameMock(...args),
  mergeWorkspacePermissions: (...args: unknown[]) => mergeWorkspacePermissionsMock(...args),
  normalizeWorkspacePermissions: (...args: unknown[]) => normalizeWorkspacePermissionsMock(...args),
}));

vi.mock("@/lib/cloud-agent-quotas", () => ({
  assertCloudAgentSpawnQuota: (...args: unknown[]) => assertCloudAgentSpawnQuotaMock(...args),
  getEffectiveCloudAgentSpawnQuota: (...args: unknown[]) =>
    getEffectiveCloudAgentSpawnQuotaMock(...args),
}));

vi.mock("@/lib/db", () => ({
  getDb: (...args: unknown[]) => getDbMock(...args),
}));

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizePermissions(input?: Partial<WorkspacePermissions>): WorkspacePermissions {
  return {
    ignored: unique(input?.ignored ?? []),
    readonly: unique(input?.readonly ?? []),
  };
}

async function loadRoute(): Promise<ProvisionRoute> {
  const routeUrl = new URL(
    "../packages/web/app/api/v1/agents/provision/route.ts",
    import.meta.url,
  ).href;
  // @ts-ignore Route module is loaded dynamically for isolated mocks.
  return import(routeUrl);
}

beforeEach(() => {
  resolveRequestAuthMock.mockResolvedValue({
    userId: "user_123",
    workspaceId: "ws_local",
    organizationId: "org_123",
    source: "session",
    context: {
      user: { id: "user_123" },
      currentWorkspace: { id: "ws_local" },
      currentOrganization: { id: "org_123" },
    },
  });
  requireSessionAuthMock.mockReturnValue(true);
  requireAuthScopeMock.mockReturnValue(true);
  areValidRequestedScopesMock.mockImplementation(
    (scopes: unknown) =>
      Array.isArray(scopes) &&
      scopes.length > 0 &&
      scopes.every(
        (scope) =>
          typeof scope === "string" &&
          /^relayfile:fs:(read|write)(?::.+)?$/.test(scope),
      ),
  );
  isValidAgentNameMock.mockImplementation((name: string) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name.trim()),
  );
  normalizeWorkspacePermissionsMock.mockImplementation(
    (input?: Partial<WorkspacePermissions>) => normalizePermissions(input),
  );
  mergeWorkspacePermissionsMock.mockImplementation(
    (base: WorkspacePermissions, override?: Partial<WorkspacePermissions>) =>
      normalizePermissions({
        ignored: [...base.ignored, ...(override?.ignored ?? [])],
        readonly: [...base.readonly, ...(override?.readonly ?? [])],
      }),
  );
  ensureRelayWorkspaceMock.mockResolvedValue(undefined);
  assertCloudAgentSpawnQuotaMock.mockReturnValue(undefined);
  getDbMock.mockReturnValue({ mocked: true });
  getEffectiveCloudAgentSpawnQuotaMock.mockResolvedValue({
    enabled: true,
    maxAgentsPerSpawn: 64,
  });
  createWorkspaceJoinAccessMock.mockImplementation(
    async ({
      agentName,
      requestedScopes,
    }: {
      agentName: string;
      requestedScopes?: string[];
    }) => ({
      token: `token-for-${agentName}`,
      scopes: requestedScopes ?? ["relayfile:fs:read:*", "relayfile:fs:write:*"],
    }),
  );
  getOwnedRelayWorkspaceMock.mockResolvedValue({
    id: "rw_12345678",
    ownerUserId: "user_123",
    name: "Project Workspace",
    relaycastApiKey: "relay-api-key",
    permissions: {
      ignored: ["shared-secrets/"],
      readonly: ["LICENSE"],
    },
    createdAt: new Date("2026-03-28T10:00:00.000Z"),
    updatedAt: new Date("2026-03-28T10:00:00.000Z"),
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("agent provisioning route", () => {
  it("returns 401 when unauthenticated", async () => {
    resolveRequestAuthMock.mockResolvedValueOnce(null);
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/agents/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "rw_12345678",
          agents: [{ name: "code-agent" }],
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("returns 403 when token auth lacks cli scope", async () => {
    requireSessionAuthMock.mockReturnValueOnce(false);
    requireAuthScopeMock.mockReturnValueOnce(false);
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/agents/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "rw_12345678",
          agents: [{ name: "code-agent" }],
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Forbidden" });
  });

  it("returns 400 for invalid or duplicate agents", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/agents/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "wf-abc123",
          agents: [
            { name: "code-agent" },
            { name: "code-agent" },
          ],
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid request body" });
    expect(getOwnedRelayWorkspaceMock).not.toHaveBeenCalled();
  });

  it("returns 404 when the workspace is not owned by the caller", async () => {
    getOwnedRelayWorkspaceMock.mockResolvedValueOnce(null);
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/agents/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "rw_12345678",
          agents: [{ name: "code-agent" }],
        }),
      }),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Workspace not found" });
    expect(ensureRelayWorkspaceMock).not.toHaveBeenCalled();
  });

  it("provisions agents with merged workspace and agent permissions", async () => {
    const { POST } = await loadRoute();

    const response = await POST(
      new Request("http://localhost/api/v1/agents/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "rw_12345678",
          agents: [
            {
              name: "code-agent",
              scopes: ["relayfile:fs:read:*", "relayfile:fs:write:/src/*"],
              permissions: {
                ignored: ["secrets/"],
                readonly: ["README.md"],
              },
            },
            {
              name: "reviewer",
              permissions: {
                readonly: ["docs/"],
              },
            },
          ],
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      agents: [
        {
          name: "code-agent",
          token: "token-for-code-agent",
          scopes: ["relayfile:fs:read:*", "relayfile:fs:write:/src/*"],
          workspaceId: "rw_12345678",
        },
        {
          name: "reviewer",
          token: "token-for-reviewer",
          scopes: ["relayfile:fs:read:*", "relayfile:fs:write:*"],
          workspaceId: "rw_12345678",
        },
      ],
    });

    expect(getOwnedRelayWorkspaceMock).toHaveBeenCalledWith("rw_12345678", "user_123");
    expect(ensureRelayWorkspaceMock).toHaveBeenCalledWith("rw_12345678", {
      ignored: ["shared-secrets/"],
      readonly: ["LICENSE"],
    });
    expect(ensureRelayWorkspaceMock.mock.invocationCallOrder[0]).toBeLessThan(
      createWorkspaceJoinAccessMock.mock.invocationCallOrder[0],
    );

    expect(createWorkspaceJoinAccessMock).toHaveBeenNthCalledWith(1, {
      workspaceId: "rw_12345678",
      agentName: "code-agent",
      requestedScopes: ["relayfile:fs:read:*", "relayfile:fs:write:/src/*"],
      permissions: {
        ignored: ["secrets/", "shared-secrets/"],
        readonly: ["LICENSE", "README.md"],
      },
    });
    expect(createWorkspaceJoinAccessMock).toHaveBeenNthCalledWith(2, {
      workspaceId: "rw_12345678",
      agentName: "reviewer",
      requestedScopes: undefined,
      permissions: {
        ignored: ["shared-secrets/"],
        readonly: ["LICENSE", "docs/"],
      },
    });
  });
});
