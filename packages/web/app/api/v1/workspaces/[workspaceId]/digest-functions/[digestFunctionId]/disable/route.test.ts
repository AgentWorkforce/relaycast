import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  disableDigestFunction: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/digest-functions", () => ({
  disableDigestFunction: mocks.disableDigestFunction,
}));

import { POST } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000010";
const digestFunctionId = "df_disable_1";
const sessionAuth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: null,
  source: "session" as const,
  scopes: [] as string[],
};

function req(): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/digest-functions/${digestFunctionId}/disable`,
    { method: "POST" },
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

describe("POST /api/v1/workspaces/[workspaceId]/digest-functions/[digestFunctionId]/disable", () => {
  it("401 when unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const res = await POST(req(), context());
    expect(res.status).toBe(401);
  });

  it("403 when token lacks management scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      ...sessionAuth,
      source: "token" as const,
      scopes: [],
    });
    const res = await POST(req(), context());
    expect(res.status).toBe(403);
  });

  it("403 when workspace access fails", async () => {
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const res = await POST(req(), context());
    expect(res.status).toBe(403);
  });

  it("404 when the digest function is unknown", async () => {
    mocks.disableDigestFunction.mockResolvedValue(null);
    const res = await POST(req(), context());
    expect(res.status).toBe(404);
  });

  it("200 with disable result on happy path", async () => {
    const result = {
      digestFunctionId,
      status: "disabled" as const,
      disabledAt: "2026-05-14T00:00:00.000Z",
      alreadyDisabled: false,
    };
    mocks.disableDigestFunction.mockResolvedValue(result);
    const res = await POST(req(), context());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(result);
    expect(mocks.disableDigestFunction).toHaveBeenCalledWith({
      workspaceId,
      digestFunctionId,
      requesterUserId: sessionAuth.userId,
    });
  });

  it("idempotent re-disable returns 200 with alreadyDisabled true", async () => {
    mocks.disableDigestFunction.mockResolvedValue({
      digestFunctionId,
      status: "disabled" as const,
      disabledAt: "2026-05-14T00:00:00.000Z",
      alreadyDisabled: true,
    });
    const res = await POST(req(), context());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ alreadyDisabled: true });
  });

  it("500 on unexpected error", async () => {
    mocks.disableDigestFunction.mockRejectedValue(new Error("db down"));
    const res = await POST(req(), context());
    expect(res.status).toBe(500);
  });
});
