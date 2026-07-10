import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const findActiveJobMock = vi.hoisted(() => vi.fn());
const createJobMock = vi.hoisted(() => vi.fn());
const enqueueJobMock = vi.hoisted(() => vi.fn());
const auditEnqueuedMock = vi.hoisted(() => vi.fn());
const auditFailedMock = vi.hoisted(() => vi.fn());

vi.mock("@cloud/core/clone/github-clone-job-store.js", () => ({
  findActiveGithubCloneJob: findActiveJobMock,
  createGithubCloneJob: createJobMock,
}));

vi.mock("@/lib/integrations/github-clone-durable-queue", () => ({
  enqueueGithubCloneJob: enqueueJobMock,
}));

vi.mock("@/lib/integrations/github-clone-audit", () => ({
  auditGithubCloneEnqueued: auditEnqueuedMock,
  auditGithubCloneFailed: auditFailedMock,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: vi.fn().mockResolvedValue(undefined),
    warn: vi.fn().mockResolvedValue(undefined),
    error: vi.fn().mockResolvedValue(undefined),
    debug: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  enqueueIncrementalCloneJob,
  readPriorCloneManifest,
} from "../packages/web/lib/integrations/github-incremental-sync-trigger";

beforeEach(() => {
  vi.clearAllMocks();
  findActiveJobMock.mockResolvedValue(null);
  createJobMock.mockImplementation(async (request) => ({
    id: "job-incr-1",
    workspaceId: request.workspaceId,
    owner: request.owner,
    repo: request.repo,
    ref: request.ref,
    connectionId: request.connectionId,
    mode: request.mode ?? "full",
    status: "queued",
    attempts: 0,
    filesWritten: null,
    headSha: null,
    baseSha: request.baseSha ?? null,
    durationMs: null,
    lastError: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  enqueueJobMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readPriorCloneManifest", () => {
  test("returns the head sha from the .relayfile/clone.json sentinel", async () => {
    const relayfile = {
      readFile: vi.fn().mockImplementation(async (_workspaceId, path) => {
        if (path.endsWith("/.relayfile/clone.json")) {
          return {
            revision: "rev-1",
            content: JSON.stringify({
              jobId: "prior-job",
              defaultBranch: "main",
              headSha: "abc123",
              clonedAt: "2026-01-01T00:00:00Z",
            }),
          };
        }
        const err = new Error("not found");
        Object.assign(err, { status: 404 });
        throw err;
      }),
    } as never;

    const result = await readPriorCloneManifest(relayfile, "ws-1", "octo", "hello-world");

    expect(result).toEqual({
      headSha: "abc123",
      defaultBranch: "main",
      source: "sentinel",
    });
  });

  test("falls back to legacy meta.json when sentinel is missing", async () => {
    const relayfile = {
      readFile: vi.fn().mockImplementation(async (_workspaceId, path) => {
        if (path.endsWith("/meta.json")) {
          return {
            revision: "rev-meta",
            content: JSON.stringify({ defaultBranch: "main", headSha: "legacy-sha" }),
          };
        }
        const err = new Error("not found");
        Object.assign(err, { status: 404 });
        throw err;
      }),
    } as never;

    const result = await readPriorCloneManifest(relayfile, "ws-1", "octo", "hello-world");

    expect(result).toEqual({
      headSha: "legacy-sha",
      defaultBranch: "main",
      source: "meta",
    });
  });

  test("returns null when neither sentinel nor meta exists", async () => {
    const relayfile = {
      readFile: vi.fn().mockImplementation(async () => {
        const err = new Error("not found");
        Object.assign(err, { status: 404 });
        throw err;
      }),
    } as never;

    const result = await readPriorCloneManifest(relayfile, "ws-1", "octo", "hello-world");
    expect(result).toBeNull();
  });
});

describe("enqueueIncrementalCloneJob", () => {
  const baseInput = {
    workspaceId: "ws-1",
    owner: "octo",
    repo: "hello-world",
    ref: "main",
    connectionId: "conn-1",
    baseSha: "abc123",
    deliveryId: "delivery-7",
  };

  test("creates and enqueues a job with mode=incremental + baseSha", async () => {
    const result = await enqueueIncrementalCloneJob(baseInput);

    expect(result).toEqual({ ok: true, jobId: "job-incr-1" });
    expect(createJobMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        owner: "octo",
        repo: "hello-world",
        ref: "main",
        connectionId: "conn-1",
        mode: "incremental",
        baseSha: "abc123",
      }),
    );
    expect(enqueueJobMock).toHaveBeenCalledWith({
      jobId: "job-incr-1",
      request: expect.objectContaining({
        mode: "incremental",
        baseSha: "abc123",
      }),
    });
    expect(auditEnqueuedMock).toHaveBeenCalled();
  });

  test("dedupes against an existing active job for the same dedupe key", async () => {
    findActiveJobMock.mockResolvedValueOnce({
      id: "existing-job",
      status: "queued",
    });

    const result = await enqueueIncrementalCloneJob(baseInput);

    expect(result).toEqual({ ok: true, deduped: true, jobId: "existing-job" });
    expect(createJobMock).not.toHaveBeenCalled();
    expect(enqueueJobMock).not.toHaveBeenCalled();
  });

  test("returns failure when enqueue throws and audits the failure", async () => {
    enqueueJobMock.mockRejectedValueOnce(new Error("SQS down"));

    const result = await enqueueIncrementalCloneJob(baseInput);

    expect(result).toEqual({ ok: false, error: "SQS down" });
    expect(auditFailedMock).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed" }),
      "SQS down",
      expect.objectContaining({ mode: "incremental" }),
    );
  });
});
