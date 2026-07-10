import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireSessionAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  requireAuthRunAccess: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  getCloudflareContext: vi.fn(),
  tryResourceValue: vi.fn(),
  workerFetch: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireSessionAuth: mocks.requireSessionAuth,
  requireAuthScope: mocks.requireAuthScope,
  requireAuthRunAccess: mocks.requireAuthRunAccess,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/cloudflare-context", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

vi.mock("@/lib/env", () => ({
  tryResourceValue: mocks.tryResourceValue,
}));

import { GET as GET_LEGACY_DEPLOYMENT_RUN } from "./[runId]/route";
import { GET as GET_LEGACY_DEPLOYMENT_RUNS } from "./route";
import { GET as GET_WORKSPACE_DEPLOYMENT_RUNS } from "../../../workspaces/[workspaceId]/deployments/[agentId]/runs/route";
import { GET as GET_WORKSPACE_DEPLOYMENT_RUN } from "../../../workspaces/[workspaceId]/deployments/[agentId]/runs/[runId]/route";
import { GET as GET_WORKSPACE_DEPLOYMENT_RUN_ENVELOPE } from "../../../workspaces/[workspaceId]/deployments/[agentId]/runs/[runId]/envelope/route";

const auth = {
  source: "session",
  userId: "user-1",
  workspaceId: "workspace-1",
  organizationId: "org-1",
  scopes: [],
};

function request(path: string) {
  return new NextRequest(`https://cloud.test${path}`);
}

function legacyListContext() {
  return { params: Promise.resolve({ agentId: "agent-1" }) };
}

function legacyDetailContext() {
  return { params: Promise.resolve({ agentId: "agent-1", runId: "run-1" }) };
}

function workspaceListContext() {
  return {
    params: Promise.resolve({ workspaceId: "workspace-1", agentId: "agent-1" }),
  };
}

function workspaceDetailContext() {
  return {
    params: Promise.resolve({
      workspaceId: "workspace-1",
      agentId: "agent-1",
      runId: "run-1",
    }),
  };
}

async function readWorkerRequestBody() {
  const workerRequest = mocks.workerFetch.mock.calls[0]?.[0] as Request | undefined;
  return {
    workerRequest,
    body: await workerRequest?.json(),
  };
}

describe("agent deployment run observability routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireSessionAuth.mockReturnValue(true);
    mocks.requireAuthScope.mockReturnValue(false);
    mocks.requireAuthRunAccess.mockReturnValue(true);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.tryResourceValue.mockImplementation((name: string) =>
      name === "AgentGatewayInternalSecret" ? "gateway-key" : undefined,
    );
    mocks.workerFetch.mockResolvedValue(Response.json({ ok: true, proxied: true }));
    mocks.getCloudflareContext.mockReturnValue({
      env: {
        PROACTIVE_RUNTIME_WORKER: { fetch: mocks.workerFetch },
      },
    });
  });

  it("authorizes a session workspace run list read before calling PRW", async () => {
    const input = request(
      "/api/v1/workspaces/workspace-1/deployments/agent-1/runs?limit=25",
    );

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(input, workspaceListContext());

    expect(response.status).toBe(200);
    expect(mocks.resolveRequestAuth).toHaveBeenCalledWith(input);
    expect(mocks.hasWorkspaceAccess).toHaveBeenCalledWith(auth, "workspace-1");
    const { workerRequest, body } = await readWorkerRequestBody();
    expect(workerRequest?.method).toBe("POST");
    expect(workerRequest?.headers.get("x-agent-gateway-secret")).toBe("gateway-key");
    expect(new URL(workerRequest!.url).pathname).toBe(
      "/api/internal/proactive-runtime/deployment-run-observability/read",
    );
    expect(new URL(workerRequest!.url).searchParams.get("limit")).toBe("25");
    expect(body).toEqual({
      kind: "list",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });
  });

  it("rejects unauthenticated reads at the cloud-web facade", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request("/api/v1/workspaces/workspace-1/deployments/agent-1/runs"),
      workspaceListContext(),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Unauthorized",
      code: "unauthorized",
    });
    expect(mocks.workerFetch).not.toHaveBeenCalled();
  });

  it("rejects inaccessible workspace reads before PRW", async () => {
    mocks.hasWorkspaceAccess.mockReturnValue(false);

    const response = await GET_WORKSPACE_DEPLOYMENT_RUNS(
      request("/api/v1/workspaces/workspace-2/deployments/agent-1/runs"),
      {
        params: Promise.resolve({ workspaceId: "workspace-2", agentId: "agent-1" }),
      },
    );

    expect(response.status).toBe(403);
    expect(mocks.workerFetch).not.toHaveBeenCalled();
  });

  it("applies run-scoped auth before proxying detail and envelope reads", async () => {
    await GET_WORKSPACE_DEPLOYMENT_RUN(
      request("/api/v1/workspaces/workspace-1/deployments/agent-1/runs/run-1"),
      workspaceDetailContext(),
    );
    await GET_WORKSPACE_DEPLOYMENT_RUN_ENVELOPE(
      request(
        "/api/v1/workspaces/workspace-1/deployments/agent-1/runs/run-1/envelope",
      ),
      workspaceDetailContext(),
    );

    expect(mocks.requireAuthRunAccess).toHaveBeenCalledTimes(2);
    expect(mocks.requireAuthRunAccess).toHaveBeenCalledWith(auth, "run-1");
    const firstBody = await (mocks.workerFetch.mock.calls[0][0] as Request).json();
    const secondBody = await (mocks.workerFetch.mock.calls[1][0] as Request).json();
    expect(firstBody).toEqual({
      kind: "detail",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      runId: "run-1",
    });
    expect(secondBody).toEqual({
      kind: "envelope",
      workspaceId: "workspace-1",
      agentId: "agent-1",
      runId: "run-1",
    });
  });

  it("rejects run-scoped token misses as not found before PRW", async () => {
    mocks.requireAuthRunAccess.mockReturnValue(false);

    const response = await GET_LEGACY_DEPLOYMENT_RUN(
      request("/api/v1/agents/agent-1/runs/run-1"),
      legacyDetailContext(),
    );

    expect(response.status).toBe(404);
    expect(mocks.workerFetch).not.toHaveBeenCalled();
  });

  it("uses the authenticated workspace for legacy run list reads", async () => {
    await GET_LEGACY_DEPLOYMENT_RUNS(
      request("/api/v1/agents/agent-1/runs?format=compact"),
      legacyListContext(),
    );

    expect(mocks.hasWorkspaceAccess).not.toHaveBeenCalled();
    const { workerRequest, body } = await readWorkerRequestBody();
    expect(new URL(workerRequest!.url).searchParams.get("format")).toBe("compact");
    expect(body).toEqual({
      kind: "list",
      workspaceId: "workspace-1",
      agentId: "agent-1",
    });
  });
});
