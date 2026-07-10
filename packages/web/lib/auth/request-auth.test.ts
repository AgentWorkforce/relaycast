import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthContext: vi.fn(),
  readSessionFromRequest: vi.fn((..._args: unknown[]): unknown | null => null),
  resolveApiTokenSession: vi.fn(),
}));

vi.mock("sst", () => ({
  Resource: {
    AuthSessionSecret: { value: "test-session-secret" },
    SageCloudApiToken: { value: "" },
    CatalogingCloudApiToken: { value: "" },
  },
}));

vi.mock("@relayauth/sdk", () => ({
  TokenVerifier: class {
    async verifyOrNull() {
      return null;
    }
  },
}));

vi.mock("./api-token-store", () => ({
  resolveApiTokenSession: mocks.resolveApiTokenSession,
}));

vi.mock("./session", () => ({
  readSessionFromRequest: mocks.readSessionFromRequest,
}));

vi.mock("./auth-api", () => ({
  getAuthContext: mocks.getAuthContext,
}));

vi.mock("@/lib/workflows", () => ({}));

import {
  canAccessWorkflowRun,
  DIGEST_FUNCTIONS_MANAGE_SCOPE,
  FOLLOW_USER_WORKSPACE_SCOPE,
  resolveRequestAuth,
  requireDigestFunctionsManageScope,
  requireAuthRunAccess,
  type RequestAuth,
} from "./request-auth";

function makeAuth(overrides: Partial<RequestAuth>): RequestAuth {
  return {
    userId: "u1",
    workspaceId: "w1",
    organizationId: "o1",
    source: "token",
    ...overrides,
  };
}

function request(authHeader: string): Request {
  return new Request("https://cloud.test/api/test", {
    headers: { authorization: authHeader },
  });
}

describe("resolveRequestAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows session auth without workspace context when explicitly requested", async () => {
    mocks.readSessionFromRequest.mockReturnValueOnce({
      userId: "session-user",
      currentWorkspaceId: "missing-workspace",
      currentOrganizationId: "org-1",
      iat: 1,
      exp: 2,
    });
    mocks.getAuthContext.mockRejectedValueOnce(new Error("No active workspace"));

    await expect(
      resolveRequestAuth(
        new Request("https://cloud.test/api/test") as Parameters<typeof resolveRequestAuth>[0],
        { allowMissingWorkspace: true },
      ),
    ).resolves.toMatchObject({
      userId: "session-user",
      workspaceId: "missing-workspace",
      organizationId: "org-1",
      source: "session",
    });
  });

  it("rejects missing workspace session auth by default", async () => {
    mocks.readSessionFromRequest.mockReturnValueOnce({
      userId: "session-user",
      currentWorkspaceId: "missing-workspace",
      currentOrganizationId: "org-1",
      iat: 1,
      exp: 2,
    });
    mocks.getAuthContext.mockRejectedValueOnce(new Error("No active workspace"));

    await expect(
      resolveRequestAuth(
        new Request("https://cloud.test/api/test") as Parameters<typeof resolveRequestAuth>[0],
      ),
    ).rejects.toThrow("No active workspace");
  });

  it("authenticates API token sessions through the lazy token-store branch without broadening unmarked tokens", async () => {
    mocks.resolveApiTokenSession.mockResolvedValueOnce({
      userId: "token-user",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      scopes: ["cli:auth"],
      subjectType: "cli",
      runId: "run-1",
    });

    await expect(
      resolveRequestAuth(request("Bearer cld_at_test") as Parameters<typeof resolveRequestAuth>[0]),
    ).resolves.toMatchObject({
      userId: "token-user",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "token",
      bearerToken: "cld_at_test",
      scopes: ["cli:auth"],
      subjectType: "cli",
      runId: "run-1",
    });
    expect(mocks.resolveApiTokenSession).toHaveBeenCalledWith("cld_at_test");
    expect(mocks.getAuthContext).not.toHaveBeenCalled();
  });

  it("canonicalizes follow-user CLI token sessions with stale workspace ids to the accessible app workspace", async () => {
    mocks.resolveApiTokenSession.mockResolvedValueOnce({
      userId: "token-user",
      workspaceId: "00000000-0000-4000-8000-000000000099",
      organizationId: "legacy-org",
      scopes: ["cli:auth", FOLLOW_USER_WORKSPACE_SCOPE],
      subjectType: "cli",
      runId: null,
    });
    mocks.getAuthContext.mockResolvedValueOnce({
      user: { id: "token-user" },
      currentOrganization: { id: "org-1" },
      currentWorkspace: { id: "50587328-441d-4acb-b8f3-dbe1b3c5de99" },
    });

    await expect(
      resolveRequestAuth(request("Bearer cld_at_test") as Parameters<typeof resolveRequestAuth>[0]),
    ).resolves.toMatchObject({
      userId: "token-user",
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      organizationId: "org-1",
      source: "token",
      scopes: ["cli:auth", FOLLOW_USER_WORKSPACE_SCOPE],
      subjectType: "cli",
      context: {
        currentWorkspace: { id: "50587328-441d-4acb-b8f3-dbe1b3c5de99" },
      },
    });
    expect(mocks.getAuthContext).toHaveBeenCalledWith(
      "token-user",
      "00000000-0000-4000-8000-000000000099",
      "legacy-org",
    );
  });

  it("does not canonicalize workspace-scoped sandbox tokens to sibling workspaces", async () => {
    mocks.resolveApiTokenSession.mockResolvedValueOnce({
      userId: "token-user",
      workspaceId: "00000000-0000-4000-8000-000000000099",
      organizationId: "legacy-org",
      scopes: ["workflow:invoke:write"],
      subjectType: "sandbox",
      runId: "run-1",
    });

    await expect(
      resolveRequestAuth(request("Bearer cld_at_test") as Parameters<typeof resolveRequestAuth>[0]),
    ).resolves.toMatchObject({
      userId: "token-user",
      workspaceId: "00000000-0000-4000-8000-000000000099",
      organizationId: "legacy-org",
      source: "token",
      scopes: ["workflow:invoke:write"],
      subjectType: "sandbox",
      runId: "run-1",
    });
    expect(mocks.getAuthContext).not.toHaveBeenCalled();
  });

  it("allows API token auth without workspace context when explicitly requested", async () => {
    mocks.resolveApiTokenSession.mockResolvedValueOnce({
      userId: "token-user",
      workspaceId: "00000000-0000-4000-8000-000000000099",
      organizationId: "legacy-org",
      scopes: ["cli:auth", FOLLOW_USER_WORKSPACE_SCOPE],
      subjectType: "cli",
      runId: null,
    });
    mocks.getAuthContext.mockRejectedValueOnce(new Error("No active workspace"));

    await expect(
      resolveRequestAuth(request("Bearer cld_at_test") as Parameters<typeof resolveRequestAuth>[0], {
        allowMissingWorkspace: true,
      }),
    ).resolves.toMatchObject({
      userId: "token-user",
      workspaceId: "00000000-0000-4000-8000-000000000099",
      organizationId: "legacy-org",
      source: "token",
      scopes: ["cli:auth", FOLLOW_USER_WORKSPACE_SCOPE],
      subjectType: "cli",
    });
  });

  it("fails closed when the lazy API token session resolver errors", async () => {
    mocks.resolveApiTokenSession.mockRejectedValueOnce(new Error("db unavailable"));

    await expect(
      resolveRequestAuth(request("Bearer cld_at_test") as Parameters<typeof resolveRequestAuth>[0]),
    ).rejects.toThrow("db unavailable");
  });
});

