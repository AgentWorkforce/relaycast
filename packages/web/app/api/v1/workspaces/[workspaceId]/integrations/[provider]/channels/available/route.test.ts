import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationReadAccess: vi.fn(),
  listWorkspaceIntegrationsByProviderAlias: vi.fn(),
  listChannels: vi.fn(),
  getProviderConfigKey: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationReadAccess: mocks.hasWorkspaceIntegrationReadAccess,
}));

vi.mock("@/lib/integrations/workspace-integrations", () => ({
  listWorkspaceIntegrationsByProviderAlias:
    mocks.listWorkspaceIntegrationsByProviderAlias,
}));

vi.mock("@/lib/integrations/nango-slack", () => ({
  listChannels: mocks.listChannels,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

import { GET } from "./route";

const auth = {
  userId: "user_123",
  workspaceId: "ws_123",
  organizationId: "org_123",
  source: "session",
  context: {
    user: { id: "user_123", email: "dev@example.test" },
    currentWorkspace: { id: "ws_123" },
    currentOrganization: { id: "org_123" },
    workspaces: [{ id: "ws_123" }],
  },
};

function request(cursor?: string): NextRequest {
  const url = new URL(
    "https://agentrelay.test/api/v1/workspaces/ws_123/integrations/slack/channels/available",
  );
  if (cursor) {
    url.searchParams.set("cursor", cursor);
  }
  return new NextRequest(url);
}

function contextForWorkspace(workspaceId: string, provider = "slack") {
  return {
    params: Promise.resolve({ workspaceId, provider }),
  };
}

function integrationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "integration_slack",
    workspaceId: "ws_123",
    provider: "slack",
    connectionId: "conn_slack",
    providerConfigKey: "slack-relay",
    installationId: null,
    metadata: {},
    createdAt: new Date("2026-05-01T00:00:00.000Z"),
    updatedAt: new Date("2026-05-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("GET /api/v1/workspaces/:workspaceId/integrations/:provider/channels/available", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.resolveWorkspaceIntegrationIdentity.mockImplementation(
      async (workspaceId: string) => ({
        requestedWorkspaceId: workspaceId,
        appWorkspaceId: workspaceId,
        relayWorkspaceId: workspaceId,
        organizationId: "org_123",
        candidateWorkspaceIds: [workspaceId],
      }),
    );
    mocks.hasWorkspaceIntegrationReadAccess.mockReturnValue(true);
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow(),
    ]);
    mocks.listChannels.mockResolvedValue({
      channels: [{ id: "C1", name: "general", isPrivate: false, isMember: true }],
      nextCursor: "cursor-2",
    });
  });

  it("looks up available channels from the bound Relayfile workspace", async () => {
    mocks.resolveWorkspaceIntegrationIdentity.mockResolvedValue({
      requestedWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      appWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      relayWorkspaceId: "rw_7ccfea89",
      organizationId: "org_123",
      candidateWorkspaceIds: [
        "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        "rw_7ccfea89",
      ],
    });
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({ workspaceId: "rw_7ccfea89" }),
    ]);

    const res = await GET(
      request("cursor-1"),
      contextForWorkspace("50587328-441d-4acb-b8f3-dbe1b3c5de99"),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      channels: [{ id: "C1", name: "general", isPrivate: false, isMember: true }],
      nextCursor: "cursor-2",
    });
    expect(mocks.listWorkspaceIntegrationsByProviderAlias).toHaveBeenCalledWith(
      "rw_7ccfea89",
      "slack",
    );
    expect(mocks.listChannels).toHaveBeenCalledWith(
      "conn_slack",
      "slack-relay",
      { cursor: "cursor-1", limit: 200 },
    );
  });

  it("uses the matched row provider for providerConfigKey fallback", async () => {
    mocks.listWorkspaceIntegrationsByProviderAlias.mockResolvedValue([
      integrationRow({
        provider: "slack-nightcto",
        providerConfigKey: null,
      }),
    ]);
    mocks.getProviderConfigKey.mockReturnValue("slack-nightcto");

    const res = await GET(request(), contextForWorkspace("ws_123"));

    expect(res.status).toBe(200);
    expect(mocks.getProviderConfigKey).toHaveBeenCalledWith("slack-nightcto");
    expect(mocks.listChannels).toHaveBeenCalledWith(
      "conn_slack",
      "slack-nightcto",
      { cursor: undefined, limit: 200 },
    );
  });
});
