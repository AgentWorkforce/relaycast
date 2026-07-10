import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

import {
  createGithubCloneJob,
  findActiveGithubCloneJob,
  markGithubCloneJobCompleted,
  markGithubCloneJobFailed,
  markGithubCloneJobRunning,
  markGithubCloneJobRetrying,
} from "../packages/core/src/clone/github-clone-job-store";
import {
  GITHUB_CLONE_JOB_DEDUPE_TTL_MS,
  type GithubCloneJobRequest,
} from "../packages/core/src/clone/github-clone-job";
import {
  createGithubCloneTestDb,
  type GithubCloneTestDb,
} from "./helpers/github-clone-db";

vi.mock("../packages/core/src/db", () => ({
  getDb: vi.fn(() => {
    throw new Error("Tests should pass the database explicitly");
  }),
}));

describe("github clone job store", () => {
  let testDb: GithubCloneTestDb;

  const request: GithubCloneJobRequest = {
    workspaceId: "ws-1",
    owner: "octo",
    repo: "hello-world",
    ref: "main",
    connectionId: "conn-1",
  };

  beforeEach(async () => {
    testDb = await createGithubCloneTestDb();
  });

  afterEach(async () => {
    await testDb.close();
  });

  test("creates queued rows and dedupes only queued or running rows within 30 minutes", async () => {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - GITHUB_CLONE_JOB_DEDUPE_TTL_MS - 1_000);

    await testDb.insertJob({
      ...request,
      status: "completed",
      attempts: 1,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insertJob({
      ...request,
      status: "failed",
      attempts: 1,
      lastError: "boom",
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await testDb.insertJob({
      ...request,
      status: "queued",
      createdAt: expiredAt,
      updatedAt: expiredAt,
    });
    await testDb.insertJob({
      ...request,
      status: "running",
      attempts: 2,
      startedAt: expiredAt,
      createdAt: expiredAt,
      updatedAt: expiredAt,
    });

    await expect(
      findActiveGithubCloneJob(testDb.db, {
        workspaceId: request.workspaceId,
        owner: request.owner,
        repo: request.repo,
        ref: request.ref,
      }),
    ).resolves.toBeNull();

    const created = await createGithubCloneJob(testDb.db, request);
    expect(created).toMatchObject({
      workspaceId: request.workspaceId,
      owner: request.owner,
      repo: request.repo,
      ref: request.ref,
      connectionId: request.connectionId,
      status: "queued",
      attempts: 0,
    });
    await markGithubCloneJobCompleted(testDb.db, created.id, {
      filesWritten: 1,
      headSha: "created-job-terminal",
      durationMs: 1,
      completedAt: now,
    });

    const queued = await testDb.insertJob({
      ...request,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });

    await expect(
      findActiveGithubCloneJob(testDb.db, {
        workspaceId: request.workspaceId,
        owner: request.owner,
        repo: request.repo,
        ref: request.ref,
      }),
    ).resolves.toMatchObject({
      id: queued.id,
      status: "queued",
    });
    await markGithubCloneJobCompleted(testDb.db, queued.id, {
      filesWritten: 1,
      headSha: "queued-job-terminal",
      durationMs: 1,
      completedAt: now,
    });

    const running = await testDb.insertJob({
      ...request,
      status: "running",
      attempts: 1,
      startedAt: new Date(now.getTime() - 5_000),
      createdAt: new Date(now.getTime() - 1_000),
      updatedAt: new Date(now.getTime() - 1_000),
    });

    await expect(
      findActiveGithubCloneJob(testDb.db, {
        workspaceId: request.workspaceId,
        owner: request.owner,
        repo: request.repo,
        ref: request.ref,
      }),
    ).resolves.toMatchObject({
      id: running.id,
      status: "running",
    });
  });

  test("markRunning increments attempts and sets startedAt", async () => {
    const job = await createGithubCloneJob(testDb.db, request);

    await markGithubCloneJobRunning(testDb.db, job.id);
    await markGithubCloneJobRunning(testDb.db, job.id);

    const updated = await testDb.getJob(job.id);

    expect(updated).toMatchObject({
      id: job.id,
      status: "running",
      attempts: 2,
    });
    expect(updated?.startedAt).toBeInstanceOf(Date);
    expect(updated?.updatedAt).toBeInstanceOf(Date);
  });

  test("markCompleted sets terminal completion fields", async () => {
    const job = await createGithubCloneJob(testDb.db, request);
    const completedAt = new Date("2026-01-01T12:05:00.000Z");

    await markGithubCloneJobCompleted(testDb.db, job.id, {
      filesWritten: 7,
      headSha: "abc123",
      durationMs: 4200,
      completedAt,
    });

    await expect(testDb.getJob(job.id)).resolves.toMatchObject({
      id: job.id,
      status: "completed",
      filesWritten: 7,
      headSha: "abc123",
      durationMs: 4200,
      lastError: null,
      completedAt,
      updatedAt: completedAt,
    });
  });

  test("markFailed sets terminal failure fields", async () => {
    const job = await createGithubCloneJob(testDb.db, request);

    await markGithubCloneJobFailed(testDb.db, job.id, "GitHub returned 500");

    const failed = await testDb.getJob(job.id);

    expect(failed).toMatchObject({
      id: job.id,
      status: "failed",
      lastError: "GitHub returned 500",
    });
    expect(failed?.completedAt).toBeInstanceOf(Date);
    expect(failed?.updatedAt).toBeInstanceOf(Date);
  });

  test("markRetrying preserves active status and records the last retryable error", async () => {
    const job = await createGithubCloneJob(testDb.db, request);
    await markGithubCloneJobRunning(testDb.db, job.id);

    await markGithubCloneJobRetrying(
      testDb.db,
      job.id,
      "relayfile_tar_import_fetch_failed: fetch failed",
    );

    await expect(testDb.getJob(job.id)).resolves.toMatchObject({
      id: job.id,
      status: "running",
      attempts: 1,
      lastError: "relayfile_tar_import_fetch_failed: fetch failed",
      completedAt: null,
    });
  });
});
