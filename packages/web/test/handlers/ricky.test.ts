// @handler /api/v1/ricky/runs
// @handler /api/v1/ricky/runs/[rickyRunId]
// @handler /api/v1/ricky/runs/[rickyRunId]/cancel
// @handler /api/v1/ricky/runs/[rickyRunId]/gates/[gateId]/resolve
// @handler /api/v1/ricky/slack/oauth/start
// @handler /api/v1/ricky/slack/oauth/callback
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  isCreateRickyRunRequest: vi.fn(),
  canAccessRickyRun: vi.fn(),
  rickyRunSupervisor: {
    create: vi.fn(),
    getDetail: vi.fn(),
    advance: vi.fn(),
    cancel: vi.fn(),
    resolveGate: vi.fn(),
  },
  notifyRickySlackRunState: vi.fn(),
  createConnectSession: vi.fn(),
  getProviderConfigKey: vi.fn(),
  rickySlackStore: {
    findActiveInstallationByTeam: vi.fn(),
    upsertUserLink: vi.fn(),
  },
  completeRickySlackInstall: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
}));

vi.mock("@/lib/ricky/run-supervisor", () => ({
  isCreateRickyRunRequest: mocks.isCreateRickyRunRequest,
  canAccessRickyRun: mocks.canAccessRickyRun,
  rickyRunSupervisor: mocks.rickyRunSupervisor,
}));

vi.mock("@/lib/ricky/slack/proactive", () => ({
  notifyRickySlackRunState: mocks.notifyRickySlackRunState,
}));

vi.mock("@/lib/integrations/nango-service", () => ({
  createConnectSession: mocks.createConnectSession,
  getProviderConfigKey: mocks.getProviderConfigKey,
}));

vi.mock("@/lib/ricky/slack/store", () => ({
  RICKY_SLACK_PROVIDER: "ricky-slack",
  rickySlackStore: mocks.rickySlackStore,
}));

vi.mock("@/lib/ricky/slack/ingress", () => ({
  completeRickySlackInstall: mocks.completeRickySlackInstall,
}));

