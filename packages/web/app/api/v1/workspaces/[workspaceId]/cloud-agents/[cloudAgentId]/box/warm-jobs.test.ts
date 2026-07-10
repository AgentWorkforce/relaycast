import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import type { AppDb } from "@/lib/db";
import { cloudAgentBoxWarmJobs } from "@/lib/db/schema";
import { createPgliteDb } from "@/test/helpers/pglite-db";

import {
  CLOUD_AGENT_BOX_WARM_STEPS,
  advanceCloudAgentBoxWarmJob,
  claimCloudAgentBoxWarmJob,
  createCloudAgentBoxWarmJob,
  getCloudAgentBoxWarmJob,
  markCloudAgentBoxWarmJobFailed,
  markCloudAgentBoxWarmJobReady,
  warmStepIndex,
} from "./warm-job-store";
import {
  WARM_STEP_EXECUTORS,
  runWarmJobStep,
  type WarmStepContext,
  type WarmStepExecutor,
} from "./warm-step-runner";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
};
const cloudAgentId = "00000000-0000-0000-0000-000000000004";

function createJobInput() {
  return {
    workspaceId: auth.workspaceId,
    cloudAgentId,
    userId: auth.userId,
    organizationId: auth.organizationId,
  };
}

type Pglite = Awaited<ReturnType<typeof createPgliteDb>>;

describe("cloud agent box warm-job store (slice 2, PGlite)", () => {
  let pg: Pglite;
  let db: AppDb;

  beforeEach(async () => {
    pg = await createPgliteDb();
    db = pg.db as unknown as AppDb;
  });

  afterEach(async () => {
    await pg.cleanup();
  });

  it("creates a queued job with no checkpoint", async () => {
    const job = await createCloudAgentBoxWarmJob(db, createJobInput());
    expect(job).toMatchObject({
      status: "queued",
      currentStep: null,
      attemptCount: 0,
      leaseUntil: null,
      cloudAgentId,
      workspaceId: auth.workspaceId,
    });
    expect(job.id).toBeTruthy();
  });

  it("claims the first step, then reports contention while the lease is held", async () => {
    const job = await createCloudAgentBoxWarmJob(db, createJobInput());

    const first = await claimCloudAgentBoxWarmJob(db, job.id, "ensure-sandbox");
    expect(first.outcome).toBe("claimed");
    expect(first.job?.status).toBe("running");
    expect(first.job?.attemptCount).toBe(1);
    expect(first.job?.leaseUntil).not.toBeNull();

    // A second claim of the same (not-yet-completed) step while the lease is
    // live is contended, not a duplicate.
    const second = await claimCloudAgentBoxWarmJob(db, job.id, "ensure-sandbox");
    expect(second.outcome).toBe("contended");
  });

  it("advances the checkpoint and treats a re-claim of a completed step as duplicate (idempotent)", async () => {
    const job = await createCloudAgentBoxWarmJob(db, createJobInput());
    await claimCloudAgentBoxWarmJob(db, job.id, "ensure-sandbox");
    await advanceCloudAgentBoxWarmJob(db, job.id, "ensure-sandbox");

    const advanced = await getCloudAgentBoxWarmJob(db, job.id);
    expect(advanced?.currentStep).toBe("ensure-sandbox");
    expect(advanced?.leaseUntil).toBeNull();

    // Re-delivering the already-completed step is an idempotent duplicate.
    const reclaim = await claimCloudAgentBoxWarmJob(db, job.id, "ensure-sandbox");
    expect(reclaim.outcome).toBe("duplicate");

    // The next step is now claimable.
    const next = await claimCloudAgentBoxWarmJob(db, job.id, "build-env");
    expect(next.outcome).toBe("claimed");
  });

  it("reclaims a job whose lease has expired", async () => {
    const job = await createCloudAgentBoxWarmJob(db, createJobInput());
    await claimCloudAgentBoxWarmJob(db, job.id, "ensure-sandbox");
    // Force the lease into the past.
    await db
      .update(cloudAgentBoxWarmJobs)
      .set({ leaseUntil: new Date(Date.now() - 60_000) })
      .where(eq(cloudAgentBoxWarmJobs.id, job.id));

    const reclaim = await claimCloudAgentBoxWarmJob(db, job.id, "ensure-sandbox");
    expect(reclaim.outcome).toBe("claimed");
    expect(reclaim.job?.attemptCount).toBe(2);
  });

  it("treats claims on a terminal (ready or failed) job as duplicates", async () => {
    const readyJob = await createCloudAgentBoxWarmJob(db, createJobInput());
    await markCloudAgentBoxWarmJobReady(db, readyJob.id, "sbx_ready");
    const onReady = await claimCloudAgentBoxWarmJob(db, readyJob.id, "ensure-sandbox");
    expect(onReady.outcome).toBe("duplicate");
    expect(onReady.job?.status).toBe("ready");

    const failedJob = await createCloudAgentBoxWarmJob(db, createJobInput());
    await markCloudAgentBoxWarmJobFailed(db, failedJob.id, "boom");
    const onFailed = await claimCloudAgentBoxWarmJob(db, failedJob.id, "ensure-sandbox");
    expect(onFailed.outcome).toBe("duplicate");
    expect(onFailed.job?.status).toBe("failed");
    expect(onFailed.job?.lastError).toBe("boom");
  });

  it("returns not_found for an unknown job id", async () => {
    const result = await claimCloudAgentBoxWarmJob(
      db,
      "00000000-0000-0000-0000-0000000000ff",
      "ensure-sandbox",
    );
    expect(result.outcome).toBe("not_found");
  });

  it("orders steps so warmStepIndex is strictly increasing and finalize is last", () => {
    const indices = CLOUD_AGENT_BOX_WARM_STEPS.map((s) => warmStepIndex(s));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(warmStepIndex(null)).toBe(-1);
    expect(CLOUD_AGENT_BOX_WARM_STEPS[CLOUD_AGENT_BOX_WARM_STEPS.length - 1]).toBe("finalize");
  });
});

