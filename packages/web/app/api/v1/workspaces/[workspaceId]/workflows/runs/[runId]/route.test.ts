import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  canAccessWorkflowRun: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  workflowStore: {
    get: vi.fn(),
  },
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthScope: mocks.requireAuthScope,
  canAccessWorkflowRun: mocks.canAccessWorkflowRun,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/workflows", () => ({
  workflowStore: mocks.workflowStore,
}));

import { GET } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";
const RUN_ID = "11111111-1111-1111-1111-111111111111";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: WORKSPACE_ID,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  scopes: ["workflow:invoke:read"],
};

function request(): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/workflows/runs/${RUN_ID}`,
    { method: "GET" },
  );
}

function context() {
  return {
    params: Promise.resolve({ workspaceId: WORKSPACE_ID, runId: RUN_ID }),
  };
}

function buildRun(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    runId: RUN_ID,
    workspaceId: WORKSPACE_ID,
    userId: auth.userId,
    status: "running",
    result: undefined,
    error: undefined,
    ...overrides,
  };
}

describe("GET /api/v1/workspaces/:workspaceId/workflows/runs/:runId", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireAuthScope.mockReturnValue(true);
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.canAccessWorkflowRun.mockReturnValue(true);
  });

  it("returns 401 when auth is missing", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const response = await GET(request(), context());
    expect(response.status).toBe(401);
    expect(mocks.workflowStore.get).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller cannot access the workspace", async () => {
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const response = await GET(request(), context());
    expect(response.status).toBe(403);
    expect(mocks.workflowStore.get).not.toHaveBeenCalled();
  });

  it("returns 403 when workflow:invoke:read scope is missing", async () => {
    mocks.requireAuthScope.mockReturnValue(false);
    const response = await GET(request(), context());
    expect(response.status).toBe(403);
    expect(mocks.requireAuthScope).toHaveBeenCalledWith(
      auth,
      "workflow:invoke:read",
    );
    expect(mocks.workflowStore.get).not.toHaveBeenCalled();
  });

  it("returns 404 when the run does not exist", async () => {
    mocks.workflowStore.get.mockResolvedValue(null);
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
  });

  it("returns 404 when the run belongs to a different workspace", async () => {
    mocks.workflowStore.get.mockResolvedValue(
      buildRun({ workspaceId: "other-workspace" }),
    );
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
  });

  it("returns 404 when the caller fails the workflow-run access check", async () => {
    mocks.workflowStore.get.mockResolvedValue(buildRun());
    mocks.canAccessWorkflowRun.mockReturnValue(false);
    const response = await GET(request(), context());
    expect(response.status).toBe(404);
  });

  it("returns the mapped status with output and error fields when present", async () => {
    mocks.workflowStore.get.mockResolvedValue(
      buildRun({
        status: "succeeded",
        result: { ok: true },
      }),
    );
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runId: RUN_ID,
      status: "success",
      output: { ok: true },
    });
  });

  it("maps internal failure labels to the public failure status", async () => {
    mocks.workflowStore.get.mockResolvedValue(
      buildRun({ status: "failed", error: "boom" }),
    );
    const response = await GET(request(), context());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runId: RUN_ID,
      status: "failure",
      error: "boom",
    });
  });
});
