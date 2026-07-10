import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCloudWorkspaceRegistry: vi.fn(),
  getRelayWorkspaceByRelaycastApiKey: vi.fn(),
  hasWorkspaceOwnerAccess: vi.fn(),
  readAppWorkspaceRelayBinding: vi.fn(),
  requireAuthScope: vi.fn(),
  requireOrgMember: vi.fn(),
  requireSessionAuth: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
  resolveOrProvisionRelayWorkspace: vi.fn(),
  resolveRequestAuth: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/invites/invite-store", () => ({
  requireOrgMember: mocks.requireOrgMember,
}));

vi.mock("@/lib/relay-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-workspaces")>()),
  getRelayWorkspaceByRelaycastApiKey: mocks.getRelayWorkspaceByRelaycastApiKey,
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: mocks.createCloudWorkspaceRegistry,
  hasWorkspaceOwnerAccess: mocks.hasWorkspaceOwnerAccess,
}));

vi.mock("@/lib/workflows/relay-workspace", () => ({
  resolveOrProvisionRelayWorkspace: mocks.resolveOrProvisionRelayWorkspace,
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaces/relay-workspace-binding")>()),
  readAppWorkspaceRelayBinding: mocks.readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId: mocks.resolveAppWorkspaceByRelayWorkspaceId,
}));

import { GET } from "./route";

const APP_WORKSPACE_ID = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
const RELAY_WORKSPACE_ID = "rw_abcd1234";
const RELAY_WORKSPACE_KEY = "rk_live_ops";
const ANONYMOUS_OWNER_ID = "00000000-0000-0000-0000-000000000000";
const ACTIVE_WORKSPACE_DESCRIPTOR_KEYS = [
  "cloudWorkspaceId",
  "name",
  "organizationId",
  "provisioned",
  "relayauthWorkspaceId",
  "relaycastApiKey",
  "relaycastWorkspaceId",
  "relayfileWorkspaceId",
  "slug",
  "urls",
  "workspaceId",
].sort();

