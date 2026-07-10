import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  adoptIntegrationConnection: vi.fn(),
  resolveWorkspaceIntegrationProvider: vi.fn(),
  resolveWorkspaceIntegrationIdentity: vi.fn(),
  hasWorkspaceIntegrationAccess: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  requireAuthScope: vi.fn(() => false),
  requireSessionAuth: vi.fn((auth) => auth?.source === "session"),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/adopt-integration", () => ({
  adoptIntegrationConnection: mocks.adoptIntegrationConnection,
}));

vi.mock("@/lib/integrations/providers", () => ({
  resolveWorkspaceIntegrationProvider: mocks.resolveWorkspaceIntegrationProvider,
}));

vi.mock("@/lib/workspaces/workspace-integration-identity", () => ({
  resolveWorkspaceIntegrationIdentity: mocks.resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess: mocks.hasWorkspaceIntegrationAccess,
}));

function request(body: unknown): NextRequest {
  return new NextRequest("https://agentrelay.test/api/v1/workspaces/50587328-441d-4acb-b8f3-dbe1b3c5de99/integrations/slack/adopt", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function context(workspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99", provider = "slack") {
  return {
    params: Promise.resolve({ workspaceId, provider }),
  };
}

describe("workspace integration adopt route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      source: "session",
      userId: "user_123",
      context: {
        workspaces: [{ id: "50587328-441d-4acb-b8f3-dbe1b3c5de99" }],
      },
    });
    mocks.resolveWorkspaceIntegrationProvider.mockReturnValue("slack");
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
    mocks.hasWorkspaceIntegrationAccess.mockReturnValue(true);
    mocks.adoptIntegrationConnection.mockResolvedValue({
      ok: true,
      connectionId: "6ff59f0f-a6e3-437b-8378-7ff978681d30",
    });
  });

  it("adopts against the resolved relay workspace id when addressed by app UUID", async () => {
    const { POST } = await import("./route");

    const response = await POST(
      request({
        connectionId: "6ff59f0f-a6e3-437b-8378-7ff978681d30",
        providerConfigKey: "slack-relay",
      }),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      connectionId: "6ff59f0f-a6e3-437b-8378-7ff978681d30",
      workspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
      relayWorkspaceId: "rw_7ccfea89",
    });
    expect(mocks.hasWorkspaceIntegrationAccess).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        requestedWorkspaceId: "50587328-441d-4acb-b8f3-dbe1b3c5de99",
        relayWorkspaceId: "rw_7ccfea89",
      }),
    );
    expect(mocks.adoptIntegrationConnection).toHaveBeenCalledWith({
      workspaceId: "rw_7ccfea89",
      provider: "slack",
      connectionId: "6ff59f0f-a6e3-437b-8378-7ff978681d30",
      providerConfigKey: "slack-relay",
    });
  });
});
