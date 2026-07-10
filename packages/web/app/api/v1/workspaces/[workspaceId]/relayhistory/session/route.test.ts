import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRelayhistorySession: vi.fn(),
  readAppWorkspaceRelayBinding: vi.fn(),
  resolveRequestAuth: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: (auth: { source?: string } | null) => auth?.source === "session",
  requireAuthScope: (auth: { scopes?: string[] } | null, scope: string) =>
    auth?.scopes?.includes(scope) ?? false,
}));

vi.mock("@/lib/relayhistory-session", () => ({
  createRelayhistorySession: mocks.createRelayhistorySession,
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", () => ({
  isAppWorkspaceId: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  readAppWorkspaceRelayBinding: mocks.readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId: mocks.resolveAppWorkspaceByRelayWorkspaceId,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const ORG_ID = "00000000-0000-0000-0000-000000000003";
const USER_ID = "user_cloud_1";

function request(body?: unknown): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/relayhistory/session`,
    {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

function rawRequest(body: string): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/relayhistory/session`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
  );
}

function context(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

describe("POST /api/v1/workspaces/[workspaceId]/relayhistory/session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
      source: "token",
      scopes: ["cli:auth"],
    });
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
    });
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
      relayWorkspaceId: "rw_test123",
    });
    mocks.createRelayhistorySession.mockResolvedValue({
      baseUrl: "https://history.agentrelay.com",
      accessToken: "rth_at_token",
      accessTokenExpiresAt: "2026-06-22T15:00:00.000Z",
      refreshToken: "rth_rt_token",
      refreshTokenExpiresAt: "2026-09-20T15:00:00.000Z",
      tokenType: "Bearer",
      scopes: ["rth:read", "rth:sync"],
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
    });
  });

  it("401 when unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const response = await POST(request({ mode: "sync" }), context());
    expect(response.status).toBe(401);
  });

  it("403 for relayfile auth even if it carries cli-like scopes", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
      source: "relayfile",
      scopes: ["cli:auth"],
    });
    const response = await POST(request({ mode: "sync" }), context());
    expect(response.status).toBe(403);
    expect(mocks.createRelayhistorySession).not.toHaveBeenCalled();
  });

  it("403 for token auth without cli:auth", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
      source: "token",
      scopes: [],
    });
    const response = await POST(request({ mode: "read" }), context());
    expect(response.status).toBe(403);
  });

  it("allows a read-only relayhistory token to request read mode", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
      source: "token",
      scopes: ["rth:read"],
    });
    const response = await POST(request({ mode: "read" }), context());
    expect(response.status).toBe(200);
    expect(mocks.createRelayhistorySession).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "read" }),
    );
  });

  it("strict-rejects sync mode when the token is only entitled to read", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
      source: "token",
      scopes: ["rth:read"],
    });
    const response = await POST(request({ mode: "sync" }), context());
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "mode_not_authorized" });
    expect(mocks.createRelayhistorySession).not.toHaveBeenCalled();
  });

  it("404 when the caller cannot access the route workspace", async () => {
    const response = await POST(
      request({ mode: "sync" }),
      context("00000000-0000-0000-0000-000000000099"),
    );
    expect(response.status).toBe(404);
    expect(mocks.createRelayhistorySession).not.toHaveBeenCalled();
  });

  it("mints for the accessed app workspace owning organization", async () => {
    const otherWorkspaceId = "00000000-0000-0000-0000-000000000099";
    const otherOrgId = "00000000-0000-0000-0000-000000000088";
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: otherWorkspaceId,
      organizationId: otherOrgId,
      relayWorkspaceId: "rw_other12",
    });
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: USER_ID,
      workspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
      source: "session",
      scopes: [],
      context: {
        user: { id: USER_ID, email: null, name: null, avatarUrl: null },
        organizations: [],
        currentOrganization: { id: ORG_ID, slug: "org-a", name: "Org A", role: "owner", status: "active" },
        currentWorkspace: { id: WORKSPACE_ID, organization_id: ORG_ID, slug: "workspace-a", name: "Workspace A" },
        workspaces: [
          { id: WORKSPACE_ID, organization_id: ORG_ID, slug: "workspace-a", name: "Workspace A" },
          { id: otherWorkspaceId, organization_id: otherOrgId, slug: "workspace-b", name: "Workspace B" },
        ],
      },
    });

    const response = await POST(request({ mode: "sync" }), context(otherWorkspaceId));
    expect(response.status).toBe(200);
    expect(mocks.createRelayhistorySession).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: otherOrgId, workspaceId: otherWorkspaceId }),
    );
  });

  it("404 when token auth targets a workspace in another organization", async () => {
    const otherWorkspaceId = "00000000-0000-0000-0000-000000000099";
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: otherWorkspaceId,
      organizationId: "00000000-0000-0000-0000-000000000088",
      relayWorkspaceId: "rw_other12",
    });
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: USER_ID,
      workspaceId: otherWorkspaceId,
      organizationId: ORG_ID,
      source: "token",
      scopes: ["cli:auth"],
    });

    const response = await POST(request({ mode: "sync" }), context(otherWorkspaceId));
    expect(response.status).toBe(404);
    expect(mocks.createRelayhistorySession).not.toHaveBeenCalled();
  });

  it("rejects client-supplied tenancy and relayhistory target fields", async () => {
    const response = await POST(
      request({
        mode: "sync",
        relayhistoryUrl: "https://attacker.test",
        orgId: "org_attacker",
      }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(mocks.createRelayhistorySession).not.toHaveBeenCalled();
  });

  it("creates a sync-mode session from Cloud-derived identity and workspace", async () => {
    const response = await POST(request({ mode: "sync", label: "ai-hist" }), context());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      baseUrl: "https://history.agentrelay.com",
      accessToken: "rth_at_token",
      refreshToken: "rth_rt_token",
      tokenType: "Bearer",
    });
    expect(mocks.createRelayhistorySession).toHaveBeenCalledWith({
      userId: USER_ID,
      orgId: ORG_ID,
      workspaceId: WORKSPACE_ID,
      mode: "sync",
      label: "ai-hist",
    });
  });

  it("defaults to sync mode for ai-hist setup and supports explicit read mode", async () => {
    await POST(request({}), context());
    expect(mocks.createRelayhistorySession).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "sync" }),
    );

    await POST(request({ mode: "read" }), context());
    expect(mocks.createRelayhistorySession).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "read" }),
    );
  });

  it("400 for invalid mode", async () => {
    const response = await POST(request({ mode: "admin" }), context());
    expect(response.status).toBe(400);
    expect(mocks.createRelayhistorySession).not.toHaveBeenCalled();
  });

  it("400 for invalid json", async () => {
    const response = await POST(rawRequest("{"), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_request" });
    expect(mocks.createRelayhistorySession).not.toHaveBeenCalled();
  });
});
