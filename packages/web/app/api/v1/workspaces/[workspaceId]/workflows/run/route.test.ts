import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eq: vi.fn(),
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  getDb: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  resolveWorkflowSlug: vi.fn(),
  listRegisteredSlugs: vi.fn(),
  recordWorkflowInvocation: vi.fn(),
  launchWorkflowRun: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: mocks.eq,
}));

vi.mock("@/app/api/v1/workflows/run/route", () => ({
  POST: mocks.launchWorkflowRun,
  WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_HEADER:
    "x-agentworkforce-workspace-workflow-invocation",
  WORKSPACE_WORKFLOW_INVOCATION_DELEGATION_TOKEN: "test-delegation-token",
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthScope: mocks.requireAuthScope,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  workspaces: {
    id: "workspaces.id",
    defaultRuntime: "workspaces.defaultRuntime",
  },
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/workflows/invocation-registry", () => ({
  resolveWorkflowSlug: mocks.resolveWorkflowSlug,
  listRegisteredSlugs: mocks.listRegisteredSlugs,
}));

vi.mock("../workflow-invocation-audit", () => ({
  recordWorkflowInvocation: mocks.recordWorkflowInvocation,
}));

import { POST } from "./route";

const WORKSPACE_ID = "00000000-0000-0000-0000-000000000002";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: WORKSPACE_ID,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "token" as const,
  scopes: ["workflow:invoke:write"],
};

