import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkspaceSandboxAuth: vi.fn(),
  resolveWorkspaceGatewayAccess: vi.fn(),
}));

vi.mock("../sandboxes/sandbox-utils", async (orig) => {
  const actual = await orig<typeof import("../sandboxes/sandbox-utils")>();
  return { ...actual, requireWorkspaceSandboxAuth: mocks.requireWorkspaceSandboxAuth };
});

vi.mock("@/lib/proactive-runtime/dashboard", () => ({
  resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess,
}));

import { createWorkspaceAgentEventsRouteHandlers } from "./route";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token",
  scopes: ["cli:auth"],
};

function request(): NextRequest {
  return new NextRequest(
    "https://cloud.test/api/v1/workspaces/00000000-0000-0000-0000-000000000002/agent-events",
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
    }),
  };
}

describe("workspace agent events route", () => {
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
  });

  it("returns project-level agent event stream config for Pear", async () => {
    const { GET } = createWorkspaceAgentEventsRouteHandlers({
      resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess as never,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId: "rw_workspace_123",
      agentId: "pear-project-events",
      gatewayUrl: "wss://gateway.agentrelay.test/v1/agent-events",
      apiKey: "relayfile-token",
    });
    expect(mocks.resolveWorkspaceGatewayAccess).toHaveBeenCalledWith({
      userId: "00000000-0000-0000-0000-000000000001",
      workspaceId: "00000000-0000-0000-0000-000000000002",
      agentName: "pear-project-events",
      requestedScopes: ["relayfile:fs:read:/integrations/**", "relayfile:fs:write:/integrations/**"],
    });
  });

  it("rejects relayfile bearer tokens to avoid scope escalation", async () => {
    mocks.requireWorkspaceSandboxAuth.mockResolvedValueOnce({
      ok: true,
      auth: { ...auth, source: "relayfile", scopes: ["relayfile:fs:read:/integrations/**"] },
      workspaceId: "00000000-0000-0000-0000-000000000002",
      sandboxId: undefined,
    });
    const { GET } = createWorkspaceAgentEventsRouteHandlers({
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
    const { GET } = createWorkspaceAgentEventsRouteHandlers({
      resolveWorkspaceGatewayAccess: mocks.resolveWorkspaceGatewayAccess as never,
    });

    const response = await GET(request(), context());

    expect(response.status).toBe(403);
    expect(mocks.resolveWorkspaceGatewayAccess).not.toHaveBeenCalled();
  });
});
