import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  hasWorkspaceAccess: vi.fn(),
  createCloudWorkspaceRegistry: vi.fn(),
  hasWorkspaceOwnerAccess: vi.fn(),
  deployDigestFunction: vi.fn(),
  listDigestFunctions: vi.fn(),
  parseDigestFunctionDeployRequest: vi.fn((raw: unknown) => raw),
}));

vi.mock("@/lib/auth/request-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/request-auth")>()),
  resolveRequestAuth: mocks.resolveRequestAuth,
}));

vi.mock("@/lib/integrations/integration-route-handler", () => ({
  hasWorkspaceAccess: mocks.hasWorkspaceAccess,
}));

vi.mock("@/lib/workspace-registry", () => ({
  createCloudWorkspaceRegistry: mocks.createCloudWorkspaceRegistry,
  hasWorkspaceOwnerAccess: mocks.hasWorkspaceOwnerAccess,
}));

vi.mock("@/lib/digest-functions", () => ({
  deployDigestFunction: mocks.deployDigestFunction,
  listDigestFunctions: mocks.listDigestFunctions,
  parseDigestFunctionDeployRequest: mocks.parseDigestFunctionDeployRequest,
}));

import { GET, POST } from "./route";

const workspaceId = "00000000-0000-0000-0000-000000000010";

const sessionAuth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId,
  organizationId: "00000000-0000-0000-0000-000000000003",
  source: "session" as const,
  scopes: [] as string[],
};

const tokenAuth = {
  userId: sessionAuth.userId,
  workspaceId,
  organizationId: sessionAuth.organizationId,
  source: "token" as const,
  scopes: ["cli:auth"],
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/digest-functions`, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

function getRequest(query = ""): NextRequest {
  return new NextRequest(
    `https://cloud.test/api/v1/workspaces/${workspaceId}/digest-functions${query}`,
    { method: "GET" },
  );
}

function context() {
  return { params: Promise.resolve({ workspaceId }) };
}

