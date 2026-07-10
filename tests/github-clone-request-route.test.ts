import { beforeEach, describe, expect, test, vi } from "vitest";

const jobStoreMocks = vi.hoisted(() => ({
  createGithubCloneJob: vi.fn(),
  findActiveGithubCloneJob: vi.fn(),
  markGithubCloneJobFailed: vi.fn(),
}));

const queueMocks = vi.hoisted(() => ({
  enqueueGithubCloneJob: vi.fn(),
}));

const auditMocks = vi.hoisted(() => ({
  auditGithubCloneEnqueued: vi.fn(),
  auditGithubCloneFailed: vi.fn(),
}));
const authMocks = vi.hoisted(() => ({
  resolveRequestAuth: vi.fn(),
  requireAuthScope: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
  selectResults: [] as unknown[][],
  select: vi.fn(() => ({
    from: () => ({
      where: () => ({
        orderBy: () => ({
          limit: async () => dbMocks.selectResults.shift() ?? [],
        }),
        limit: async () => dbMocks.selectResults.shift() ?? [],
      }),
    }),
  })),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json(body: unknown, init?: ResponseInit) {
      return Response.json(body, init);
    },
  },
}));

vi.mock("@cloud/core/clone/github-clone-job-store.js", () => jobStoreMocks);
vi.mock(
  "../packages/web/lib/integrations/github-clone-durable-queue",
  () => queueMocks,
);
vi.mock(
  "../packages/web/lib/integrations/github-clone-audit",
  () => auditMocks,
);
vi.mock("../packages/web/lib/auth/request-auth", () => authMocks);
vi.mock("../packages/web/lib/db", () => ({
  getDb: () => ({
    select: dbMocks.select,
  }),
}));

import { POST } from "../packages/web/app/api/v1/github/clone/request/route";

