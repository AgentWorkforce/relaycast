// @handler /api/v1/workflows/runs/[runId]/events
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  canAccessWorkflowRun: vi.fn(),
  getDb: vi.fn(),
  createDbEventClient: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: mocks.eq,
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
  canAccessWorkflowRun: mocks.canAccessWorkflowRun,
}));

vi.mock("@/lib/db", () => ({
  getDb: mocks.getDb,
}));

vi.mock("@/lib/db/schema", () => ({
  workflowRuns: {
    id: "workflow_runs.id",
    userId: "workflow_runs.user_id",
    workspaceId: "workflow_runs.workspace_id",
  },
}));

vi.mock("@cloud/core/session/events.js", () => ({
  createDbEventClient: mocks.createDbEventClient,
}));

import { POST } from "../../app/api/v1/workflows/runs/[runId]/events/route";

describe("POST /api/v1/workflows/runs/[runId]/events", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "session",
    });
    mocks.requireSessionAuth.mockReturnValue(true);
    mocks.requireAuthScope.mockReturnValue(true);
    mocks.canAccessWorkflowRun.mockReturnValue(true);
    mocks.eq.mockReturnValue("where");
    mocks.getDb.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([
              {
                id: "run_123",
                userId: "user_123",
                workspaceId: "rw_12345678",
              },
            ]),
          })),
        })),
      })),
    });
    mocks.createDbEventClient.mockReturnValue({
      emit: vi.fn().mockResolvedValue({ sequence: 7 }),
    });
  });

  function context() {
    return { params: Promise.resolve({ runId: "run_123" }) };
  }

  it("returns 401 when auth is missing", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const response = await POST(
      new Request("http://localhost/api/v1/workflows/runs/run_123/events", {
        method: "POST",
      }) as never,
      context(),
    );
    expect(response.status).toBe(401);
  });

  it("returns 400 for invalid JSON bodies", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/workflows/runs/run_123/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }) as never,
      context(),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid body" });
  });

  it("returns 404 when the run cannot be accessed", async () => {
    mocks.canAccessWorkflowRun.mockReturnValueOnce(false);
    const response = await POST(
      new Request("http://localhost/api/v1/workflows/runs/run_123/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ eventType: "step.started" }),
      }) as never,
      context(),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Run not found" });
  });

  it("emits the event and returns the assigned sequence", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/workflows/runs/run_123/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventType: "step.started",
          stepName: "compile",
          payload: { ok: true },
        }),
      }) as never,
      context(),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({ runId: "run_123", sequence: 7 });
    expect(mocks.createDbEventClient.mock.results[0]!.value.emit).toHaveBeenCalledWith({
      runId: "run_123",
      eventType: "step.started",
      stepName: "compile",
      sandboxId: undefined,
      payload: { ok: true },
    });
  });
});
