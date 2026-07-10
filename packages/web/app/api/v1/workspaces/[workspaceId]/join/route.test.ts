import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorkspaceJoinAccess: vi.fn(),
  createCloudWorkspaceRegistry: vi.fn(),
  hasWorkspaceOwnerAccess: vi.fn(),
  readAppWorkspaceRelayBinding: vi.fn(),
  requireOrgMember: vi.fn(),
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  resolveAppWorkspaceByRelayWorkspaceId: vi.fn(),
  resolveConfiguredRelaycastUrl: vi.fn(),
  resolveRequestAuth: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/relay-workspaces", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-workspaces")>()),
  createWorkspaceJoinAccess: mocks.createWorkspaceJoinAccess,
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: mocks.createCloudWorkspaceRegistry,
  hasWorkspaceOwnerAccess: mocks.hasWorkspaceOwnerAccess,
  resolveConfiguredRelaycastUrl: mocks.resolveConfiguredRelaycastUrl,
}));

vi.mock("@/lib/invites/invite-store", () => ({
  requireOrgMember: mocks.requireOrgMember,
}));

vi.mock("@/lib/workspaces/relay-workspace-binding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workspaces/relay-workspace-binding")>()),
  readAppWorkspaceRelayBinding: mocks.readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId: mocks.resolveAppWorkspaceByRelayWorkspaceId,
}));

import { POST } from "./route";

const APP_WORKSPACE_ID = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
const RELAY_WORKSPACE_ID = "rw_abcd1234";