describe("requireDigestFunctionsManageScope", () => {
  it("returns true for session-authenticated callers regardless of scopes", () => {
    const auth = makeAuth({ source: "session", scopes: undefined });
    expect(requireDigestFunctionsManageScope(auth)).toBe(true);
  });

  it("returns true for token auth when scopes include the manage scope", () => {
    const auth = makeAuth({
      source: "token",
      scopes: [DIGEST_FUNCTIONS_MANAGE_SCOPE],
    });
    expect(requireDigestFunctionsManageScope(auth)).toBe(true);
  });

  it("returns false for token auth with unrelated scopes only", () => {
    const auth = makeAuth({ source: "token", scopes: ["cli:auth"] });
    expect(requireDigestFunctionsManageScope(auth)).toBe(false);
  });

  it("returns false for token auth with empty scopes", () => {
    const auth = makeAuth({ source: "token", scopes: [] });
    expect(requireDigestFunctionsManageScope(auth)).toBe(false);
  });

  it("returns false when auth is null", () => {
    expect(requireDigestFunctionsManageScope(null)).toBe(false);
  });

  it("returns true for relayfile JWT callers that hold the manage scope", () => {
    const auth = makeAuth({
      source: "relayfile",
      scopes: [DIGEST_FUNCTIONS_MANAGE_SCOPE],
    });
    expect(requireDigestFunctionsManageScope(auth)).toBe(true);
  });

  it("pins the literal scope string", () => {
    expect(DIGEST_FUNCTIONS_MANAGE_SCOPE).toBe("workflow:digest-functions:manage");
  });

  it("pins the follow-user workspace scope string", () => {
    expect(FOLLOW_USER_WORKSPACE_SCOPE).toBe("auth:workspace:follow-user");
  });
});

describe("requireAuthRunAccess", () => {
  it("allows non-session auth when the token is not bound to a specific run", () => {
    const auth = makeAuth({ source: "relayfile", runId: null });
    expect(requireAuthRunAccess(auth, "run-1")).toBe(true);
  });

  it("rejects non-session auth when the token is bound to a different run", () => {
    const auth = makeAuth({ source: "relayfile", runId: "run-2" });
    expect(requireAuthRunAccess(auth, "run-1")).toBe(false);
  });
});

describe("canAccessWorkflowRun", () => {
  it("allows relayfile delegated callers to read deployer-owned runs in the same workspace", () => {
    const auth = makeAuth({
      source: "relayfile",
      userId: "agent-user",
      workspaceId: "workspace-1",
      relayfileSponsorId: "agent-1",
      runId: null,
    });

    expect(
      canAccessWorkflowRun(auth, {
        runId: "run-1",
        userId: "deployer-user",
        workspaceId: "workspace-1",
      }),
    ).toBe(true);
  });

  it("rejects relayfile delegated callers for runs in another workspace", () => {
    const auth = makeAuth({
      source: "relayfile",
      userId: "agent-user",
      workspaceId: "workspace-1",
      relayfileSponsorId: "agent-1",
      runId: null,
    });

    expect(
      canAccessWorkflowRun(auth, {
        runId: "run-1",
        userId: "deployer-user",
        workspaceId: "workspace-2",
      }),
    ).toBe(false);
  });

  it("keeps user ownership checks for non-relayfile token auth", () => {
    const auth = makeAuth({
      source: "token",
      userId: "agent-user",
      workspaceId: "workspace-1",
      runId: null,
    });

    expect(
      canAccessWorkflowRun(auth, {
        runId: "run-1",
        userId: "deployer-user",
        workspaceId: "workspace-1",
      }),
    ).toBe(false);

    expect(
      canAccessWorkflowRun(auth, {
        runId: "run-1",
        userId: "agent-user",
        workspaceId: "workspace-2",
      }),
    ).toBe(true);
  });
});