function makeDeps() {
  return {
    updateSandbox: vi.fn(async () => undefined),
    mountCliCredentials: vi.fn(async () => undefined),
  } as unknown as WarmStepContext["deps"];
}

function makeCtx(overrides: Partial<WarmStepContext> = {}): WarmStepContext {
  return {
    deps: makeDeps(),
    daytona: {} as WarmStepContext["daytona"],
    input: { auth, cloudAgentId, workspaceToken: null } as WarmStepContext["input"],
    credential: {
      id: cloudAgentId,
      authType: "provider_oauth",
      harness: "claude",
    } as WarmStepContext["credential"],
    mountPaths: ["/workspace"],
    relayfileToken: "relay_pa_/workspace",
    apiKey: "api_sbx_1",
    home: "/home/daytona",
    envVars: {},
    credentialSecret: "secret",
    sandbox: { id: "sbx_1" } as WarmStepContext["sandbox"],
    createdSandboxId: null,
    result: null,
    ...overrides,
  };
}

describe("cloud agent box warm step-runner (slice 2, PGlite)", () => {
  let pg: Pglite;
  let db: AppDb;

  beforeEach(async () => {
    pg = await createPgliteDb();
    db = pg.db as unknown as AppDb;
  });

  afterEach(async () => {
    await pg.cleanup();
  });

  it("dispatches a step, checkpoints currentStep, and is idempotent on rerun", async () => {
    const job = await createCloudAgentBoxWarmJob(db, createJobInput());
    const spy = vi.fn(async () => undefined);
    const executors = { ...WARM_STEP_EXECUTORS, "ensure-sandbox": spy as WarmStepExecutor };
    const ctx = makeCtx();

    const first = await runWarmJobStep({ db, jobId: job.id, step: "ensure-sandbox", ctx, executors });
    expect(first.outcome).toBe("ran");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await getCloudAgentBoxWarmJob(db, job.id))?.currentStep).toBe("ensure-sandbox");

    // Re-delivery of the same step: idempotent no-op (executor not re-run).
    const second = await runWarmJobStep({ db, jobId: job.id, step: "ensure-sandbox", ctx, executors });
    expect(second.outcome).toBe("duplicate");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await getCloudAgentBoxWarmJob(db, job.id))?.currentStep).toBe("ensure-sandbox");
  });

  it("marks the job ready after the final step", async () => {
    const job = await createCloudAgentBoxWarmJob(db, createJobInput());
    // Walk the checkpoint up to the step before finalize.
    for (const step of CLOUD_AGENT_BOX_WARM_STEPS.slice(0, -1)) {
      await advanceCloudAgentBoxWarmJob(db, job.id, step);
    }
    const spy = vi.fn(async () => undefined);
    const executors = { ...WARM_STEP_EXECUTORS, finalize: spy as WarmStepExecutor };

    const result = await runWarmJobStep({
      db,
      jobId: job.id,
      step: "finalize",
      ctx: makeCtx(),
      executors,
    });
    expect(result.outcome).toBe("ran");
    const done = await getCloudAgentBoxWarmJob(db, job.id);
    expect(done?.status).toBe("ready");
    expect(done?.currentStep).toBe("finalize");
    expect(done?.sandboxId).toBe("sbx_1");
  });

  it("applies the failure-state contract on a terminal step error", async () => {
    const job = await createCloudAgentBoxWarmJob(db, createJobInput());
    const ctx = makeCtx();
    const boom = new Error("step exploded");
    const executors = {
      ...WARM_STEP_EXECUTORS,
      "ensure-sandbox": (async () => {
        throw boom;
      }) as WarmStepExecutor,
    };

    const result = await runWarmJobStep({ db, jobId: job.id, step: "ensure-sandbox", ctx, executors });
    expect(result.outcome).toBe("failed");

    const failed = await getCloudAgentBoxWarmJob(db, job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toBe("step exploded");
    // Sandbox is also marked failed with the same backgroundErrorMessage.
    expect(ctx.deps.updateSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: "sbx_1",
        workspaceId: auth.workspaceId,
        status: "failed",
        error: "step exploded",
      }),
    );
  });

  it("real WARM_STEP_EXECUTORS dispatch invokes the slice-1 step fn (mount-credentials)", async () => {
    const job = await createCloudAgentBoxWarmJob(db, createJobInput());
    // mount-credentials requires build-env completed.
    await advanceCloudAgentBoxWarmJob(db, job.id, "ensure-sandbox");
    await advanceCloudAgentBoxWarmJob(db, job.id, "build-env");
    const ctx = makeCtx();

    const result = await runWarmJobStep({ db, jobId: job.id, step: "mount-credentials", ctx });
    expect(result.outcome).toBe("ran");
    // The real executor called the slice-1 mountBoxCredentials -> deps.mountCliCredentials.
    expect(ctx.deps.mountCliCredentials).toHaveBeenCalledTimes(1);
    expect((await getCloudAgentBoxWarmJob(db, job.id))?.currentStep).toBe("mount-credentials");
  });

  it("WARM_STEP_EXECUTORS covers exactly the ordered warm steps", () => {
    expect(Object.keys(WARM_STEP_EXECUTORS).sort()).toEqual([...CLOUD_AGENT_BOX_WARM_STEPS].sort());
  });
});

describe("warm-jobs slice 2 is dormant", () => {
  const boxDir = dirname(fileURLToPath(import.meta.url));

  it("the live warm path does not import the warm job store or step runner", () => {
    for (const file of ["box-manager.ts", "route.ts"]) {
      const source = readFileSync(join(boxDir, file), "utf8");
      expect(source).not.toContain("warm-job-store");
      expect(source).not.toContain("warm-step-runner");
    }
  });

  it("the live async warm path still drives via scheduleBackgroundTask", () => {
    // Slice 2 must not cut over to the queue. The async warm continues to run
    // through the same scheduleBackgroundTask/waitUntil mechanism.
    const source = readFileSync(join(boxDir, "box-manager.ts"), "utf8");
    expect(source).toContain("scheduleBackgroundTask");
  });
});