function request(body: unknown): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${APP_WORKSPACE_ID}/join`,
    {
      method: "POST",
      headers: { authorization: "Bearer cloud-token" },
      body: JSON.stringify(body),
    },
  );
}

function params(workspaceId = APP_WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

describe("POST /api/v1/workspaces/[workspaceId]/join", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireSessionAuth.mockImplementation((auth) => auth?.source === "session");
    mocks.requireAuthScope.mockImplementation((auth, scope) =>
      Boolean(auth?.scopes?.includes(scope)),
    );
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "member-user",
      workspaceId: "current-app-workspace",
      organizationId: "org-1",
      source: "token",
      scopes: ["cli:auth"],
    });
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
      relayWorkspaceId: RELAY_WORKSPACE_ID,
    });
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
    });
    mocks.hasWorkspaceOwnerAccess.mockReturnValue(false);
    mocks.requireOrgMember.mockResolvedValue(true);
    mocks.resolveConfiguredRelaycastUrl.mockReturnValue(undefined);
    mocks.createWorkspaceJoinAccess.mockResolvedValue({
      token: "relay_pa_read",
      tokenIssuedAt: "2026-05-27T10:00:00.000Z",
      tokenExpiresAt: "2026-05-27T11:00:00.000Z",
      suggestedRefreshAt: "2026-05-27T10:55:00.000Z",
      relayfileUrl: "https://api.relayfile.dev",
      wsUrl: "wss://api.relayfile.dev/v1/workspaces/rw_cloud01/fs/ws",
      scopes: ["relayfile:fs:read:*"],
    });
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn(async (workspaceId: string) =>
          workspaceId === RELAY_WORKSPACE_ID
            ? {
                id: RELAY_WORKSPACE_ID,
                createdBy: "owner-user",
                permissions: { ignored: [], readonly: [] },
                relaycastApiKey: "relaycast-key",
              }
            : null,
        ),
      },
    });
  });

  it("joins a bound relay workspace when an org member supplies the app workspace id", async () => {
    const response = await POST(
      request({
        agentName: "relayfile-cli",
        scopes: ["relayfile:fs:read:*"],
      }),
      params(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: RELAY_WORKSPACE_ID,
      token: "relay_pa_read",
      relayfileUrl: "https://api.relayfile.dev",
    });
    expect(mocks.readAppWorkspaceRelayBinding).toHaveBeenCalledWith(APP_WORKSPACE_ID);
    expect(mocks.resolveAppWorkspaceByRelayWorkspaceId).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceJoinAccess).toHaveBeenCalledWith({
      workspaceId: RELAY_WORKSPACE_ID,
      agentName: "relayfile-cli",
      permissions: { ignored: [], readonly: [] },
      requestedScopes: ["relayfile:fs:read:*"],
    });
  });

  it("keeps non-member app workspace aliases hidden", async () => {
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: APP_WORKSPACE_ID,
      organizationId: "other-org",
      relayWorkspaceId: RELAY_WORKSPACE_ID,
    });

    const response = await POST(
      request({
        agentName: "relayfile-cli",
        scopes: ["relayfile:fs:read:*"],
      }),
      params(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Workspace not found" });
  });

  it("revalidates active org membership for cli tokens before joining", async () => {
    mocks.requireOrgMember.mockResolvedValue(false);

    const response = await POST(
      request({
        agentName: "relayfile-cli",
        scopes: ["relayfile:fs:read:*"],
      }),
      params(),
    );

    expect(response.status).toBe(404);
    expect(mocks.requireOrgMember).toHaveBeenCalledWith("org-1", "member-user");
    expect(mocks.createWorkspaceJoinAccess).not.toHaveBeenCalled();
  });

  it("authorizes app workspace ids from the requested app row when reverse binding is stale", async () => {
    mocks.readAppWorkspaceRelayBinding.mockResolvedValue({
      appWorkspaceId: APP_WORKSPACE_ID,
      organizationId: "org-1",
      relayWorkspaceId: RELAY_WORKSPACE_ID,
    });
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockResolvedValue({
      appWorkspaceId: "00000000-0000-0000-0000-000000000999",
      organizationId: "other-org",
    });

    const response = await POST(
      request({
        agentName: "relayfile-cli",
        scopes: ["relayfile:fs:read:*"],
      }),
      params(),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAppWorkspaceByRelayWorkspaceId).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: RELAY_WORKSPACE_ID,
    });
  });

  it("joins anonymous relay workspace ids when reverse app binding lookup is unavailable", async () => {
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockRejectedValue(
      new Error("SST links are not active"),
    );
    mocks.createCloudWorkspaceRegistry.mockReturnValue({
      registry: {
        get: vi.fn(async (workspaceId: string) =>
          workspaceId === RELAY_WORKSPACE_ID
            ? {
                id: RELAY_WORKSPACE_ID,
                createdBy: "00000000-0000-0000-0000-000000000000",
                permissions: { ignored: [], readonly: [] },
                relaycastApiKey: "relaycast-key",
              }
            : null,
        ),
      },
    });

    const response = await POST(
      request({
        agentName: "relayfile-cli",
        scopes: ["relayfile:fs:read:*"],
      }),
      params(RELAY_WORKSPACE_ID),
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveAppWorkspaceByRelayWorkspaceId).toHaveBeenCalledWith(
      RELAY_WORKSPACE_ID,
    );
    expect(mocks.readAppWorkspaceRelayBinding).not.toHaveBeenCalled();
    expect(mocks.requireOrgMember).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      workspaceId: RELAY_WORKSPACE_ID,
    });
  });

  it("does not join private relay workspace ids when reverse app binding lookup is unavailable", async () => {
    mocks.resolveAppWorkspaceByRelayWorkspaceId.mockRejectedValue(
      new Error("SST links are not active"),
    );

    const response = await POST(
      request({
        agentName: "relayfile-cli",
        scopes: ["relayfile:fs:read:*"],
      }),
      params(RELAY_WORKSPACE_ID),
    );

    expect(response.status).toBe(404);
    expect(mocks.resolveAppWorkspaceByRelayWorkspaceId).toHaveBeenCalledWith(
      RELAY_WORKSPACE_ID,
    );
    expect(mocks.requireOrgMember).not.toHaveBeenCalled();
    expect(mocks.createWorkspaceJoinAccess).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({ error: "Workspace not found" });
  });
});