function request(body?: unknown): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${WORKSPACE_ID}/workflows/run`,
    {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      headers:
        body === undefined ? undefined : { "content-type": "application/json" },
    },
  );
}

function context() {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };
}

describe("POST /api/v1/workspaces/:workspaceId/workflows/run", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue(auth);
    mocks.requireAuthScope.mockReturnValue(true);
    mocks.getDb.mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ defaultRuntime: { id: "daytona" } }]),
          }),
        }),
      }),
    });
    mocks.hasWorkspaceAccess.mockReturnValue(true);
    mocks.resolveWorkflowSlug.mockReturnValue(undefined);
    mocks.listRegisteredSlugs.mockReturnValue([]);
    mocks.launchWorkflowRun.mockResolvedValue(
      Response.json({ runId: "run_test", status: "queued" }, { status: 200 }),
    );
  });

  it("returns 401 when auth is missing", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const response = await POST(
      request({ name: "weekly-digest", args: {} }),
      context(),
    );
    expect(response.status).toBe(401);
    expect(mocks.resolveWorkflowSlug).not.toHaveBeenCalled();
  });

  it("returns 403 when the caller cannot access the workspace", async () => {
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const response = await POST(
      request({ name: "weekly-digest", args: {} }),
      context(),
    );
    expect(response.status).toBe(403);
    expect(mocks.resolveWorkflowSlug).not.toHaveBeenCalled();
  });

  it("returns 403 when the workflow:invoke:write scope is missing", async () => {
    mocks.requireAuthScope.mockReturnValue(false);
    const response = await POST(
      request({ name: "weekly-digest", args: {} }),
      context(),
    );
    expect(response.status).toBe(403);
    expect(mocks.requireAuthScope).toHaveBeenCalledWith(
      auth,
      "workflow:invoke:write",
    );
    expect(mocks.resolveWorkflowSlug).not.toHaveBeenCalled();
  });

  it("returns 400 when the body is malformed", async () => {
    const response = await POST(request({ args: {} }), context());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid request body",
      code: "invalid_request",
    });
  });

  it("returns 404 with the known slug list when the slug is unregistered", async () => {
    mocks.listRegisteredSlugs.mockReturnValue(["foo", "bar"]);
    const response = await POST(
      request({ name: "unknown", args: { x: 1 } }),
      context(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "Unknown workflow slug: unknown",
      code: "workflow_slug_not_found",
      knownSlugs: ["foo", "bar"],
    });
    expect(mocks.recordWorkflowInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        slug: "unknown",
        requester: auth.userId,
        outcome: "rejected_unknown_slug",
      }),
    );
  });

  it("audit-logs rejected_launch_failed when the delegate returns a non-ok response", async () => {
    mocks.resolveWorkflowSlug.mockReturnValue({
      slug: "echo",
      s3CodeKey: "workflows/echo/latest.tar.gz",
      fileType: "ts",
      sourceFileType: "ts",
      workflowPath: "workflow.ts",
      workflow: "export default workflow('echo', async () => ({ ok: true }));",
    });
    mocks.launchWorkflowRun.mockResolvedValue(
      Response.json(
        { error: "downstream rejected", code: "downstream_rejected" },
        { status: 500 },
      ),
    );
    const response = await POST(
      request({ name: "echo", args: { foo: 1 } }),
      context(),
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "downstream rejected",
      code: "downstream_rejected",
    });
    expect(mocks.recordWorkflowInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        slug: "echo",
        runId: "",
        requester: auth.userId,
        outcome: "rejected_launch_failed",
      }),
    );
  });

  it("synthesizes the heavy workflow run body and returns the delegated runId", async () => {
    mocks.resolveWorkflowSlug.mockReturnValue({
      slug: "echo",
      s3CodeKey: "workflows/echo/latest.tar.gz",
      fileType: "ts",
      sourceFileType: "ts",
      workflowPath: "workflow.ts",
      workflow: "export default workflow('echo', async () => ({ ok: true }));",
    });
    const response = await POST(
      request({ name: "echo", args: { foo: 1 } }),
      context(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      runId: "run_test",
      status: "queued",
    });
    expect(mocks.launchWorkflowRun).toHaveBeenCalledOnce();
    const delegatedRequest = mocks.launchWorkflowRun.mock.calls[0][0] as NextRequest;
    expect(delegatedRequest.headers.get("x-agentworkforce-workspace-workflow-invocation")).toBe(
      "test-delegation-token",
    );
    await expect(delegatedRequest.json()).resolves.toMatchObject({
      workflow: "export default workflow('echo', async () => ({ ok: true }));",
      fileType: "ts",
      sourceFileType: "ts",
      s3CodeKey: "workflows/echo/latest.tar.gz",
      workflowPath: "workflow.ts",
      runtime: { id: "daytona" },
      metadata: {
        invocationSlug: "echo",
        invocationArgs: JSON.stringify({ foo: 1 }),
      },
    });
    expect(mocks.recordWorkflowInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        slug: "echo",
        runId: "run_test",
        requester: auth.userId,
        outcome: "accepted",
      }),
    );
  });

  it("defaults sourceFileType to workflow unless the registry entry explicitly overrides it", async () => {
    mocks.resolveWorkflowSlug.mockReturnValue({
      slug: "echo",
      s3CodeKey: "workflows/echo/latest.tar.gz",
      fileType: "ts",
      workflowPath: "workflow.ts",
      workflow: "export default workflow('echo', async () => ({ ok: true }));",
    });

    const response = await POST(
      request({ name: "echo", args: { foo: 1 } }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(mocks.launchWorkflowRun).toHaveBeenCalledOnce();
    const delegatedRequest = mocks.launchWorkflowRun.mock.calls[0][0] as NextRequest;
    const delegatedBody = await delegatedRequest.json();
    expect(delegatedBody).toMatchObject({
      fileType: "ts",
      s3CodeKey: "workflows/echo/latest.tar.gz",
      workflowPath: "workflow.ts",
      sourceFileType: "workflow",
    });
  });

  it("propagates heavy workflow launch failures", async () => {
    mocks.resolveWorkflowSlug.mockReturnValue({
      slug: "echo",
      s3CodeKey: "workflows/echo/latest.tar.gz",
      fileType: "ts",
      workflow: "export default workflow('echo', async () => ({ ok: true }));",
    });
    mocks.launchWorkflowRun.mockResolvedValue(
      Response.json({ error: "Forbidden" }, { status: 403 }),
    );
    const response = await POST(request({ name: "echo", args: {} }), context());
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Forbidden" });
    expect(mocks.recordWorkflowInvocation).not.toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "accepted" }),
    );
  });
});
