// @handler /api/v1/workers/[workerId]/assignments/[runId]/storage/[...objectKey]
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireWorkerAuth: vi.fn(),
  getWorkerStorageAssignment: vi.fn(),
  workflowGet: vi.fn(),
  getWorkflowStorageObject: vi.fn(),
  headWorkflowStorageObject: vi.fn(),
}));

vi.mock("@/lib/workers/auth", () => ({
  WorkerAuthError: class WorkerAuthError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = "WorkerAuthError";
    }
  },
  requireWorkerAuth: mocks.requireWorkerAuth,
}));

vi.mock("@/lib/workers/storage-assignment", () => ({
  getWorkerStorageAssignment: mocks.getWorkerStorageAssignment,
}));

vi.mock("@/lib/workflows", () => ({
  workflowStore: {
    get: mocks.workflowGet,
  },
}));

vi.mock("@/lib/storage", () => ({
  buildWorkflowStoragePrefix: ({ userId, runId }: { userId: string; runId: string }) => `${userId}/${runId}`,
  joinWorkflowStorageKey: (prefix: string, key: string) => `${prefix}/${key}`,
  getWorkflowStorageObject: mocks.getWorkflowStorageObject,
  headWorkflowStorageObject: mocks.headWorkflowStorageObject,
}));

import { GET, HEAD } from "../../app/api/v1/workers/[workerId]/assignments/[runId]/storage/[...objectKey]/route";
import { WorkerAuthError } from "@/lib/workers/auth";

function inlineAssignment(options: {
  assignment?: Record<string, unknown>;
  payload?: Record<string, unknown>;
} = {}) {
  return {
    id: "wa_1",
    workspaceId: "rw_1",
    workerId: "wrk_1",
    runId: "run_1",
    status: "assigned",
    workflowRef: {
      type: "inline",
      value: JSON.stringify({
        runId: "run_1",
        workspaceId: "rw_1",
        relayWorkspaceId: "relay_1",
        relaycastApiKey: "rk_test",
        relayfileUrl: "https://relayfile.test",
        relayfileToken: "relayfile_token",
        workflow: "name: test",
        fileType: "yaml",
        sourceFileType: "yaml",
        workflowFileName: "workflow.yaml",
        s3CodeKey: "code.tar.gz",
        paths: [{ name: "app", s3CodeKey: "code-app.tar.gz" }],
        ...options.payload,
      }),
    },
    queuedAt: new Date().toISOString(),
    assignedAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    queueDeadline: new Date(Date.now() + 60_000).toISOString(),
    ...options.assignment,
  };
}

