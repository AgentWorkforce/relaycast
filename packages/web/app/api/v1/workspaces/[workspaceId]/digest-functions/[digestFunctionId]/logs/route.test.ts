import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  fetchRecentInvocationLogs: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/digest-functions", () => ({
  fetchRecentInvocationLogs: mocks.fetchRecentInvocationLogs,
}));

import { GET } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000010";
const digestFunctionId = "df_logs_1";
const sessionAuth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: null,
  source: "session" as const,
  scopes: [] as string[],
};

function req(query = ""): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/digest-functions/${digestFunctionId}/logs${query}`,
    { method: "GET" },
  );
}

function context() {
  return { params: Promise.resolve({ workspaceId, digestFunctionId }) };
}

beforeEach(() => {
  mocks.resolveRequestAuth.mockResolvedValue(sessionAuth);
  mocks.hasWorkspaceAccess.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/workspaces/[workspaceId]/digest-functions/[digestFunctionId]/logs", () => {
  it("401 when unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const res = await GET(req(), context());
    expect(res.status).toBe(401);
  });

  it("403 when authenticated token lacks digest-functions:read or manage scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      ...sessionAuth,
      source: "token" as const,
      scopes: [],
    });
    const res = await GET(req(), context());
    expect(res.status).toBe(403);
    expect(mocks.fetchRecentInvocationLogs).not.toHaveBeenCalled();
  });

  it("403 when workspace access fails", async () => {
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const res = await GET(req(), context());
    expect(res.status).toBe(403);
  });

  it("400 when since is not a valid date", async () => {
    const res = await GET(req("?since=not-a-date"), context());
    expect(res.status).toBe(400);
  });

  it("forwards parsed since and clamped limit", async () => {
    mocks.fetchRecentInvocationLogs.mockResolvedValue({
      digestFunctionId,
      logs: [],
      nextCursor: null,
    });
    const since = "2026-05-14T00:00:00.000Z";
    await GET(req(`?since=${encodeURIComponent(since)}&limit=999`), context());
    expect(mocks.fetchRecentInvocationLogs).toHaveBeenCalledWith({
      workspaceId,
      digestFunctionId,
      since: new Date(since),
      limit: 200,
    });
  });

  it("404 when the orchestrator returns null", async () => {
    mocks.fetchRecentInvocationLogs.mockResolvedValue(null);
    const res = await GET(req(), context());
    expect(res.status).toBe(404);
  });

  it("200 with the log payload on happy path", async () => {
    const payload = {
      digestFunctionId,
      logs: [
        {
          invocationId: "inv_1",
          occurredAt: "2026-05-14T00:00:00.000Z",
          level: "info",
          message: "ok",
          durationMs: 12,
        },
      ],
      nextCursor: null,
    };
    mocks.fetchRecentInvocationLogs.mockResolvedValue(payload);
    const res = await GET(req(), context());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(payload);
  });

  it("500 on unexpected error", async () => {
    mocks.fetchRecentInvocationLogs.mockRejectedValue(new Error("db down"));
    const res = await GET(req(), context());
    expect(res.status).toBe(500);
  });
});
