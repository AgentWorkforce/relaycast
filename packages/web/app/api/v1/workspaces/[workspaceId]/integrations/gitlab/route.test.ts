import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  disconnectIntegrationBackend: vi.fn(),
  findSlackIntegrationByTeamId: vi.fn(),
  getNangoConnectionDetails: vi.fn(),
  getProviderConfigKey: vi.fn(),
  getSlackConnectionIdentity: vi.fn(),
  getWorkspaceIntegration: vi.fn(),
  mergeSlackConnectionIdentityMetadata: vi.fn(),
  resolveRequestAuth: vi.fn(),
  upsertWorkspaceIntegration: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: vi.fn((auth, scope: string) => auth?.scopes?.includes(scope) === true),
  requireSessionAuth: vi.fn((auth) => auth?.source === "session"),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/disconnect-integration-backend", () => ({
  disconnectIntegrationBackend: mocks.disconnectIntegrationBackend,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getNangoConnectionDetails: mocks.getNangoConnectionDetails,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

vi.mock("@/lib/integrations/nango-slack", () => ({
  getSlackConnectionIdentity: mocks.getSlackConnectionIdentity,
}));

vi.mock("@/lib/integrations/slack-identity", () => ({
  mergeSlackConnectionIdentityMetadata: mocks.mergeSlackConnectionIdentityMetadata,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  findSlackIntegrationByTeamId: mocks.findSlackIntegrationByTeamId,
  getWorkspaceIntegration: mocks.getWorkspaceIntegration,
  looksLikeSlackTeamId: (value: string) => /^[TE][A-Z0-9]+$/.test(value),
  upsertWorkspaceIntegration: mocks.upsertWorkspaceIntegration,
}));

import { DELETE, GET, POST } from "./route";

const workspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
const integration = {
  workspaceId,
  provider: "gitlab",
  connectionId: "conn_gitlab",
  providerConfigKey: "gitlab-relay",
  installationId: "install_gitlab",
  metadata: { workspaceId, account: "AgentWorkforce" },
  createdAt: new Date("2026-05-12T10:00:00.000Z"),
  updatedAt: new Date("2026-05-12T10:00:00.000Z"),
};

const auth = {
  userId: "user_123",
  workspaceId,
  organizationId: "org_123",
  source: "session",
  context: {
    user: { id: "user_123", email: "dev@example.test" },
    currentWorkspace: { id: workspaceId },
    currentOrganization: { id: "org_123" },
    workspaces: [{ id: workspaceId }],
  },
} as const;

function request(method: "GET" | "POST" | "DELETE", body?: unknown): NextRequest {
  return new NextRequest(
    `https://agentrelay.test/api/v1/workspaces/${workspaceId}/integrations/gitlab`,
    {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

function context() {
  return {
    params: Promise.resolve({ workspaceId }),
  };
}

describe("/api/v1/workspaces/:workspaceId/integrations/gitlab", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.getProviderConfigKey.mockReturnValue("gitlab-relay");
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: "install_gitlab",
      payload: { workspaceId, account: "AgentWorkforce" },
    });
    mocks.getWorkspaceIntegration.mockResolvedValue(integration);
    mocks.upsertWorkspaceIntegration.mockResolvedValue(integration);
    mocks.disconnectIntegrationBackend.mockResolvedValue({
      localDeleted: true,
      upstreamDelete: {
        success: true,
        backend: "nango",
        error: null,
      },
    });
  });

  it("returns the stored GitLab integration", async () => {
    const response = await GET(request("GET"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId,
      connectionId: "conn_gitlab",
      providerConfigKey: "gitlab-relay",
      installationId: "install_gitlab",
    });
    expect(mocks.getWorkspaceIntegration).toHaveBeenCalledWith(workspaceId, "gitlab");
  });

  it("upserts the GitLab integration from Nango connection details", async () => {
    const response = await POST(
      request("POST", { connectionId: " conn_gitlab ", providerConfigKey: null }),
      context(),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId,
      provider: "gitlab",
      connectionId: "conn_gitlab",
      providerConfigKey: "gitlab-relay",
      installationId: "install_gitlab",
      metadata: { workspaceId, account: "AgentWorkforce" },
    });
    expect(mocks.getProviderConfigKey).toHaveBeenCalledWith("gitlab");
    expect(mocks.getNangoConnectionDetails).toHaveBeenCalledWith(
      "conn_gitlab",
      "gitlab-relay",
    );
    expect(mocks.upsertWorkspaceIntegration).toHaveBeenCalledWith({
      workspaceId,
      provider: "gitlab",
      connectionId: "conn_gitlab",
      providerConfigKey: "gitlab-relay",
      installationId: "install_gitlab",
      metadata: { workspaceId, account: "AgentWorkforce" },
      writebackDispatchVia: "bridge",
    });
  });

  it("rejects an unknown Nango connection without writing it", async () => {
    mocks.getNangoConnectionDetails.mockResolvedValue(null);

    const response = await POST(
      request("POST", { connectionId: " conn_missing ", providerConfigKey: null }),
      context(),
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "connection_not_found",
    });
    expect(mocks.upsertWorkspaceIntegration).not.toHaveBeenCalled();
  });

  it("rejects a Nango connection tagged for a different workspace", async () => {
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: "install_gitlab",
      payload: { workspaceId: "99999999-9999-4999-8999-999999999999" },
    });

    const response = await POST(
      request("POST", { connectionId: " conn_gitlab ", providerConfigKey: null }),
      context(),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "workspace_mismatch",
      workspaceId,
      connectionWorkspaceId: "99999999-9999-4999-8999-999999999999",
    });
    expect(mocks.upsertWorkspaceIntegration).not.toHaveBeenCalled();
  });

  it("disconnects the GitLab integration", async () => {
    const response = await DELETE(request("DELETE"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      localDeleted: true,
      upstreamDelete: {
        success: true,
        backend: "nango",
        error: null,
      },
    });
    expect(mocks.getWorkspaceIntegration).toHaveBeenCalledWith(workspaceId, "gitlab");
    expect(mocks.disconnectIntegrationBackend).toHaveBeenCalledWith({
      workspaceId,
      provider: "gitlab",
      integration: expect.objectContaining({
        connectionId: "conn_gitlab",
        provider: "gitlab",
      }),
    });
  });

  it("returns upstream deletion status when local disconnect succeeds but Nango cleanup fails", async () => {
    mocks.disconnectIntegrationBackend.mockResolvedValueOnce({
      localDeleted: true,
      upstreamDelete: {
        success: false,
        backend: "nango",
        error: "Nango request failed: 401 Unauthorized",
      },
    });

    const response = await DELETE(request("DELETE"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      localDeleted: true,
      upstreamDelete: {
        success: false,
        backend: "nango",
        error: "Nango request failed: 401 Unauthorized",
      },
    });
  });
});