beforeEach(() => {
  mocks.resolveRequestAuth.mockResolvedValue(sessionAuth);
  mocks.hasWorkspaceAccess.mockReturnValue(true);
  mocks.createCloudWorkspaceRegistry.mockReturnValue({
    registry: {
      get: vi.fn().mockResolvedValue(null),
    },
  });
  mocks.hasWorkspaceOwnerAccess.mockReturnValue(false);
  mocks.parseDigestFunctionDeployRequest.mockImplementation((raw: unknown) => raw);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/workspaces/[workspaceId]/digest-functions", () => {
  it("returns 401 when there is no auth", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const res = await POST(postRequest({ files: [] }), context());
    expect(res.status).toBe(401);
  });

  it("returns 403 when token lacks management scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({ ...tokenAuth, scopes: [] });
    const res = await POST(postRequest({ files: [] }), context());
    expect(res.status).toBe(403);
  });

  it("returns 403 when workspace access fails", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(tokenAuth);
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const res = await POST(postRequest({ files: [] }), context());
    expect(res.status).toBe(403);
  });

  it("allows a cli token to manage an owned target workspace", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({
      ...tokenAuth,
      workspaceId: "00000000-0000-0000-0000-000000000099",
    });
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const workspace = { id: workspaceId, createdBy: tokenAuth.userId };
    const get = vi.fn().mockResolvedValue(workspace);
    mocks.createCloudWorkspaceRegistry.mockReturnValue({ registry: { get } });
    mocks.hasWorkspaceOwnerAccess.mockReturnValue(true);
    mocks.deployDigestFunction.mockResolvedValue({
      digestFunctionId: "df_1",
      version: 1,
      status: "active",
      sha256: "abc",
    });

    const res = await POST(postRequest({ files: [] }), context());

    expect(res.status).toBe(201);
    expect(get).toHaveBeenCalledWith(workspaceId);
    expect(mocks.hasWorkspaceOwnerAccess).toHaveBeenCalledWith(workspace, tokenAuth.userId);
  });

  it("returns 400 on invalid JSON body", async () => {
    const req = new NextRequest(`https://cloud.test/api/v1/workspaces/${workspaceId}/digest-functions`, {
      method: "POST",
      body: "{not json",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req, context());
    expect(res.status).toBe(400);
  });

  it("returns 400 when schema validation throws an orchestration error", async () => {
    const err = Object.assign(new Error("invalid digest function input"), {
      status: 400,
      code: "DIGEST_INPUT_INVALID",
      details: { field: "files" },
    });
    mocks.parseDigestFunctionDeployRequest.mockImplementation(() => {
      throw err;
    });
    const res = await POST(postRequest({ files: "not-an-array" }), context());
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: "invalid digest function input",
      code: "DIGEST_INPUT_INVALID",
      details: { field: "files" },
    });
    expect(mocks.deployDigestFunction).not.toHaveBeenCalled();
  });

  it("returns 201 with deploy result on happy path", async () => {
    mocks.deployDigestFunction.mockResolvedValue({
      digestFunctionId: "df_1",
      version: 1,
      status: "active",
      sha256: "abc",
    });
    const res = await POST(postRequest({ files: [{ path: "index.mjs", contents: "export {}" }] }), context());
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({
      digestFunctionId: "df_1",
      version: 1,
      status: "active",
      sha256: "abc",
    });
    expect(mocks.deployDigestFunction).toHaveBeenCalledWith({
      workspaceId,
      requesterUserId: sessionAuth.userId,
      body: { files: [{ path: "index.mjs", contents: "export {}" }] },
    });
  });

  it("maps orchestration errors with status to that status", async () => {
    const err = Object.assign(new Error("bundle too big"), { status: 413, code: "DIGEST_QUOTA_EXCEEDED" });
    mocks.deployDigestFunction.mockRejectedValue(err);
    const res = await POST(postRequest({ files: [] }), context());
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: "bundle too big",
      code: "DIGEST_QUOTA_EXCEEDED",
      details: undefined,
    });
  });

  it("returns 500 for unexpected errors", async () => {
    mocks.deployDigestFunction.mockRejectedValue(new Error("boom"));
    const res = await POST(postRequest({ files: [] }), context());
    expect(res.status).toBe(500);
  });
});

describe("GET /api/v1/workspaces/[workspaceId]/digest-functions", () => {
  it("returns 401 when unauthenticated", async () => {
    mocks.resolveRequestAuth.mockResolvedValue(null);
    const res = await GET(getRequest(), context());
    expect(res.status).toBe(401);
  });

  it("returns 403 when authenticated token lacks digest-functions:read or manage scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValue({ ...tokenAuth, scopes: [] });
    const res = await GET(getRequest(), context());
    expect(res.status).toBe(403);
    expect(mocks.listDigestFunctions).not.toHaveBeenCalled();
  });

  it("returns 403 when workspace access fails", async () => {
    mocks.hasWorkspaceAccess.mockReturnValue(false);
    const res = await GET(getRequest(), context());
    expect(res.status).toBe(403);
  });

  it("clamps the limit and forwards cursor", async () => {
    mocks.listDigestFunctions.mockResolvedValue({
      digestFunctions: [],
      nextCursor: null,
    });
    await GET(getRequest("?cursor=abc&limit=999"), context());
    expect(mocks.listDigestFunctions).toHaveBeenCalledWith({
      workspaceId,
      cursor: "abc",
      limit: 100,
    });
  });

  it("returns the list payload on happy path", async () => {
    const payload = {
      digestFunctions: [
        {
          digestFunctionId: "df_1",
          name: "weekly",
          version: 2,
          status: "active",
          sha256: "abc",
          bytes: 12,
          createdAt: "2026-05-14T00:00:00.000Z",
        },
      ],
      nextCursor: null,
    };
    mocks.listDigestFunctions.mockResolvedValue(payload);
    const res = await GET(getRequest(), context());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(payload);
  });
});
