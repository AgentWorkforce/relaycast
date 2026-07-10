import { beforeEach, describe, expect, test, vi } from "vitest";

const jobStoreMocks = vi.hoisted(() => ({
  markGithubCloneJobRunning: vi.fn(),
  markGithubCloneJobCompleted: vi.fn(),
  markGithubCloneJobFailed: vi.fn(),
  markGithubCloneJobRetrying: vi.fn(),
}));

vi.mock("../packages/core/src/clone/github-clone-job-store", () => jobStoreMocks);

import { processGithubCloneQueueRecord } from "../packages/core/src/clone/github-clone-worker";

describe("github clone worker", () => {
  const payload = {
    jobId: "job-1",
    request: {
      workspaceId: "ws-1",
      owner: "octo",
      repo: "hello-world",
      ref: "main",
      connectionId: "conn-1",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    jobStoreMocks.markGithubCloneJobRunning.mockResolvedValue(undefined);
    jobStoreMocks.markGithubCloneJobCompleted.mockResolvedValue(undefined);
    jobStoreMocks.markGithubCloneJobFailed.mockResolvedValue(undefined);
    jobStoreMocks.markGithubCloneJobRetrying.mockResolvedValue(undefined);
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

  test("runs clone deps and marks the job completed on success", async () => {
    const db = { name: "db" };
    const executeGithubClone = vi.fn().mockResolvedValue({
      filesWritten: 9,
      headSha: "deadbeef",
      durationMs: 3200,
      completedAt: new Date("2026-01-01T12:03:00.000Z"),
    });

    await processGithubCloneQueueRecord(
      { body: JSON.stringify(payload) },
      {
        db,
        env: {
          EXTRA_FLAG: "1",
          AWS_REGION: "us-west-2",
          NANGO_SECRET_KEY: "secret-key",
          NANGO_BASE_URL: "https://nango.example",
          WEB_RELAYAUTH_API_KEY: "relayauth-key",
        },
        executeGithubClone,
      },
    );

    expect(jobStoreMocks.markGithubCloneJobRunning).toHaveBeenCalledWith(db, "job-1");
    expect(executeGithubClone).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        request: payload.request,
        workspaceId: "ws-1",
        env: expect.objectContaining({
          AWS_REGION: "us-west-2",
          NANGO_SECRET_KEY: "secret-key",
          NANGO_BASE_URL: "https://nango.example",
          WEB_RELAYAUTH_API_KEY: "relayauth-key",
          EXTRA_FLAG: "1",
        }),
      }),
      payload.request,
    );
    expect(jobStoreMocks.markGithubCloneJobCompleted).toHaveBeenCalledWith(db, "job-1", {
      filesWritten: 9,
      headSha: "deadbeef",
      durationMs: 3200,
      completedAt: new Date("2026-01-01T12:03:00.000Z"),
    });
  });

  test("logs start and completion diagnostics without changing worker behavior", async () => {
    const db = { name: "db" };
    const executeGithubClone = vi.fn().mockResolvedValue({
      filesWritten: 42,
      headSha: "abc123",
      durationMs: 10,
      materialization: {
        mode: "local_archive",
        filesExpected: 42,
      },
    });

    const { logs, errors } = await withCapturedConsole(async () => {
      await processGithubCloneQueueRecord(
        {
          body: JSON.stringify(payload),
          attributes: { ApproximateReceiveCount: "2" },
        },
        {
          db,
          executeGithubClone,
        },
      );
    });

    expect(errors).toEqual([]);
    expect(logs).toEqual([
      [
        "[gate-b-resolver-diag] github-clone-worker-start",
        {
          jobId: "job-1",
          status: "running",
          workspaceId: "ws-1",
          mode: "full",
          receiveCount: 2,
        },
      ],
      [
        "[gate-b-resolver-diag] github-clone-worker-completed",
        {
          jobId: "job-1",
          status: "completed",
          workspaceId: "ws-1",
          mode: "full",
          receiveCount: 2,
          filesWritten: 42,
          materializationMode: "local_archive",
        },
      ],
    ]);
    expect(jobStoreMocks.markGithubCloneJobCompleted).toHaveBeenCalledWith(
      db,
      "job-1",
      expect.objectContaining({ filesWritten: 42 }),
    );
  });

  test("logs retryable worker errors before preserving the thrown error", async () => {
    const db = { name: "db" };
    const executeGithubClone = vi.fn().mockRejectedValue(
      new Error("clone worker timeout"),
    );

    const { errors } = await withCapturedConsole(async () => {
      await expect(
        processGithubCloneQueueRecord(
          {
            body: JSON.stringify(payload),
            attributes: { ApproximateReceiveCount: "2" },
          },
          {
            db,
            env: { GITHUB_CLONE_QUEUE_MAX_RECEIVE_COUNT: "3" },
            executeGithubClone,
          },
        ),
      ).rejects.toThrow("clone worker timeout");
    });

    expect(errors).toEqual([
      [
        "[gate-b-resolver-diag] github-clone-worker-error",
        {
          jobId: "job-1",
          status: "retrying",
          workspaceId: "ws-1",
          mode: "full",
          receiveCount: 2,
          terminal: false,
          finalAttempt: false,
        },
      ],
    ]);
  });

  test.each([
    Object.assign(new Error("GitHub unauthorized"), { status: 401 }),
    Object.assign(new Error("Repository missing"), { response: { status: 404 } }),
  ])(
    "marks 401/404 failures terminal without throwing",
    async (error) => {
      const db = { name: "db" };

      await expect(
        processGithubCloneQueueRecord(
          { body: JSON.stringify(payload) },
          {
            db,
            executeGithubClone: vi.fn().mockRejectedValue(error),
          },
        ),
      ).resolves.toBeUndefined();

      expect(jobStoreMocks.markGithubCloneJobFailed).toHaveBeenCalledWith(
        db,
        "job-1",
        error.message,
      );
    },
  );

  test("keeps retryable failures running so status polling waits for SQS redelivery", async () => {
    const error = Object.assign(new Error("upstream timeout"), { status: 503 });
    const db = { name: "db" };

    await expect(
      processGithubCloneQueueRecord(
        {
          body: JSON.stringify(payload),
          attributes: { ApproximateReceiveCount: "1" },
        },
        {
          db,
          env: { GITHUB_CLONE_QUEUE_MAX_RECEIVE_COUNT: "3" },
          executeGithubClone: vi.fn().mockRejectedValue(error),
        },
      ),
    ).rejects.toThrow("upstream timeout");

    expect(jobStoreMocks.markGithubCloneJobRetrying).toHaveBeenCalledWith(
      db,
      "job-1",
      "upstream timeout",
    );
    expect(jobStoreMocks.markGithubCloneJobFailed).not.toHaveBeenCalled();
  });

  test("marks retryable failures terminal on the final queue receive", async () => {
    const error = Object.assign(new Error("upstream timeout"), { status: 503 });
    const db = { name: "db" };

    await expect(
      processGithubCloneQueueRecord(
        {
          body: JSON.stringify(payload),
          attributes: { ApproximateReceiveCount: "3" },
        },
        {
          db,
          env: { GITHUB_CLONE_QUEUE_MAX_RECEIVE_COUNT: "3" },
          executeGithubClone: vi.fn().mockRejectedValue(error),
        },
      ),
    ).rejects.toThrow("upstream timeout");

    expect(jobStoreMocks.markGithubCloneJobFailed).toHaveBeenCalledWith(
      db,
      "job-1",
      "upstream timeout",
    );
    expect(jobStoreMocks.markGithubCloneJobRetrying).not.toHaveBeenCalled();
  });
});
