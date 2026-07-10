// @handler /api/v1/workflows/runs/[runId]/storage/[...objectKey]
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthRunAccess: vi.fn(),
  requireAuthScope: vi.fn(),
  requireSessionAuth: vi.fn(),
  canAccessWorkflowRun: vi.fn(),
  workflowGet: vi.fn(),
  putWorkflowStorageObject: vi.fn(),
  getWorkflowStorageObject: vi.fn(),
  uploadWorkflowStoragePart: vi.fn(),
}));

vi.mock("@/lib/auth/request-auth", () => ({
  resolveRequestAuth: mocks.resolveRequestAuth,
  requireAuthRunAccess: mocks.requireAuthRunAccess,
  requireAuthScope: mocks.requireAuthScope,
  requireSessionAuth: mocks.requireSessionAuth,
  canAccessWorkflowRun: mocks.canAccessWorkflowRun,
}));

vi.mock("@/lib/workflows", () => ({
  workflowStore: {
    get: mocks.workflowGet,
  },
}));

vi.mock("@/lib/storage", () => ({
  buildWorkflowStoragePrefix: ({ userId, runId }: { userId: string; runId: string }) => `${userId}/${runId}`,
  joinWorkflowStorageKey: (prefix: string, key: string) => `${prefix}/${key}`,
  putWorkflowStorageObject: mocks.putWorkflowStorageObject,
  abortWorkflowStorageMultipartUpload: vi.fn(),
  completeWorkflowStorageMultipartUpload: vi.fn(),
  createWorkflowStorageMultipartUpload: vi.fn(),
  getWorkflowStorageObject: mocks.getWorkflowStorageObject,
  headWorkflowStorageObject: vi.fn(),
  uploadWorkflowStoragePart: mocks.uploadWorkflowStoragePart,
}));

import { GET, PUT } from "../../app/api/v1/workflows/runs/[runId]/storage/[...objectKey]/route";