describe("worker assignment storage API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireWorkerAuth.mockResolvedValue({ id: "wrk_1", status: "online" });
    mocks.getWorkerStorageAssignment.mockResolvedValue(inlineAssignment());
    mocks.workflowGet.mockResolvedValue({
      runId: "run_1",
      userId: "user_123",
      workspaceId: "rw_1",
    });
  });

  it("streams an assigned worker's allowed R2 object by run owner prefix", async () => {
    mocks.getWorkflowStorageObject.mockResolvedValueOnce({
      body: new Response("tarball").body,
      size: 7,
      headers: new Headers({ "content-type": "application/gzip" }),
    });

    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/code.tar.gz",
    );

    const response = await GET(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["code.tar.gz"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected worker storage response");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("tarball");
    expect(mocks.requireWorkerAuth).toHaveBeenCalledWith(request, "wrk_1");
    expect(mocks.getWorkflowStorageObject).toHaveBeenCalledWith({
      key: "user_123/run_1/code.tar.gz",
      rangeHeader: null,
    });
  });

  it("allows path tarballs listed on the worker assignment payload", async () => {
    mocks.getWorkflowStorageObject.mockResolvedValueOnce({
      body: new Response("path").body,
      size: 4,
      headers: new Headers(),
    });

    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/code-app.tar.gz",
    );

    const response = await GET(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["code-app.tar.gz"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected worker path storage response");
    expect(response.status).toBe(200);
    expect(mocks.getWorkflowStorageObject).toHaveBeenCalledWith({
      key: "user_123/run_1/code-app.tar.gz",
      rangeHeader: null,
    });
  });

  it("allows assignment payloads that already carry the owner/run storage prefix", async () => {
    mocks.getWorkerStorageAssignment.mockResolvedValueOnce(inlineAssignment({
      payload: {
        s3CodeKey: "user_123/run_1/code.tar.gz",
        paths: [{ name: "app", s3CodeKey: "user_123/run_1/code-app.tar.gz" }],
      },
    }));
    mocks.getWorkflowStorageObject.mockResolvedValueOnce({
      body: new Response("prefixed").body,
      size: 8,
      headers: new Headers(),
    });

    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/code.tar.gz",
    );

    const response = await GET(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["code.tar.gz"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected prefixed worker storage response");
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("prefixed");
    expect(mocks.getWorkflowStorageObject).toHaveBeenCalledWith({
      key: "user_123/run_1/code.tar.gz",
      rangeHeader: null,
    });
  });

  it("supports HEAD for allowed objects without returning a body", async () => {
    mocks.headWorkflowStorageObject.mockResolvedValueOnce({
      size: 42,
      headers: new Headers({ "content-type": "application/gzip" }),
    });

    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/code.tar.gz",
      { method: "HEAD" },
    );

    const response = await HEAD(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["code.tar.gz"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected worker storage HEAD response");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe("42");
    expect(mocks.headWorkflowStorageObject).toHaveBeenCalledWith("user_123/run_1/code.tar.gz");
    await expect(response.text()).resolves.toBe("");
  });

  it("rejects traversal keys before touching storage", async () => {
    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/../secret",
    );

    const response = await GET(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["..", "secret"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected invalid key response");
    expect(response.status).toBe(400);
    expect(mocks.getWorkflowStorageObject).not.toHaveBeenCalled();
  });

  it("rejects keys that are not part of the assignment payload", async () => {
    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/other.tar.gz",
    );

    const response = await GET(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["other.tar.gz"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected forbidden key response");
    expect(response.status).toBe(404);
    expect(mocks.getWorkflowStorageObject).not.toHaveBeenCalled();
  });

  it("rejects assignments owned by a different worker", async () => {
    mocks.getWorkerStorageAssignment.mockResolvedValueOnce(null);
    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/code.tar.gz",
    );

    const response = await GET(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["code.tar.gz"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected missing assignment response");
    expect(response.status).toBe(404);
    expect(mocks.getWorkflowStorageObject).not.toHaveBeenCalled();
  });

  it("rejects terminal assignments", async () => {
    mocks.getWorkerStorageAssignment.mockResolvedValueOnce(inlineAssignment({ assignment: { status: "completed" } }));
    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/code.tar.gz",
    );

    const response = await GET(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["code.tar.gz"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected terminal assignment response");
    expect(response.status).toBe(404);
    expect(mocks.getWorkflowStorageObject).not.toHaveBeenCalled();
  });

  it("maps worker auth failures without touching assignment storage", async () => {
    mocks.requireWorkerAuth.mockRejectedValueOnce(new WorkerAuthError("Unauthorized", 401));
    const request = new NextRequest(
      "https://agentrelay.com/api/v1/workers/wrk_1/assignments/run_1/storage/code.tar.gz",
    );

    const response = await GET(request, {
      params: Promise.resolve({ workerId: "wrk_1", runId: "run_1", objectKey: ["code.tar.gz"] }),
    });

    expect(response).toBeDefined();
    if (!response) throw new Error("Expected unauthorized response");
    expect(response.status).toBe(401);
    expect(mocks.getWorkerStorageAssignment).not.toHaveBeenCalled();
    expect(mocks.getWorkflowStorageObject).not.toHaveBeenCalled();
  });
});
