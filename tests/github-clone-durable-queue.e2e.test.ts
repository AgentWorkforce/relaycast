import { beforeEach, describe, expect, test, vi } from "vitest";

const e2eState = vi.hoisted(() => ({
  jobs: new Map<string, Record<string, unknown>>(),
  payloads: [] as Array<Record<string, unknown>>,
  now: new Date("2026-01-01T12:00:00.000Z"),
}));

function cloneJob(job: Record<string, unknown>) {
  return {
    ...job,
    createdAt: job.createdAt instanceof Date ? new Date(job.createdAt) : job.createdAt,
    updatedAt: job.updatedAt instanceof Date ? new Date(job.updatedAt) : job.updatedAt,
    startedAt: job.startedAt instanceof Date ? new Date(job.startedAt) : job.startedAt,
    completedAt:
      job.completedAt instanceof Date ? new Date(job.completedAt) : job.completedAt,
  };
}

vi.mock("next/server", () => ({
  NextResponse: {
    json(body: unknown, init?: ResponseInit) {
      return Response.json(body, init);
    },
  },
}));

const jobStoreMockModule = vi.hoisted(() => ({
  async createGithubCloneJob(request: {
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
    connectionId: string;
    mode?: string;
    baseSha?: string | null;
  }) {
    const id = `job-${e2eState.jobs.size + 1}`;
    const now = new Date(e2eState.now);
    const job = {
      id,
      ...request,
      // mode/baseSha mirror the production schema (added in 0023). The e2e
      // path here exercises a full clone, so we stamp them with the same
      // defaults the real job-store does.
      mode: request.mode ?? "full",
      status: "queued",
      attempts: 0,
      filesWritten: null,
      headSha: null,
      baseSha: request.baseSha ?? null,
      durationMs: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    e2eState.jobs.set(id, job);
    return cloneJob(job);
  },
  async findActiveGithubCloneJob(key: {
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
  }) {
    const cutoff = e2eState.now.getTime() - 30 * 60 * 1000;
    const activeJobs = [...e2eState.jobs.values()]
      .filter((job) => {
        const createdAt = job.createdAt as Date;
        return (
          job.workspaceId === key.workspaceId &&
          job.owner === key.owner &&
          job.repo === key.repo &&
          job.ref === key.ref &&
          (job.status === "queued" || job.status === "running") &&
          createdAt.getTime() >= cutoff
        );
      })
      .sort(
        (left, right) =>
          (right.createdAt as Date).getTime() - (left.createdAt as Date).getTime(),
      );

    return activeJobs[0] ? cloneJob(activeJobs[0]) : null;
  },
  async getGithubCloneJob(jobId: string) {
    const job = e2eState.jobs.get(jobId);
    return job ? cloneJob(job) : null;
  },
  async markGithubCloneJobRunning(_db: unknown, jobId: string) {
    const job = e2eState.jobs.get(jobId);
    if (!job) {
      return;
    }

    const now = new Date(e2eState.now);
    job.status = "running";
    job.attempts = Number(job.attempts ?? 0) + 1;
    job.startedAt = now;
    job.updatedAt = now;
  },
  async markGithubCloneJobCompleted(
    _db: unknown,
    jobId: string,
    result: {
      filesWritten?: number | null;
      headSha?: string | null;
      durationMs?: number | null;
      completedAt?: Date;
    },
  ) {
    const job = e2eState.jobs.get(jobId);
    if (!job) {
      return;
    }

    const completedAt = result.completedAt ?? new Date(e2eState.now);
    job.status = "completed";
    job.filesWritten = result.filesWritten ?? null;
    job.headSha = result.headSha ?? null;
    job.durationMs = result.durationMs ?? null;
    job.lastError = null;
    job.completedAt = completedAt;
    job.updatedAt = completedAt;
  },
  async markGithubCloneJobFailed(_db: unknown, jobId: string, error: string) {
    const job = e2eState.jobs.get(jobId);
    if (!job) {
      return;
    }

    const completedAt = new Date(e2eState.now);
    job.status = "failed";
    job.lastError = error;
    job.completedAt = completedAt;
    job.updatedAt = completedAt;
  },
}));

vi.mock("@cloud/core/clone/github-clone-job-store.js", () => jobStoreMockModule);
vi.mock("../packages/core/src/clone/github-clone-job-store", () => jobStoreMockModule);

vi.mock("../packages/web/lib/integrations/github-clone-durable-queue", () => ({
  async enqueueGithubCloneJob(payload: Record<string, unknown>) {
    e2eState.payloads.push(payload);
  },
}));

vi.mock("../packages/web/lib/integrations/github-clone-audit", () => ({
  auditGithubCloneEnqueued: vi.fn(),
  auditGithubCloneFailed: vi.fn(),
}));

import { processGithubCloneQueueRecord } from "../packages/core/src/clone/github-clone-worker";
import { POST } from "../packages/web/app/api/v1/github/clone/request/route";
import { GET } from "../packages/web/app/api/v1/github/clone/status/[jobId]/route";

describe("github clone durable queue e2e", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    e2eState.jobs.clear();
    e2eState.payloads.length = 0;
    e2eState.now = new Date("2026-01-01T12:00:00.000Z");
    process.env.USE_DURABLE_CLONE_QUEUE = "true";
    process.env.SageCloudApiToken = "sage-token";
    process.env.SpecialistCloudApiToken = "specialist-token";
  });

  test("posts a request, captures SQS payload, runs the worker, polls status, and exposes completion", async () => {
    const requestBody = {
      workspaceId: "ws-1",
      owner: "octo",
      repo: "hello-world",
      ref: "main",
      connectionId: "conn-1",
    };

    const requestResponse = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { SageCloudApiToken: "sage-token" },
        body: JSON.stringify(requestBody),
      }),
    );

    expect(requestResponse.status).toBe(202);
    const accepted = await requestResponse.json();
    expect(accepted).toEqual({
      ok: true,
      jobId: "job-1",
      status: "queued",
    });
    expect(e2eState.payloads).toEqual([
      {
        jobId: "job-1",
        request: requestBody,
      },
    ]);

    const queuedStatus = await GET(
      new Request("http://localhost/api/v1/github/clone/status/job-1", {
        headers: { SpecialistCloudApiToken: "specialist-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    await expect(queuedStatus.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-1",
      status: "queued",
      attempts: 0,
      lastError: null,
      completedAt: null,
    });

    await processGithubCloneQueueRecord(
      {
        body: JSON.stringify(e2eState.payloads[0]),
      },
      {
        db: { name: "db" },
        executeGithubClone: vi.fn().mockResolvedValue({
          filesWritten: 4,
          headSha: "relayfile-visible-sha",
          durationMs: 99,
          completedAt: new Date("2026-01-01T12:05:00.000Z"),
        }),
      },
    );

    let finalStatus: Record<string, unknown> | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await GET(
        new Request("http://localhost/api/v1/github/clone/status/job-1", {
          headers: { SageCloudApiToken: "sage-token" },
        }),
        { params: { jobId: "job-1" } },
      );
      finalStatus = await response.json();
      if (finalStatus?.status === "completed") {
        break;
      }
    }

    expect(finalStatus).toEqual({
      ok: true,
      jobId: "job-1",
      status: "completed",
      attempts: 1,
      lastError: null,
      completedAt: "2026-01-01T12:05:00.000Z",
      job: {
        id: "job-1",
        jobId: "job-1",
        workspaceId: "ws-1",
        owner: "octo",
        repo: "hello-world",
        ref: "main",
        connectionId: "conn-1",
        status: "completed",
        // mode/baseSha added in 0023_github_clone_jobs_incremental. This e2e
        // covers the full-clone path, so they take their defaults.
        mode: "full",
        attempts: 1,
        filesWritten: 4,
        headSha: "relayfile-visible-sha",
        baseSha: null,
        durationMs: 99,
        lastError: null,
        createdAt: "2026-01-01T12:00:00.000Z",
        updatedAt: "2026-01-01T12:05:00.000Z",
        startedAt: "2026-01-01T12:00:00.000Z",
        completedAt: "2026-01-01T12:05:00.000Z",
      },
    });
  });
});
