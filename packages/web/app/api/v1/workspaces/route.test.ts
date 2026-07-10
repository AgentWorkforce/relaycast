import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCloudWorkspaceRegistry: vi.fn(),
  formatWorkspaceResponse: vi.fn(),
  listSlackWorkspaceSummaries: vi.fn(),
  normalizeWorkspacePermissions: vi.fn(),
  readBearerTokenFromRequest: vi.fn(),
  readConfiguredCloudApiToken: vi.fn(),
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  resolveRequestAuth: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/slack-proxy-auth", () => ({
  readBearerTokenFromRequest: mocks.readBearerTokenFromRequest,
  readConfiguredCloudApiToken: mocks.readConfiguredCloudApiToken,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listSlackWorkspaceSummaries: mocks.listSlackWorkspaceSummaries,
}));

vi.mock("@/lib/relay-workspaces", () => ({
  normalizeWorkspacePermissions: mocks.normalizeWorkspacePermissions,
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: mocks.createCloudWorkspaceRegistry,
  formatWorkspaceResponse: mocks.formatWorkspaceResponse,
}));

import { GET } from "./route";

function request(url: string, token = "access-token"): NextRequest {
  return new NextRequest(url, {
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
  });
}

describe("GET /api/v1/workspaces", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSessionAuth.mockImplementation((auth) => auth?.source === "session");
    mocks.requireAuthScope.mockImplementation((auth, scope) =>
      Boolean(auth?.scopes?.includes(scope)),
    );
  });

  it("lists the current workspace for CLI login tokens", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "token",
      scopes: ["cli:auth"],
    });

    const response = await GET(request("https://cloud.test/api/v1/workspaces"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaces: [
        {
          id: "workspace-1",
          slug: "workspace-1",
          name: "workspace-1",
        },
      ],
    });
  });

  it("lists session workspaces for the current organization", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "session",
      context: {
        user: {
          id: "user-1",
          email: "dev@example.test",
          name: "Dev",
          avatarUrl: null,
        },
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
          id: "workspace-1",
          organization_id: "org-1",
          slug: "alpha",
          name: "Alpha",
        },
        workspaces: [
          {
            id: "workspace-1",
            organization_id: "org-1",
            slug: "alpha",
            name: "Alpha",
          },
          {
            id: "workspace-2",
            organization_id: "org-1",
            slug: "beta",
            name: "Beta",
          },
          {
            id: "workspace-3",
            organization_id: "org-2",
            slug: "outside",
            name: "Outside",
          },
        ],
      },
    });

    const response = await GET(request("https://cloud.test/api/v1/workspaces"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaces: [
        { id: "workspace-1", slug: "alpha", name: "Alpha" },
        { id: "workspace-2", slug: "beta", name: "Beta" },
      ],
    });
  });

  it("rejects token auth without cli auth scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user-1",
      workspaceId: "workspace-1",
      organizationId: "org-1",
      source: "token",
      scopes: ["workflow:runs:read"],
    });

    const response = await GET(request("https://cloud.test/api/v1/workspaces"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
  });

  it("keeps integration listing behind the cloud API token", async () => {
    mocks.readBearerTokenFromRequest.mockReturnValueOnce("cloud-token");
    mocks.readConfiguredCloudApiToken.mockReturnValueOnce("cloud-token");
    mocks.listSlackWorkspaceSummaries.mockResolvedValueOnce([
      { teamId: "T123", name: "Agent Workforce" },
    ]);

    const response = await GET(
      request("https://cloud.test/api/v1/workspaces?integration=slack", "cloud-token"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaces: [{ teamId: "T123", name: "Agent Workforce" }],
    });
    expect(mocks.resolveRequestAuth).not.toHaveBeenCalled();
  });
});
