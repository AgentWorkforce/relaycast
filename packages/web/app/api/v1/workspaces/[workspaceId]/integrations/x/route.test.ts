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
  provider: "x",
  connectionId: "conn_x",
  providerConfigKey: "x-relay",
  installationId: "install_x",
  metadata: { workspaceId, account: "@agentrelay" },
  createdAt: new Date("2026-05-17T10:00:00.000Z"),
  updatedAt: new Date("2026-05-17T10:00:00.000Z"),
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
    `https://agentrelay.test/api/v1/workspaces/${workspaceId}/integrations/x`,
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

describe("/api/v1/workspaces/:workspaceId/integrations/x", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.getProviderConfigKey.mockReturnValue("x-relay");
    mocks.getNangoConnectionDetails.mockResolvedValue({
      installationId: "install_x",
      payload: { workspaceId, account: "@agentrelay" },
    });
    mocks.getWorkspaceIntegration.mockResolvedValue(integration);
    mocks.upsertWorkspaceIntegration.mockResolvedValue(integration);
    mocks.disconnectIntegrationBackend.mockResolvedValue({
      localDeleted: true,
      upstreamDelete: {
        success: true,
        backend: "composio",
        error: null,
      },
    });
  });

  it("returns the stored X integration", async () => {
    const response = await GET(request("GET"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId,
      connectionId: "conn_x",
      providerConfigKey: "x-relay",
      installationId: "install_x",
    });
    expect(mocks.getWorkspaceIntegration).toHaveBeenCalledWith(workspaceId, "x");
  });

  it("upserts the X integration from Nango connection details", async () => {
    const response = await POST(
      request("POST", { connectionId: " conn_x ", providerConfigKey: null }),
      context(),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      workspaceId,
      provider: "x",
      connectionId: "conn_x",
      providerConfigKey: "x-relay",
      installationId: "install_x",
      metadata: { workspaceId, account: "@agentrelay" },
    });
    expect(mocks.getProviderConfigKey).toHaveBeenCalledWith("x");
    expect(mocks.getNangoConnectionDetails).toHaveBeenCalledWith(
      "conn_x",
      "x-relay",
    );
    expect(mocks.upsertWorkspaceIntegration).toHaveBeenCalledWith({
      workspaceId,
      provider: "x",
      connectionId: "conn_x",
      providerConfigKey: "x-relay",
      installationId: "install_x",
      metadata: { workspaceId, account: "@agentrelay" },
    });
  });

  it("disconnects the X integration", async () => {
    const response = await DELETE(request("DELETE"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      localDeleted: true,
      upstreamDelete: {
        success: true,
        backend: "composio",
        error: null,
      },
    });
    expect(mocks.getWorkspaceIntegration).toHaveBeenCalledWith(workspaceId, "x");
    expect(mocks.disconnectIntegrationBackend).toHaveBeenCalledWith({
      workspaceId,
      provider: "x",
      integration: expect.objectContaining({
        connectionId: "conn_x",
        provider: "x",
      }),
    });
  });
});