function request(workspaceId = APP_WORKSPACE_ID): NextRequest {
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/resolve`, {
    headers: { authorization: "Bearer cloud-token" },
  });
}

function params(workspaceId = APP_WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function relayWorkspaceEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: RELAY_WORKSPACE_ID,
    name: "Relay Workspace",
    createdBy: "owner-user",
    relaycastApiKey: "relaycast-key",
    relayfileWorkspaceId: "rf_workspace",
    relayauthWorkspaceId: "ra_workspace",
    createdAt: "2026-06-13T10:00:00.000Z",
    permissions: { ignored: [], readonly: [] },
    ...overrides,
  };
}

describe("GET /api/v1/workspaces/[workspaceId]/resolve", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSessionAuth.mockImplementation((auth) => auth?.source === "session");
    mocks.requireAuthScope.mockImplementation((auth, scope) =>
      Boolean(auth?.scopes?.includes(scope)),
    );
    mocks.requireOrgMember.mockResolvedValue(true);
    mocks.hasWorkspaceOwnerAccess.mockReturnValue(false);
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "member-user",
      workspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
      source: "token",
      scopes: ["cli:auth"],
    });
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
      relayWorkspaceId: null,
    });
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
    });
    mocks.getRelayWorkspaceByRelaycastApiKey.mockResolvedValue(relayWorkspaceEntry());
    mocks.resolveOrProvisionRelayWorkspace.mockResolvedValue({
      id: RELAY_WORKSPACE_ID,
      relaycastApiKey: "relaycast-key",
      provisioned: true,
    });
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn(async (workspaceId: string) =>
          workspaceId === RELAY_WORKSPACE_ID ? relayWorkspaceEntry() : null,
        ),
      },
      serviceConfig: {
        relaycastUrl: "https://api.relaycast.dev",
        relayfileUrl: "https://api.relayfile.dev",
        relayauthUrl: "https://api.relayauth.dev",
      },
    });
  });

  it("returns 401 when the request is unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);

    const response = await GET(request(), params());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mocks.readAppWorkspaceRelayBinding).not.toHaveBeenCalled();
  });

  it("returns 403 when token auth lacks the cli:auth scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "member-user",
      workspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
      source: "token",
      scopes: [],
    });

    const response = await GET(request(), params());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.readAppWorkspaceRelayBinding).not.toHaveBeenCalled();
  });

  it("resolves an app workspace id to the canonical relay workspace descriptor", async () => {
    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    const body = await response.json();
    // Mirrors @agent-relay/cloud ActiveWorkspaceDescriptor. Keep this field set
    // pinned until the contract moves to a shared schema package.
    expect(Object.keys(body).sort()).toEqual(ACTIVE_WORKSPACE_DESCRIPTOR_KEYS);
    expect(body).toEqual({
      workspaceId: RELAY_WORKSPACE_ID,
      cloudWorkspaceId: APP_WORKSPACE_ID,
      relaycastWorkspaceId: RELAY_WORKSPACE_ID,
      relayfileWorkspaceId: "rf_workspace",
      relayauthWorkspaceId: "ra_workspace",
      organizationId: "org-1",
      slug: null,
      name: "Relay Workspace",
      relaycastApiKey: "relaycast-key",
      urls: {
        relaycastUrl: "https://api.relaycast.dev",
        relayfileUrl: "https://api.relayfile.dev",
        relayauthUrl: "https://api.relayauth.dev",
      },
      provisioned: true,
    });
    expect(mocks.resolveOrProvisionRelayWorkspace).toHaveBeenCalledWith({
      userId: "member-user",
      appWorkspaceId: APP_WORKSPACE_ID,
      name: undefined,
    });
  });

  it("includes session workspace slug and name when available", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "member-user",
      workspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
      source: "session",
      context: {
        user: { id: "member-user", email: "dev@example.test", name: "Dev", avatarUrl: null },
        organizations: [
          { id: "org-1", slug: "main-org", name: "Main Org", role: "owner", status: "active" },
        ],
        currentOrganization: {
          id: "org-1",
          slug: "main-org",
          name: "Main Org",
          role: "owner",
          status: "active",
        },
        currentWorkspace: {
          id: APP_WORKSPACE_ID,
          organization_id: "org-1",
          slug: "alpha",
          name: "Alpha",
        },
        workspaces: [
          {
            id: APP_WORKSPACE_ID,
            organization_id: "org-1",
            slug: "alpha",
            name: "Alpha",
          },
        ],
      },
    });
    mocks.resolveOrProvisionRelayWorkspace.mockResolvedValueOnce({
      id: RELAY_WORKSPACE_ID,
      relaycastApiKey: "relaycast-key",
      provisioned: false,
    });

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cloudWorkspaceId: APP_WORKSPACE_ID,
      slug: "alpha",
      name: "Alpha",
      provisioned: false,
    });
    expect(mocks.resolveOrProvisionRelayWorkspace).toHaveBeenCalledWith({
      userId: "member-user",
      appWorkspaceId: APP_WORKSPACE_ID,
      name: "Alpha",
    });
  });

  it("uses session workspace metadata when currentWorkspace is absent", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "member-user",
      workspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
      source: "session",
      context: {
        user: { id: "member-user", email: "dev@example.test", name: "Dev", avatarUrl: null },
        organizations: [],
        currentOrganization: null,
        currentWorkspace: null,
        workspaces: [
          {
            id: APP_WORKSPACE_ID,
            organization_id: "org-1",
            slug: "beta",
            name: "Beta",
          },
        ],
      },
    });

    const response = await GET(request(), params());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      slug: "beta",
      name: "Beta",
    });
    expect(mocks.resolveOrProvisionRelayWorkspace).toHaveBeenCalledWith({
      userId: "member-user",
      appWorkspaceId: APP_WORKSPACE_ID,
      name: "Beta",
    });
  });

  it("does not provision a relay workspace when app workspace access fails", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "member-user",
      workspaceId: "other-workspace",
      organizationId: "other-org",
      source: "token",
      scopes: ["cli:auth"],
    });
    mocks.requireOrgMember.mockResolvedValueOnce(false);

    const response = await GET(request(), params());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Workspace not found" });
    expect(mocks.resolveOrProvisionRelayWorkspace).not.toHaveBeenCalled();
  });

  it("resolves a direct rw_ workspace id without app provisioning", async () => {
    mocks.resolveOrProvisionRelayWorkspace.mockClear();

    const response = await GET(request(RELAY_WORKSPACE_ID), params(RELAY_WORKSPACE_ID));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: RELAY_WORKSPACE_ID,
      cloudWorkspaceId: APP_WORKSPACE_ID,
      relayfileWorkspaceId: "rf_workspace",
      relayauthWorkspaceId: "ra_workspace",
    });
    expect(mocks.resolveAppWorkspaceByRelayWorkspaceId).toHaveBeenCalledWith(RELAY_WORKSPACE_ID);
    expect(mocks.resolveOrProvisionRelayWorkspace).not.toHaveBeenCalled();
  });

  it("resolves an active relay workspace key to the canonical descriptor", async () => {
    mocks.resolveOrProvisionRelayWorkspace.mockClear();

    const response = await GET(request(RELAY_WORKSPACE_KEY), params(RELAY_WORKSPACE_KEY));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: RELAY_WORKSPACE_ID,
      cloudWorkspaceId: APP_WORKSPACE_ID,
      relaycastWorkspaceId: RELAY_WORKSPACE_ID,
      relayfileWorkspaceId: "rf_workspace",
      relayauthWorkspaceId: "ra_workspace",
    });
    expect(mocks.getRelayWorkspaceByRelaycastApiKey).toHaveBeenCalledWith(RELAY_WORKSPACE_KEY);
    expect(mocks.resolveAppWorkspaceByRelayWorkspaceId).toHaveBeenCalledWith(RELAY_WORKSPACE_ID);
    expect(mocks.resolveOrProvisionRelayWorkspace).not.toHaveBeenCalled();
  });

  it("allows anonymous-owned relay workspaces but omits relaycastApiKey", async () => {
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockRejectedValueOnce(
      new Error("no app binding"),
    );
    mocks.createCloudWorkspaceRegistry.mockReturnValueOnce({
      registry: {
        get: vi.fn(async () =>
          relayWorkspaceEntry({
            createdBy: ANONYMOUS_OWNER_ID,
            name: "Anonymous Workspace",
          }),
        ),
      },
      serviceConfig: {
        relaycastUrl: "https://api.relaycast.dev",
        relayfileUrl: "https://api.relayfile.dev",
        relayauthUrl: "https://api.relayauth.dev",
      },
    });

    const response = await GET(request(RELAY_WORKSPACE_ID), params(RELAY_WORKSPACE_ID));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("relaycastApiKey");
    expect(Object.keys(body).sort()).toEqual(
      ACTIVE_WORKSPACE_DESCRIPTOR_KEYS.filter((key) => key !== "relaycastApiKey"),
    );
    expect(body).toMatchObject({
      workspaceId: RELAY_WORKSPACE_ID,
      cloudWorkspaceId: null,
      relaycastWorkspaceId: RELAY_WORKSPACE_ID,
      relayfileWorkspaceId: "rf_workspace",
      relayauthWorkspaceId: "ra_workspace",
      organizationId: null,
      name: "Anonymous Workspace",
    });
  });
});
