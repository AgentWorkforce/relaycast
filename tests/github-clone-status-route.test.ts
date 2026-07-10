import { beforeEach, describe, expect, test, vi } from "vitest";

const jobStoreMocks = vi.hoisted(() => ({
  getGithubCloneJob: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
}));
const relayWorkspaceMocks = vi.hoisted(() => ({
  normalizeRelayWorkspaceIdToAppWorkspaceId: vi.fn(),
  readBoundRelayWorkspaceId: vi.fn(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body: unknown, init?: ResponseInit) {
      return Response.json(body, init);
    },
  },
}));

vi.mock("@cloud/core/clone/github-clone-job-store.js", () => jobStoreMocks);
vi.mock("../packages/web/lib/auth/request-auth", () => authMocks);
vi.mock(
  "../packages/web/lib/workspaces/relay-workspace-binding",
  () => relayWorkspaceMocks,
);

import { GET } from "../packages/web/app/api/v1/github/clone/status/[jobId]/route";

describe("github clone status route", () => {
  const completedAt = new Date("2026-01-01T12:10:00.000Z");
  const failedJob = {
    id: "job-1",
    workspaceId: "ws-1",
    owner: "octo",
    repo: "hello-world",
    ref: "main",
    connectionId: "conn-1",
    status: "failed",
    attempts: 2,
    filesWritten: 0,
    headSha: null,
    durationMs: 2500,
    lastError: "temporary GitHub outage",
    createdAt: new Date("2026-01-01T12:00:00.000Z"),
    updatedAt: completedAt,
    startedAt: new Date("2026-01-01T12:09:00.000Z"),
    completedAt,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.USE_DURABLE_CLONE_QUEUE = "true";
    process.env.SageCloudApiToken = "sage-token";
    process.env.SpecialistCloudApiToken = "specialist-token";
    authMocks.resolveRequestAuth.mockResolvedValue(null);
    authMocks.requireAuthScope.mockReturnValue(false);
    relayWorkspaceMocks.normalizeRelayWorkspaceIdToAppWorkspaceId.mockImplementation(
      async (workspaceId: string) => workspaceId,
    );
    relayWorkspaceMocks.readBoundRelayWorkspaceId.mockResolvedValue(null);
  });

  test("returns durable status details including attempts, lastError, and completedAt", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue(failedJob);

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/status/job-1", {
        headers: { SageCloudApiToken: "sage-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      jobId: "job-1",
      status: "failed",
      attempts: 2,
      lastError: "temporary GitHub outage",
      completedAt: "2026-01-01T12:10:00.000Z",
      job: {
        id: "job-1",
        jobId: "job-1",
        workspaceId: "ws-1",
        owner: "octo",
        repo: "hello-world",
        ref: "main",
        connectionId: "conn-1",
        status: "failed",
        // mode/baseSha were added in 0023_github_clone_jobs_incremental.
        // Status responses default mode='full' when the source row didn't
        // record one (no incremental sync ran for this job).
        mode: "full",
        attempts: 2,
        filesWritten: 0,
        headSha: null,
        baseSha: null,
        durationMs: 2500,
        lastError: "temporary GitHub outage",
        createdAt: "2026-01-01T12:00:00.000Z",
        updatedAt: "2026-01-01T12:10:00.000Z",
        startedAt: "2026-01-01T12:09:00.000Z",
        completedAt: "2026-01-01T12:10:00.000Z",
        materialization: null,
      },
      materialization: null,
    });
  });

  test("returns relayfile export materialization details for completed clone jobs", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue({
      ...failedJob,
      status: "completed",
      filesWritten: 2,
      headSha: "abc123",
      lastError: null,
    });

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/status/job-1", {
        headers: { SageCloudApiToken: "sage-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-1",
      status: "completed",
      materialization: {
        mode: "relayfile_export",
        headSha: "abc123",
        filesExpected: 2,
        sentinelPath: "/github/repos/octo/hello-world/.relayfile/clone.json",
        contentRoot: "/github/repos/octo/hello-world/contents",
        exportParams: {
          format: "tar",
          decode: "github-working-tree",
          gzip: false,
        },
      },
      job: {
        materialization: {
          mode: "relayfile_export",
          headSha: "abc123",
          filesExpected: 2,
          sentinelPath: "/github/repos/octo/hello-world/.relayfile/clone.json",
          contentRoot: "/github/repos/octo/hello-world/contents",
          exportParams: {
            format: "tar",
            decode: "github-working-tree",
            gzip: false,
          },
        },
      },
    });
  });

  test("returns persisted local archive materialization details when present", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue({
      ...failedJob,
      status: "completed",
      filesWritten: null,
      headSha: "abc123",
      materializationJson: {
        mode: "local_archive",
        headSha: "abc123",
        filesExpected: null,
        archiveUrl: "https://cloud.example/api/v1/github/clone/archive/job-1",
        stripComponents: 1,
        expiresAt: "2026-01-01T12:15:00.000Z",
      },
    });

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/status/job-1", {
        headers: { SageCloudApiToken: "sage-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      jobId: "job-1",
      status: "completed",
      materialization: {
        mode: "local_archive",
        headSha: "abc123",
        filesExpected: null,
        archiveUrl: "https://cloud.example/api/v1/github/clone/archive/job-1",
        stripComponents: 1,
        expiresAt: "2026-01-01T12:15:00.000Z",
      },
      job: {
        materialization: {
          mode: "local_archive",
          headSha: "abc123",
        },
      },
    });
  });

  test("returns 404 when the job does not exist", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue(null);

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/status/missing", {
        headers: { SpecialistCloudApiToken: "specialist-token" },
      }),
      { params: { jobId: "missing" } },
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Job not found",
    });
  });

  test("rejects service token headers that do not match configured tokens", async () => {
    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/status/job-1", {
        headers: { SpecialistCloudApiToken: "wrong-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(401);
    expect(jobStoreMocks.getGithubCloneJob).not.toHaveBeenCalled();
  });

  test("accepts workflow-scoped bearer auth for the job workspace", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue(failedJob);
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      source: "token",
      scopes: ["workflow:invoke:write"],
    });
    authMocks.requireAuthScope.mockReturnValue(true);

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/status/job-1", {
        headers: { authorization: "Bearer workflow-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(200);
    expect(authMocks.requireAuthScope).toHaveBeenCalledWith(
      expect.objectContaining({ source: "token" }),
      "workflow:invoke:write",
    );
  });

  test("accepts workflow-scoped bearer auth from the bound Relayfile workspace", async () => {
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    jobStoreMocks.getGithubCloneJob.mockResolvedValue({
      ...failedJob,
      workspaceId: appWorkspaceId,
    });
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: "rw_7ccfea89",
      organizationId: "org-1",
      source: "relayfile",
      scopes: ["workflow:invoke:write"],
    });
    authMocks.requireAuthScope.mockReturnValue(true);
    relayWorkspaceMocks.normalizeRelayWorkspaceIdToAppWorkspaceId.mockResolvedValue(
      appWorkspaceId,
    );

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/status/job-1", {
        headers: { authorization: "Bearer workflow-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(200);
    expect(relayWorkspaceMocks.normalizeRelayWorkspaceIdToAppWorkspaceId)
      .toHaveBeenCalledWith("rw_7ccfea89");
  });

  test("rejects workflow-scoped bearer auth for another workspace", async () => {
    jobStoreMocks.getGithubCloneJob.mockResolvedValue(failedJob);
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: "ws-other",
      organizationId: "org-1",
      source: "token",
      scopes: ["workflow:invoke:write"],
    });
    authMocks.requireAuthScope.mockReturnValue(true);

    const response = await GET(
      new Request("http://localhost/api/v1/github/clone/status/job-1", {
        headers: { authorization: "Bearer workflow-token" },
      }),
      { params: { jobId: "job-1" } },
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "forbidden",
    });
  });
});
