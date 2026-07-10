import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  getDigestFunction: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/digest-functions", () => ({
  getDigestFunction: mocks.getDigestFunction,
}));

import { GET } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000010";
const digestFunctionId = "df_show_1";
const sessionAuth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: null,
  source: "session" as const,
  scopes: [] as string[],
};

function req(): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/digest-functions/${digestFunctionId}`,
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

describe("GET /api/v1/workspaces/[workspaceId]/digest-functions/[digestFunctionId]", () => {
  it("401 when unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const res = await GET(req(), context());
    expect(res.status).toBe(401);
  });

  it("403 when token has no read scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      ...sessionAuth,
      source: "token" as const,
      scopes: [],
    });
    const res = await GET(req(), context());
    expect(res.status).toBe(403);
  });

  it("403 when workspace access fails", async () => {
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const res = await GET(req(), context());
    expect(res.status).toBe(403);
  });

  it("404 when the orchestrator returns null", async () => {
    mocks.getDigestFunction.mockResolvedValue(null);
    const res = await GET(req(), context());
    expect(res.status).toBe(404);
  });

  it("200 with the row on happy path", async () => {
    const row = {
      digestFunctionId,
      workspaceId,
      name: "weekly",
      version: 1,
      status: "active",
      sha256: "abc",
      bytes: 100,
      entrypoint: "index.mjs",
      runtime: "node20",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
    };
    mocks.getDigestFunction.mockResolvedValue(row);
    const res = await GET(req(), context());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(row);
  });

  it("500 when the orchestrator throws an unexpected error", async () => {
    mocks.getDigestFunction.mockRejectedValue(new Error("db down"));
    const res = await GET(req(), context());
    expect(res.status).toBe(500);
  });
});
