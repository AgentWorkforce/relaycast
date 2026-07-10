import { setTimeout as delay } from "node:timers/promises";
import { describe, it, expect, vi } from "vitest";
import { CloneQueue } from "../packages/web/lib/integrations/github-clone-queue.js";
import type { CloneOutcome } from "../packages/web/lib/integrations/github-clone-orchestrator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutcome(overrides: Partial<CloneOutcome> = {}): CloneOutcome {
  return {
    filesWritten: 10,
    headSha: "abc123",
    defaultBranch: "main",
    durationMs: 42,
    skipped: [],
    errors: [],
    ...overrides,
  };
}

function makeRequest(overrides: {
  workspaceId?: string;
  owner?: string;
  repo?: string;
  ref?: string;
} = {}) {
  return {
    workspaceId: overrides.workspaceId ?? "ws-1",
    owner: overrides.owner ?? "acme",
    repo: overrides.repo ?? "app",
    ref: overrides.ref ?? "main",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CloneQueue", () => {
  it("enqueue starts a job and runs it", async () => {
    const queue = new CloneQueue({ maxConcurrent: 1 });
    const outcome = makeOutcome();
    const executeFn = vi.fn(
      () => delay(50).then(() => outcome),
    );

    const job = queue.enqueue(makeRequest(), executeFn);

    expect(job.status === "queued" || job.status === "running").toBe(true);

    // Wait for the job to finish.
    await vi.waitFor(
      () => {
        const j = queue.getJob(job.id);
        expect(j).toBeDefined();
        expect(j!.status).toBe("completed");
      },
      { timeout: 2000, interval: 10 },
    );

    const completed = queue.getJob(job.id)!;
    expect(completed.status).toBe("completed");
    expect(completed.result).toEqual(outcome);
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it("enqueue deduplicates identical requests", async () => {
    const queue = new CloneQueue({ maxConcurrent: 1 });
    const outcome = makeOutcome();
    const executeFn = vi.fn(() => delay(50).then(() => outcome));

    const req = makeRequest();
    const job1 = queue.enqueue(req, executeFn);
    const job2 = queue.enqueue(req, executeFn);

    expect(job1.id).toBe(job2.id);

    await vi.waitFor(
      () => {
        const j = queue.getJob(job1.id);
        expect(j).toBeDefined();
        expect(j!.status).toBe("completed");
      },
      { timeout: 2000, interval: 10 },
    );

    // executeFn should only have been called once despite two enqueue calls.
    expect(executeFn).toHaveBeenCalledOnce();
  });

  it("respects maxConcurrent limit", async () => {
    const queue = new CloneQueue({ maxConcurrent: 2, maxPerWorkspace: 4 });

    let peakActive = 0;
    const trackActive = () => {
      const current = queue.activeCount;
      if (current > peakActive) peakActive = current;
    };

    const jobs = Array.from({ length: 4 }, (_, i) =>
      queue.enqueue(
        makeRequest({ repo: `repo-${i}` }),
        () =>
          delay(100).then(() => {
            trackActive();
            return makeOutcome();
          }),
      ),
    );

    // Poll peak while jobs run.
    const poll = async () => {
      for (let i = 0; i < 20; i++) {
        trackActive();
        await delay(25);
      }
    };
    await poll();

    // Wait for all jobs to complete.
    await vi.waitFor(
      () => {
        for (const job of jobs) {
          const j = queue.getJob(job.id);
          expect(j).toBeDefined();
          expect(j!.status).toBe("completed");
        }
      },
      { timeout: 3000, interval: 20 },
    );

    expect(peakActive).toBeLessThanOrEqual(2);
  });

  it("respects per-workspace limit", async () => {
    const queue = new CloneQueue({ maxConcurrent: 3, maxPerWorkspace: 1 });

    // Track per-workspace concurrency.
    const wsRunning = new Map<string, number>();
    let violated = false;

    function makeTrackedExecutor(wsId: string) {
      return async (): Promise<CloneOutcome> => {
        const current = (wsRunning.get(wsId) ?? 0) + 1;
        wsRunning.set(wsId, current);
        if (current > 1) violated = true;
        await delay(80);
        wsRunning.set(wsId, (wsRunning.get(wsId) ?? 1) - 1);
        return makeOutcome();
      };
    }

    // 2 jobs for ws-A (different repos).
    const jobA1 = queue.enqueue(
      makeRequest({ workspaceId: "ws-A", repo: "repo-1" }),
      makeTrackedExecutor("ws-A"),
    );
    const jobA2 = queue.enqueue(
      makeRequest({ workspaceId: "ws-A", repo: "repo-2" }),
      makeTrackedExecutor("ws-A"),
    );

    // 1 job for ws-B — should be able to run in parallel with ws-A.
    const jobB1 = queue.enqueue(
      makeRequest({ workspaceId: "ws-B", repo: "repo-3" }),
      makeTrackedExecutor("ws-B"),
    );

    await vi.waitFor(
      () => {
        for (const j of [jobA1, jobA2, jobB1]) {
          const job = queue.getJob(j.id);
          expect(job).toBeDefined();
          expect(job!.status).toBe("completed");
        }
      },
      { timeout: 3000, interval: 20 },
    );

    // ws-A should never have had more than 1 running at a time.
    expect(violated).toBe(false);
  });

  it("partial failure is tracked when outcome has errors", async () => {
    const queue = new CloneQueue({ maxConcurrent: 1 });
    const outcome = makeOutcome({
      errors: [{ path: "src/index.ts", code: "WRITE_ERROR", message: "disk full" }],
    });

    const job = queue.enqueue(makeRequest(), async () => outcome);

    await vi.waitFor(
      () => {
        const j = queue.getJob(job.id);
        expect(j).toBeDefined();
        expect(j!.status).toBe("partial_failure");
      },
      { timeout: 2000, interval: 10 },
    );

    const partial = queue.getJob(job.id)!;
    expect(partial.status).toBe("partial_failure");
    expect(partial.result).toBeDefined();
    expect(partial.result!.filesWritten).toBe(10);
    expect(partial.result!.errors).toHaveLength(1);
  });

  it("failed jobs are tracked", async () => {
    const queue = new CloneQueue({ maxConcurrent: 1 });

    const job = queue.enqueue(makeRequest(), async () => {
      throw new Error("disk full");
    });

    await vi.waitFor(
      () => {
        const j = queue.getJob(job.id);
        expect(j).toBeDefined();
        expect(j!.status).toBe("failed");
      },
      { timeout: 2000, interval: 10 },
    );

    const failed = queue.getJob(job.id)!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe("disk full");
  });

  it("expired jobs are cleaned up", async () => {
    const queue = new CloneQueue({ maxConcurrent: 1, jobTtlMs: 50 });

    const job = queue.enqueue(makeRequest(), async () => makeOutcome());

    await vi.waitFor(
      () => {
        const j = queue.getJob(job.id);
        expect(j).toBeDefined();
        expect(j!.status).toBe("completed");
      },
      { timeout: 2000, interval: 10 },
    );

    // Wait for the TTL to expire.
    await delay(60);

    // getJob should return undefined after expiry.
    const expired = queue.getJob(job.id);
    expect(expired).toBeUndefined();
  });

  it("getWorkspaceJobs returns all jobs for a workspace", async () => {
    const queue = new CloneQueue({ maxConcurrent: 4, maxPerWorkspace: 4 });

    // 2 jobs for ws-A.
    queue.enqueue(
      makeRequest({ workspaceId: "ws-A", repo: "repo-1" }),
      async () => makeOutcome(),
    );
    queue.enqueue(
      makeRequest({ workspaceId: "ws-A", repo: "repo-2" }),
      async () => makeOutcome(),
    );

    // 1 job for ws-B.
    queue.enqueue(
      makeRequest({ workspaceId: "ws-B", repo: "repo-3" }),
      async () => makeOutcome(),
    );

    // Jobs may still be in-flight — check counts regardless of status.
    const wsAJobs = queue.getWorkspaceJobs("ws-A");
    const wsBJobs = queue.getWorkspaceJobs("ws-B");

    expect(wsAJobs).toHaveLength(2);
    expect(wsBJobs).toHaveLength(1);

    // Verify workspace IDs are correct.
    for (const j of wsAJobs) {
      expect(j.workspaceId).toBe("ws-A");
    }
    for (const j of wsBJobs) {
      expect(j.workspaceId).toBe("ws-B");
    }
  });
});
