import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  fetchRelayhistoryReflex: vi.fn(),
  readAppWorkspaceRelayBinding: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: (auth: { source?: string } | null) => auth?.source === "session",
  requireAuthScope: (auth: { scopes?: string[] } | null, scope: string) =>
    auth?.scopes?.includes(scope) ?? false,
}));

vi.mock("@/lib/relayhistory-reflex", () => ({
  fetchRelayhistoryReflex: mocks.fetchRelayhistoryReflex,
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", () => ({
  isAppWorkspaceId: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value),
  readAppWorkspaceRelayBinding: mocks.readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId: mocks.resolveAppWorkspaceByRelayWorkspaceId,
}));

import { GET } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const ORG_ID = "00000000-0000-0000-0000-000000000003";
const USER_ID = "user_auth";

const auth = {
  userId: USER_ID,
  workspaceId: WORKSPACE_ID,
  organizationId: ORG_ID,
  source: "token" as const,
  scopes: ["rth:read"],
};

function request(query = ""): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/reflex/patterns${query}`,
  );
}

function context(workspaceId = WORKSPACE_ID) {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

describe("GET /api/v1/workspaces/[workspaceId]/reflex/patterns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
      relayWorkspaceId: "rw_test123",
    });
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: WORKSPACE_ID,
      organizationId: ORG_ID,
    });
    mocks.fetchRelayhistoryReflex.mockResolvedValue(
      Response.json({
        patterns: [
          { id: "pattern_1", label: "Escalate earlier", kind: "workflow" },
        ],
      }),
    );
  });

  it("returns proxied JSON and forwards only whitelisted query parameters", async () => {
    const response = await GET(
      request("?scope=individual&kind=workflow&limit=5&since=2026-06-01T00%3A00%3A00.000Z&ignored=true"),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      patterns: [
        { id: "pattern_1", label: "Escalate earlier", kind: "workflow" },
      ],
    });
    expect(mocks.fetchRelayhistoryReflex).toHaveBeenCalledWith(
      "/v1/reflex/patterns?scope=individual&kind=workflow&limit=5&since=2026-06-01T00%3A00%3A00.000Z",
      {
        userId: USER_ID,
        orgId: ORG_ID,
        workspaceId: WORKSPACE_ID,
        mode: "read",
      },
    );
  });

  it("returns 401 when unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await GET(request(), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(mocks.fetchRelayhistoryReflex).not.toHaveBeenCalled();
  });

  it("returns 403 for token auth without relayhistory read entitlement", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      ...auth,
      scopes: ["workflow:runs:read"],
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.fetchRelayhistoryReflex).not.toHaveBeenCalled();
  });

  it("returns 403 for relayfile and service auth without proxying", async () => {
    for (const source of ["relayfile", "service"] as const) {
      vi.clearAllMocks();
      mocks.resolveRequestAuth.mockResolvedValue({
        ...auth,
        source,
        scopes: ["rth:read"],
      });

      const response = await GET(request(), context());

      expect(response.status).toBe(403);
      expect(mocks.fetchRelayhistoryReflex).not.toHaveBeenCalled();
    }
  });

  it("returns 404 for token auth targeting a different path workspace", async () => {
    const otherWorkspaceId = "00000000-0000-0000-0000-000000000099";
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: otherWorkspaceId,
      organizationId: "00000000-0000-0000-0000-000000000088",
      relayWorkspaceId: "rw_other12",
    });

    const response = await GET(request(), context(otherWorkspaceId));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Workspace not found" });
    expect(mocks.fetchRelayhistoryReflex).not.toHaveBeenCalled();
  });

  it("allows session auth to read another workspace in the user's context", async () => {
    const otherWorkspaceId = "00000000-0000-0000-0000-000000000099";
    const otherOrgId = "00000000-0000-0000-0000-000000000088";
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: otherWorkspaceId,
      organizationId: otherOrgId,
      relayWorkspaceId: "rw_other12",
    });
    mocks.resolveRequestAuth.mockResolvedValue({
      ...auth,
      source: "session",
      scopes: [],
      context: {
        user: { id: USER_ID, email: null, name: null, avatarUrl: null },
        organizations: [],
        currentOrganization: {
          id: ORG_ID,
          slug: "org-a",
          name: "Org A",
          role: "owner",
          status: "active",
        },
        currentWorkspace: {
          id: WORKSPACE_ID,
          organization_id: ORG_ID,
          slug: "workspace-a",
          name: "Workspace A",
        },
        workspaces: [
          {
            id: WORKSPACE_ID,
            organization_id: ORG_ID,
            slug: "workspace-a",
            name: "Workspace A",
          },
          {
            id: otherWorkspaceId,
            organization_id: otherOrgId,
            slug: "workspace-b",
            name: "Workspace B",
          },
        ],
      },
    });

    const response = await GET(request(), context(otherWorkspaceId));

    expect(response.status).toBe(200);
    expect(mocks.fetchRelayhistoryReflex).toHaveBeenCalledWith(
      "/v1/reflex/patterns",
      {
        userId: USER_ID,
        orgId: otherOrgId,
        workspaceId: otherWorkspaceId,
        mode: "read",
      },
    );
  });

  it("returns 502 when the upstream request fails", async () => {
    mocks.fetchRelayhistoryReflex.mockResolvedValue(
      Response.json({ error: "upstream failed" }, { status: 503 }),
    );

    const response = await GET(request("?scope=individual"), context());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      error: "Failed to load Reflex patterns",
    });
  });
});