describe("github clone request route", () => {
  const body = {
    workspaceId: "ws-1",
    owner: "octo",
    repo: "hello-world",
    ref: "main",
    connectionId: "conn-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.USE_DURABLE_CLONE_QUEUE = "true";
    process.env.SageCloudApiToken = "sage-token";
    process.env.SpecialistCloudApiToken = "specialist-token";
    jobStoreMocks.findActiveGithubCloneJob.mockResolvedValue(null);
    jobStoreMocks.createGithubCloneJob.mockResolvedValue({
      id: "job-1",
      status: "queued",
    });
    queueMocks.enqueueGithubCloneJob.mockResolvedValue(undefined);
    jobStoreMocks.markGithubCloneJobFailed.mockResolvedValue(undefined);
    authMocks.resolveRequestAuth.mockResolvedValue(null);
    authMocks.requireAuthScope.mockReturnValue(false);
    dbMocks.selectResults = [];
  });

  async function withCapturedConsole<T>(fn: () => Promise<T>) {
    const originalLog = console.log;
    const originalError = console.error;
    const logs: unknown[][] = [];
    const errors: unknown[][] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args);
    };
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const result = await fn();
      return { result, logs, errors };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  test.each([
    ["SageCloudApiToken", "sage-token"],
    ["SpecialistCloudApiToken", "specialist-token"],
    ["authorization", "Bearer sage-token"],
  ])("accepts %s authentication", async (headerName, headerValue) => {
    const response = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { [headerName]: headerValue },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      jobId: "job-1",
      status: "queued",
    });
  });

  test("rejects service token headers that do not match configured tokens", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { SageCloudApiToken: "wrong-token" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(401);
    expect(jobStoreMocks.createGithubCloneJob).not.toHaveBeenCalled();
    expect(queueMocks.enqueueGithubCloneJob).not.toHaveBeenCalled();
  });

  test("accepts workflow caller auth scoped to the requested workspace", async () => {
    delete process.env.SageCloudApiToken;
    delete process.env.SpecialistCloudApiToken;
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      source: "token",
      scopes: ["workflow:invoke:write"],
    });
    authMocks.requireAuthScope.mockReturnValue(true);

    const response = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { authorization: "Bearer workflow-token" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(202);
    expect(authMocks.requireAuthScope).toHaveBeenCalledWith(
      expect.objectContaining({ source: "token" }),
      "workflow:invoke:write",
    );
    expect(jobStoreMocks.createGithubCloneJob).toHaveBeenCalledWith(body);
  });

  test("normalizes relay workspace ids before resolving the GitHub integration", async () => {
    delete process.env.SageCloudApiToken;
    delete process.env.SpecialistCloudApiToken;
    const appWorkspaceId = "50587328-441d-4acb-b8f3-dbe1b3c5de99";
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: "rw_boundws01",
      organizationId: "org-1",
      source: "relayfile",
      relayfileSponsorId: "agent-1",
      scopes: ["workflow:invoke:write"],
    });
    authMocks.requireAuthScope.mockReturnValue(true);
    dbMocks.selectResults = [
      [{ appWorkspaceId, organizationId: "org-1" }],
      [{ connectionId: "conn-from-app-workspace" }],
    ];

    const response = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { authorization: "Bearer workflow-token" },
        body: JSON.stringify({
          workspaceId: "rw_boundws01",
          owner: "octo",
          repo: "hello-world",
          ref: "main",
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(jobStoreMocks.createGithubCloneJob).toHaveBeenCalledWith({
      workspaceId: appWorkspaceId,
      owner: "octo",
      repo: "hello-world",
      ref: "main",
      connectionId: "conn-from-app-workspace",
    });
    expect(queueMocks.enqueueGithubCloneJob).toHaveBeenCalledWith({
      jobId: "job-1",
      request: {
        workspaceId: appWorkspaceId,
        owner: "octo",
        repo: "hello-world",
        ref: "main",
        connectionId: "conn-from-app-workspace",
      },
    });
    expect(dbMocks.selectResults).toEqual([]);
  });

  test("uses the newest github-family integration when resolving a missing connectionId", async () => {
    dbMocks.selectResults = [[{ connectionId: "conn-live-github-relay" }]];

    const response = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { SageCloudApiToken: "sage-token" },
        body: JSON.stringify({
          workspaceId: "ws-1",
          owner: "octo",
          repo: "hello-world",
          ref: "HEAD",
        }),
      }),
    );

    expect(response.status).toBe(202);
    expect(jobStoreMocks.createGithubCloneJob).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      owner: "octo",
      repo: "hello-world",
      ref: "HEAD",
      connectionId: "conn-live-github-relay",
    });
  });

  test("returns the existing job when a matching queued or running row dedupes", async () => {
    jobStoreMocks.findActiveGithubCloneJob.mockResolvedValue({
      id: "job-existing",
      status: "running",
    });

    const response = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { SageCloudApiToken: "sage-token" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      jobId: "job-existing",
      status: "running",
    });
    expect(jobStoreMocks.createGithubCloneJob).not.toHaveBeenCalled();
    expect(queueMocks.enqueueGithubCloneJob).not.toHaveBeenCalled();
  });

  test("creates the durable row before sending the SQS message", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { SageCloudApiToken: "sage-token" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(202);
    expect(jobStoreMocks.createGithubCloneJob).toHaveBeenCalledWith(body);
    expect(queueMocks.enqueueGithubCloneJob).toHaveBeenCalledWith({
      jobId: "job-1",
      request: body,
    });
    expect(
      jobStoreMocks.createGithubCloneJob.mock.invocationCallOrder[0],
    ).toBeLessThan(
      queueMocks.enqueueGithubCloneJob.mock.invocationCallOrder[0],
    );
  });

  test("logs the durable clone request boundary without exposing credentials", async () => {
    authMocks.resolveRequestAuth.mockResolvedValue({
      userId: "user-1",
      workspaceId: "ws-1",
      organizationId: "org-1",
      source: "token",
      scopes: ["workflow:invoke:write"],
      runId: "run-1",
    });
    authMocks.requireAuthScope.mockReturnValue(true);

    const {
      result: response,
      logs,
      errors,
    } = await withCapturedConsole(() =>
      POST(
        new Request("http://localhost/api/v1/github/clone/request", {
          method: "POST",
          headers: { authorization: "Bearer workflow-token" },
          body: JSON.stringify(body),
        }),
      ),
    );

    expect(response.status).toBe(202);
    expect(errors).toEqual([]);
    expect(logs).toEqual([
      [
        "[gate-b-resolver-diag] github-clone-job-created",
        expect.objectContaining({
          runId: "run-1",
          jobId: "job-1",
          status: "queued",
          workspaceId: "ws-1",
          mode: "full",
        }),
      ],
      [
        "[gate-b-resolver-diag] github-clone-job-enqueued",
        expect.objectContaining({
          runId: "run-1",
          jobId: "job-1",
          status: "queued",
          workspaceId: "ws-1",
          mode: "full",
        }),
      ],
    ]);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("workflow-token");
  });

  test("marks the job failed and returns 500 when enqueueing to SQS fails", async () => {
    queueMocks.enqueueGithubCloneJob.mockRejectedValue(
      new Error("SQS unavailable"),
    );

    const response = await POST(
      new Request("http://localhost/api/v1/github/clone/request", {
        method: "POST",
        headers: { SpecialistCloudApiToken: "specialist-token" },
        body: JSON.stringify(body),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "SQS unavailable",
    });
    expect(jobStoreMocks.markGithubCloneJobFailed).toHaveBeenCalledWith(
      "job-1",
      "SQS unavailable",
    );
  });
});