describe("workflow run storage object API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveRequestAuth.mockResolvedValue({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "token",
      subjectType: "cli",
      scopes: ["cli:auth"],
    });
    mocks.requireAuthRunAccess.mockReturnValue(true);
    mocks.requireAuthScope.mockImplementation((auth: { scopes?: string[] }, scope: string) => auth.scopes?.includes(scope) ?? false);
    mocks.requireSessionAuth.mockReturnValue(false);
    mocks.canAccessWorkflowRun.mockReturnValue(true);
    mocks.workflowGet.mockResolvedValue(null);
  });

  it("stores uploaded objects under the authenticated user and run prefix", async () => {
    const request = new NextRequest("https://agentrelay.com/cloud/api/v1/workflows/runs/run-1/storage/code.tar.gz", {
      method: "PUT",
      headers: { "content-type": "application/gzip" },
      body: "tarball",
    });

    const response = await PUT(request, {
      params: Promise.resolve({ runId: "run-1", objectKey: ["code.tar.gz"] }),
    });

    expect(response?.status).toBe(200);
    expect(mocks.putWorkflowStorageObject).toHaveBeenCalledWith({
      key: "user_123/run-1/code.tar.gz",
      body: expect.any(ArrayBuffer),
      contentType: "application/gzip",
    });
    const body = mocks.putWorkflowStorageObject.mock.calls[0]?.[0]?.body as ArrayBuffer;
    expect(new TextDecoder().decode(body)).toBe("tarball");
  });

  it("rejects traversal object keys before touching storage", async () => {
    const request = new NextRequest("https://agentrelay.com/cloud/api/v1/workflows/runs/run-1/storage/../secret", {
      method: "PUT",
      body: "nope",
    });

    const response = await PUT(request, {
      params: Promise.resolve({ runId: "run-1", objectKey: ["..", "secret"] }),
    });

    expect(response?.status).toBe(400);
    expect(mocks.putWorkflowStorageObject).not.toHaveBeenCalled();
  });

  it("rejects session writes even when the session can view the run", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "session",
    });
    mocks.requireSessionAuth.mockReturnValueOnce(true);
    mocks.workflowGet.mockResolvedValueOnce({
      id: "run-1",
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
    });
    const request = new NextRequest("https://agentrelay.com/cloud/api/v1/workflows/runs/run-1/storage/code.tar.gz", {
      method: "PUT",
      body: "tarball",
    });

    const response = await PUT(request, {
      params: Promise.resolve({ runId: "run-1", objectKey: ["code.tar.gz"] }),
    });

    expect(response?.status).toBe(403);
    expect(mocks.putWorkflowStorageObject).not.toHaveBeenCalled();
  });

  it("rejects log-only tokens for generic storage reads", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "token",
      subjectType: "sandbox",
      runId: "run-1",
      scopes: ["workflow:logs:read"],
    });
    const request = new NextRequest("https://agentrelay.com/cloud/api/v1/workflows/runs/run-1/storage/code.tar.gz");

    const response = await GET(request, {
      params: Promise.resolve({ runId: "run-1", objectKey: ["code.tar.gz"] }),
    });

    expect(response?.status).toBe(403);
    expect(mocks.getWorkflowStorageObject).not.toHaveBeenCalled();
  });

  it("allows sandbox invoke-read tokens to read their own run artifacts", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "token",
      subjectType: "sandbox",
      runId: "run-1",
      scopes: ["workflow:invoke:read"],
    });
    mocks.getWorkflowStorageObject.mockResolvedValueOnce({
      body: new Response("ok").body,
      size: 2,
      headers: new Headers({ "content-type": "text/plain" }),
    });
    const request = new NextRequest("https://agentrelay.com/cloud/api/v1/workflows/runs/run-1/storage/logs/run.log");

    const response = await GET(request, {
      params: Promise.resolve({ runId: "run-1", objectKey: ["logs", "run.log"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected storage read response");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
    expect(mocks.getWorkflowStorageObject).toHaveBeenCalledWith({
      key: "user_123/run-1/logs/run.log",
      rangeHeader: null,
    });
  });

  it("allows run-scoped CLI upload tokens with workflow invoke-write scope", async () => {
    mocks.resolveRequestAuth.mockResolvedValueOnce({
      userId: "user_123",
      workspaceId: "rw_12345678",
      organizationId: "org_123",
      source: "token",
      subjectType: "cli",
      runId: "run-1",
      scopes: ["workflow:invoke:write"],
    });
    const request = new NextRequest("https://agentrelay.com/cloud/api/v1/workflows/runs/run-1/storage/code.tar.gz", {
      method: "PUT",
      body: "tarball",
    });

    const response = await PUT(request, {
      params: Promise.resolve({ runId: "run-1", objectKey: ["code.tar.gz"] }),
    });

    expect(response?.status).toBe(200);
    expect(mocks.putWorkflowStorageObject).toHaveBeenCalledWith({
      key: "user_123/run-1/code.tar.gz",
      body: expect.any(ArrayBuffer),
      contentType: "text/plain;charset=UTF-8",
    });
  });

  it("buffers multipart upload parts before forwarding to workflow storage", async () => {
    mocks.uploadWorkflowStoragePart.mockResolvedValueOnce("part-etag");
    const request = new NextRequest("https://agentrelay.com/cloud/api/v1/workflows/runs/run-1/storage/code.tar.gz?uploadId=upload-1&partNumber=2", {
      method: "PUT",
      body: "part-body",
    });

    const response = await PUT(request, {
      params: Promise.resolve({ runId: "run-1", objectKey: ["code.tar.gz"] }),
    });

    expect(response?.status).toBe(200);
    if (!response) throw new Error("Expected multipart upload response");
    await expect(response.json()).resolves.toEqual({ etag: "part-etag" });
    expect(mocks.uploadWorkflowStoragePart).toHaveBeenCalledWith({
      key: "user_123/run-1/code.tar.gz",
      uploadId: "upload-1",
      partNumber: 2,
      body: expect.any(ArrayBuffer),
    });
    const body = mocks.uploadWorkflowStoragePart.mock.calls[0]?.[0]?.body as ArrayBuffer;
    expect(new TextDecoder().decode(body)).toBe("part-body");
  });
});