describe("ricky handlers", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "session",
      context: {
        user: { email: "dev@example.com" },
      },
    });
    mocks.requireSessionAuth.mockImplementation((auth) => auth?.source === "session");
    mocks.requireAuthScope.mockReturnValue(true);
    mocks.isCreateRickyRunRequest.mockReturnValue(true);
    mocks.canAccessRickyRun.mockReturnValue(true);
    mocks.rickyRunSupervisor.create.mockResolvedValue({
      rickyRunId: "ricky_123",
      rootRunId: "run_123",
      status: "running",
    });
    mocks.rickyRunSupervisor.getDetail.mockResolvedValue({
      id: "ricky_123",
      workspaceId: "rw_12345678",
      status: "running",
    });
    mocks.rickyRunSupervisor.advance.mockResolvedValue(undefined);
    mocks.rickyRunSupervisor.cancel.mockResolvedValue({
      status: "canceled",
      activeWorkflowRunId: null,
    });
    mocks.rickyRunSupervisor.resolveGate.mockResolvedValue({
      id: "gate_123",
      status: "approved",
    });
    mocks.notifyRickySlackRunState.mockResolvedValue(undefined);
    mocks.getProviderConfigKey.mockReturnValue("slack-provider");
    mocks.rickySlackStore.findActiveInstallationByTeam.mockResolvedValue(null);
    mocks.createConnectSession.mockResolvedValue({
      connectLink: "https://nango.test/connect",
    });
    mocks.completeRickySlackInstall.mockResolvedValue({
      workspaceId: "rw_12345678",
      slackTeamId: "T123",
    });
  });

  it("creates a ricky run and returns the supervisor response", async () => {
    const { POST } = await import("../../app/api/v1/ricky/runs/route");
    const response = await POST(
      new Request("http://localhost/api/v1/ricky/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "repair" }),
      }) as never,
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      rickyRunId: "ricky_123",
      rootRunId: "run_123",
      status: "running",
    });
  });

  it("returns 500 when ricky run creation fails downstream", async () => {
    mocks.rickyRunSupervisor.create.mockRejectedValueOnce(new Error("supervisor down"));
    const { POST } = await import("../../app/api/v1/ricky/runs/route");
    const response = await POST(
      new Request("http://localhost/api/v1/ricky/runs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ objective: "repair" }),
      }) as never,
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "internal" });
  });

  it("advances the ricky run monitor and tolerates notify failures", async () => {
    mocks.notifyRickySlackRunState.mockRejectedValueOnce(new Error("slack down"));
    const { GET } = await import("../../app/api/v1/ricky/runs/[rickyRunId]/route");
    const response = await GET(
      new Request("http://localhost/api/v1/ricky/runs/ricky_123", {
        method: "GET",
      }) as never,
      { params: Promise.resolve({ rickyRunId: "ricky_123" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type") ?? "").toContain("application/json");
    await expect(response.json()).resolves.toEqual({
      id: "ricky_123",
      workspaceId: "rw_12345678",
      status: "running",
    });
    expect(mocks.rickyRunSupervisor.advance).toHaveBeenCalledWith(
      "ricky_123",
      expect.any(Request),
    );
  });

  it("cancels the ricky run and returns the normalized body", async () => {
    const { POST } = await import("../../app/api/v1/ricky/runs/[rickyRunId]/cancel/route");
    const response = await POST(
      new Request("http://localhost/api/v1/ricky/runs/ricky_123/cancel", {
        method: "POST",
      }) as never,
      { params: Promise.resolve({ rickyRunId: "ricky_123" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      rickyRunId: "ricky_123",
      status: "canceled",
      activeWorkflowRunId: null,
    });
  });

  it("validates gate resolution bodies before calling the supervisor", async () => {
    const { POST } = await import("../../app/api/v1/ricky/runs/[rickyRunId]/gates/[gateId]/resolve/route");
    const response = await POST(
      new Request("http://localhost/api/v1/ricky/runs/ricky_123/gates/gate_123/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "edit" }),
      }) as never,
      { params: Promise.resolve({ rickyRunId: "ricky_123", gateId: "gate_123" }) },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid gate resolution" });
  });

  it("resolves gates through the supervisor for session-authenticated callers", async () => {
    const { POST } = await import("../../app/api/v1/ricky/runs/[rickyRunId]/gates/[gateId]/resolve/route");
    const response = await POST(
      new Request("http://localhost/api/v1/ricky/runs/ricky_123/gates/gate_123/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approve" }),
      }) as never,
      { params: Promise.resolve({ rickyRunId: "ricky_123", gateId: "gate_123" }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      gate: { id: "gate_123", status: "approved" },
    });
  });

  it("redirects unauthenticated slack oauth starts back into google auth", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce(null);
    mocks.requireSessionAuth.mockReturnValueOnce(false);
    const { GET } = await import("../../app/api/v1/ricky/slack/oauth/start/route");
    const response = await GET(
      new NextRequest("http://localhost/api/v1/ricky/slack/oauth/start?slack_team_id=T123&slack_user_id=U123", {
        method: "GET",
      }) as never,
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location") ?? "").toContain("/api/auth/google/start");
  });

  it("links a known slack installation without going through Nango", async () => {
    mocks.rickySlackStore.findActiveInstallationByTeam.mockResolvedValueOnce({
      workspaceId: "rw_12345678",
    });
    const { GET } = await import("../../app/api/v1/ricky/slack/oauth/start/route");
    const response = await GET(
      new NextRequest("http://localhost/api/v1/ricky/slack/oauth/start?slack_team_id=T123&slack_user_id=U123", {
        method: "GET",
      }) as never,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      linked: true,
      workspaceId: "rw_12345678",
      slackTeamId: "T123",
    });
    expect(mocks.rickySlackStore.upsertUserLink).toHaveBeenCalledOnce();
    expect(mocks.createConnectSession).not.toHaveBeenCalled();
  });

  it("completes the slack oauth callback and surfaces deterministic failures", async () => {
    const { GET } = await import("../../app/api/v1/ricky/slack/oauth/callback/route");
    const success = await GET(
      new NextRequest("http://localhost/api/v1/ricky/slack/oauth/callback?connection_id=conn_123", {
        method: "GET",
      }) as never,
    );

    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toEqual({
      ok: true,
      workspaceId: "rw_12345678",
      slackTeamId: "T123",
    });

    mocks.completeRickySlackInstall.mockRejectedValueOnce(new Error("oauth failed"));
    const failure = await GET(
      new NextRequest("http://localhost/api/v1/ricky/slack/oauth/callback?connection_id=conn_123", {
        method: "GET",
      }) as never,
    );
    expect(failure.status).toBe(500);
    await expect(failure.json()).resolves.toEqual({
      error: "slack_oauth_callback_failed",
    });
  });
});
