// @handler /api/v1/workflows/runs/[runId]/cancel
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  canAccessWorkflowRun: vi.fn(),
  workflowStore: {
    get: vi.fn(),
    update: vi.fn(),
  },
  resolveServerDaytonaAuthParams: vi.fn(),
  resolveDaytonaAuthCredentials: vi.fn(),
  createRelayAuthClient: vi.fn(),
  revokeWorkflowIdentity: vi.fn(),
  revokeApiTokenSessionsForRun: vi.fn(),
  daytonaGet: vi.fn(),
  daytonaStop: vi.fn(),
  daytonaDelete: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
  canAccessWorkflowRun: mocks.canAccessWorkflowRun,
}));

vi.mock("@/lib/workflows", () => ({
  workflowStore: mocks.workflowStore,
}));

vi.mock("@/lib/daytona-auth", () => ({
  resolveServerDaytonaAuthParams: mocks.resolveServerDaytonaAuthParams,
}));

vi.mock("@cloud/core/auth/credentials.js", () => ({
  resolveDaytonaAuthCredentials: mocks.resolveDaytonaAuthCredentials,
}));

vi.mock("@cloud/core/relayauth/client.js", () => ({
  createRelayAuthClient: mocks.createRelayAuthClient,
  revokeWorkflowIdentity: mocks.revokeWorkflowIdentity,
}));

vi.mock("@/lib/auth/api-token-store", () => ({
  revokeApiTokenSessionsForRun: mocks.revokeApiTokenSessionsForRun,
}));

vi.mock("@daytonaio/sdk", () => ({
  Daytona: class {
    get = mocks.daytonaGet;
    stop = mocks.daytonaStop;
    delete = mocks.daytonaDelete;
  },
}));

import { POST } from "../../app/api/v1/workflows/runs/[runId]/cancel/route";

describe("POST /api/v1/workflows/runs/[runId]/cancel", () => {
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
    mocks.workflowStore.get.mockResolvedValue({
      runId: "run_123",
      userId: "user_123",
      workspaceId: "rw_12345678",
      status: "running",
      sandboxId: "sandbox_123",
      relayauthIdentityId: "identity_123",
    });
    mocks.workflowStore.update.mockResolvedValue(undefined);
    mocks.resolveServerDaytonaAuthParams.mockReturnValue({
      daytonaApiKey: "api-key",
      daytonaJwtToken: "jwt-token",
      daytonaOrganizationId: "org-daytona",
    });
    mocks.resolveDaytonaAuthCredentials.mockReturnValue({ apiKey: "api-key" });
    mocks.daytonaGet.mockResolvedValue({ id: "sandbox_123" });
    mocks.daytonaStop.mockResolvedValue(undefined);
    mocks.daytonaDelete.mockResolvedValue(undefined);
    mocks.createRelayAuthClient.mockReturnValue({ client: true });
    mocks.revokeWorkflowIdentity.mockResolvedValue(undefined);
    mocks.revokeApiTokenSessionsForRun.mockResolvedValue(undefined);
  });

  function context() {
    return { params: Promise.resolve({ runId: "run_123" }) };
  }

  it("returns 401 when auth is missing", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    const response = await POST(new Request("http://localhost/api/v1/workflows/runs/run_123/cancel", {
      method: "POST",
    }) as never, context());
    expect(response.status).toBe(401);
  });

  it("returns 409 for terminal runs", async () => {
    mocks.workflowStore.get.mockResolvedValueOnce({
      runId: "run_123",
      userId: "user_123",
      workspaceId: "rw_12345678",
      status: "completed",
    });
    const response = await POST(new Request("http://localhost/api/v1/workflows/runs/run_123/cancel", {
      method: "POST",
    }) as never, context());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "Run already completed" });
  });

  it("cancels the run, performs cleanup, and returns the final status", async () => {
    const response = await POST(new Request("http://localhost/api/v1/workflows/runs/run_123/cancel", {
      method: "POST",
    }) as never, context());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({ runId: "run_123", status: "cancelled" });
    expect(mocks.workflowStore.update).toHaveBeenCalledWith("run_123", { status: "cancelled" });
    expect(mocks.daytonaStop).toHaveBeenCalled();
    expect(mocks.daytonaDelete).toHaveBeenCalled();
    expect(mocks.revokeWorkflowIdentity).toHaveBeenCalledWith({ client: true }, "identity_123");
    expect(mocks.revokeApiTokenSessionsForRun).toHaveBeenCalledWith("run_123", "run_cancelled");
  });
});
