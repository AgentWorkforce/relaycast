import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cloudAgentExists: vi.fn(),
  requireWorkspaceSandboxAuth: vi.fn(),
  resolveWorkspaceGatewayAccess: vi.fn(),
}));

vi.mock("../../../sandboxes/sandbox-utils", async (orig) => {
  const actual = await orig<typeof import("../../../sandboxes/sandbox-utils")>();
  return { ...actual, requireWorkspaceSandboxAuth: mocks.requireWorkspaceSandboxAuth };
});

vi.mock("@/lib/proactive-runtime/dashboard", () => ({
  resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess,
}));

import { createCloudAgentEventsRouteHandlers } from "./route";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token",
  scopes: ["cli:auth"],
};

function request(): NextRequest {
  return new NextRequest(
    "https://cloud.test/api/v1/workspaces/00000000-0000-0000-0000-000000000002/cloud-agents/00000000-0000-0000-0000-000000000004/events",
    {
      method: "GET",
      headers: {
        authorization: "Bearer cld_at_cloud-token",
      },
    },
  );
}

function context() {
  return {
    params: Promise.resolve({
      workspaceId: "00000000-0000-0000-0000-000000000002",
      cloudAgentId: "00000000-0000-0000-0000-000000000004",
    }),
  };
}

describe("cloud agent events route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireWorkspaceSandboxAuth.mockResolvedValue({
      ok: true,
      auth,
      workspaceId: "00000000-0000-0000-0000-000000000002",
      sandboxId: undefined,
    });
    mocks.resolveWorkspaceGatewayAccess.mockResolvedValue({
      gatewayBaseUrl: "https://gateway.agentrelay.test",
      relayWorkspaceId: "rw_workspace_123",
      token: "relayfile-token",
    });
    mocks.cloudAgentExists.mockResolvedValue(true);
  });

  it("returns the agent event stream config for Pear", async () => {
    const { GET } = createCloudAgentEventsRouteHandlers({
      cloudAgentExists: mocks.cloudAgentExists,
      resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess as never,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId: "rw_workspace_123",
      agentId: "pear-cloud-agent-00000000-0000-0000-0000-000000000004",
      gatewayUrl: "wss://gateway.agentrelay.test/v1/agent-events",
      apiKey: "relayfile-token",
    });
    expect(mocks.resolveWorkspaceGatewayAccess).toHaveBeenCalledWith({
      userId: "00000000-0000-0000-0000-000000000001",
      workspaceId: "00000000-0000-0000-0000-000000000002",
      agentName: "pear-cloud-agent-events",
      requestedScopes: ["relayfile:fs:read:/integrations/**", "relayfile:fs:write:/integrations/**"],
    });
    expect(mocks.cloudAgentExists).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000004",
      "00000000-0000-0000-0000-000000000001",
    );
  });

  it("rejects relayfile bearer tokens to avoid scope escalation", async () => {
    mocks.requireWorkspaceSandboxAuth.mockResolvedValueOnce({
      ok: true,
      auth: { ...auth, source: "relayfile", scopes: ["relayfile:fs:read:/integrations/**"] },
      workspaceId: "00000000-0000-0000-0000-000000000002",
      sandboxId: undefined,
    });
    const { GET } = createCloudAgentEventsRouteHandlers({
      cloudAgentExists: mocks.cloudAgentExists,
      resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess as never,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.resolveWorkspaceGatewayAccess).not.toHaveBeenCalled();
  });

  it("rejects non-cli scoped API tokens to avoid event token escalation", async () => {
    mocks.requireWorkspaceSandboxAuth.mockResolvedValueOnce({
      ok: true,
      auth: { ...auth, scopes: ["workflow:runs:read"] },
      workspaceId: "00000000-0000-0000-0000-000000000002",
      sandboxId: undefined,
    });
    const { GET } = createCloudAgentEventsRouteHandlers({
      cloudAgentExists: mocks.cloudAgentExists,
      resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess as never,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.resolveWorkspaceGatewayAccess).not.toHaveBeenCalled();
  });

  it("rejects unknown cloud agent ids", async () => {
    mocks.cloudAgentExists.mockResolvedValueOnce(false);
    const { GET } = createCloudAgentEventsRouteHandlers({
      cloudAgentExists: mocks.cloudAgentExists,
      resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess as never,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(404);
    expect(mocks.resolveWorkspaceGatewayAccess).not.toHaveBeenCalled();
  });

  it("preserves an explicit /v1/agent-events gateway path", async () => {
    mocks.resolveWorkspaceGatewayAccess.mockResolvedValueOnce({
      gatewayBaseUrl: "https://gateway.agentrelay.test/custom/v1/agent-events",
      relayWorkspaceId: "rw_workspace_123",
      token: "relayfile-token",
    });
    const { GET } = createCloudAgentEventsRouteHandlers({
      cloudAgentExists: mocks.cloudAgentExists,
      resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess as never,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      gatewayUrl: "wss://gateway.agentrelay.test/custom/v1/agent-events",
    });
  });

  it("maps gateway config failures to a clean 503", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.resolveWorkspaceGatewayAccess.mockRejectedValueOnce(new Error("missing env"));
    const { GET } = createCloudAgentEventsRouteHandlers({
      cloudAgentExists: mocks.cloudAgentExists,
      resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess as never,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Agent gateway unavailable",
      code: "agent_gateway_unavailable",
    });
    consoleError.mockRestore();
  });
});
