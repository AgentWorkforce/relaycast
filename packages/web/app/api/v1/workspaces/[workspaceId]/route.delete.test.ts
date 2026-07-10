import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  resolveRequestAuth: vi.fn(),
  isValidWorkspaceId: vi.fn(),
  createCloudWorkspaceRegistry: vi.fn(),
  formatWorkspaceResponse: vi.fn(),
  hasWorkspaceOwnerAccess: vi.fn(),
  deleteWorkspaceCascade: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/relay-workspaces", () => ({
  isValidWorkspaceId: mocks.isValidWorkspaceId,
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: mocks.createCloudWorkspaceRegistry,
  formatWorkspaceResponse: mocks.formatWorkspaceResponse,
  hasWorkspaceOwnerAccess: mocks.hasWorkspaceOwnerAccess,
}));

vi.mock("@/lib/workspace-deletion", () => ({
  deleteWorkspaceCascade: mocks.deleteWorkspaceCascade,
}));

import { DELETE } from "./route";

const WORKSPACE_ID = "rw_abcd1234";

function request(body?: unknown, token = "access-token"): NextRequest {
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}`, {
    method: "DELETE",
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function params() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

describe("DELETE /api/v1/workspaces/{workspaceId}", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSessionAuth.mockImplementation((auth) => auth?.source === "session");
    mocks.requireAuthScope.mockImplementation((auth, scope) =>
      Boolean(auth?.scopes?.includes(scope)),
    );
    mocks.isValidWorkspaceId.mockReturnValue(true);
    mocks.hasWorkspaceOwnerAccess.mockImplementation(
      (entry, userId) => entry?.createdBy === userId,
    );
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn().mockResolvedValue({
          id: WORKSPACE_ID,
          createdBy: "user-1",
          createdAt: "2026-01-01T00:00:00.000Z",
          permissions: { ignored: [], readonly: [] },
        }),
      },
      serviceConfig: {},
    });
    mocks.deleteWorkspaceCascade.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      integrationsRevoked: 2,
      integrationsFailed: 0,
      relayfileObjectsDeleted: 42,
      githubCloneJobsDeleted: 1,
      integrationDisconnectTombstonesDeleted: 0,
      relayWorkspaceRowDeleted: true,
      failures: [],
    });
  });

  function authenticatedOwner() {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      source: "token",
      scopes: ["cli:auth"],
    });
  }

  it("returns 401 when unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const res = await DELETE(request({ confirm: WORKSPACE_ID }), params());
    expect(res.status).toBe(401);
    expect(mocks.deleteWorkspaceCascade).not.toHaveBeenCalled();
  });

  it("returns 403 when authenticated without session or cli:auth scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: WORKSPACE_ID,
      source: "token",
      scopes: [],
    });
    const res = await DELETE(request({ confirm: WORKSPACE_ID }), params());
    expect(res.status).toBe(403);
    expect(mocks.deleteWorkspaceCascade).not.toHaveBeenCalled();
  });

  it("returns 400 when confirmation is missing", async () => {
    authenticatedOwner();
    const res = await DELETE(request({}), params());
    expect(res.status).toBe(400);
    expect(mocks.deleteWorkspaceCascade).not.toHaveBeenCalled();
  });

  it("returns 400 when confirmation does not match the workspace id", async () => {
    authenticatedOwner();
    const res = await DELETE(request({ confirm: "rw_wrongone" }), params());
    expect(res.status).toBe(400);
    expect(mocks.deleteWorkspaceCascade).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown / already-deleted workspace", async () => {
    authenticatedOwner();
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: { get: vi.fn().mockResolvedValue(null) },
      serviceConfig: {},
    });
    const res = await DELETE(request({ confirm: WORKSPACE_ID }), params());
    expect(res.status).toBe(404);
    expect(mocks.deleteWorkspaceCascade).not.toHaveBeenCalled();
  });

  it("returns 404 for a cross-tenant workspace owned by another user", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "intruder",
      workspaceId: WORKSPACE_ID,
      source: "token",
      scopes: ["cli:auth"],
    });
    const res = await DELETE(request({ confirm: WORKSPACE_ID }), params());
    expect(res.status).toBe(404);
    expect(mocks.deleteWorkspaceCascade).not.toHaveBeenCalled();
  });

  it("cascades the delete and returns the teardown summary", async () => {
    authenticatedOwner();
    const res = await DELETE(request({ confirm: WORKSPACE_ID }), params());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      deleted: true,
      summary: {
        workspaceId: WORKSPACE_ID,
        integrationsRevoked: 2,
        integrationsFailed: 0,
        relayfileObjectsDeleted: 42,
        githubCloneJobsDeleted: 1,
        integrationDisconnectTombstonesDeleted: 0,
        relayWorkspaceRowDeleted: true,
        failures: [],
      },
    });
    expect(mocks.deleteWorkspaceCascade).toHaveBeenCalledWith(WORKSPACE_ID);
  });

  it("still returns 200 with recorded failures when a provider revoke failed", async () => {
    authenticatedOwner();
    mocks.deleteWorkspaceCascade.mockResolvedValue({
      workspaceId: WORKSPACE_ID,
      integrationsRevoked: 1,
      integrationsFailed: 1,
      relayfileObjectsDeleted: 10,
      githubCloneJobsDeleted: 0,
      integrationDisconnectTombstonesDeleted: 0,
      relayWorkspaceRowDeleted: true,
      failures: [
        { phase: "revoke-integration:slack", detail: "provider 503" },
      ],
    });
    const res = await DELETE(request({ confirm: WORKSPACE_ID }), params());
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      summary: { integrationsFailed: number; failures: unknown[] };
    };
    expect(json.summary.integrationsFailed).toBe(1);
    expect(json.summary.failures).toHaveLength(1);
  });

  it("returns 500 when the cascade throws (e.g. registry row delete failed)", async () => {
    authenticatedOwner();
    mocks.deleteWorkspaceCascade.mockRejectedValue(new Error("db down"));
    const res = await DELETE(request({ confirm: WORKSPACE_ID }), params());
    expect(res.status).toBe(500);
  });
});
