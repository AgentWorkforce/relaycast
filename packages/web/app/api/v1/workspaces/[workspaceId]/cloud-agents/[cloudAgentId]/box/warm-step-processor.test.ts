import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import type { AppDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { sandboxes } from "@/lib/db/schema";
import { createPgliteDb } from "@/test/helpers/pglite-db";

import { CloudAgentBoxError, type CloudAgentBoxDeps } from "./box-manager";
import { buildWarmStepContext } from "./warm-context";
import {
  CLOUD_AGENT_BOX_WARM_STEPS,
  createCloudAgentBoxWarmJob,
  getCloudAgentBoxWarmJob,
  markCloudAgentBoxWarmJobFailed,
} from "./warm-job-store";
import {
  failExhaustedCloudAgentBoxWarmJob,
  processCloudAgentBoxWarmStep,
} from "./warm-step-processor";
import {
  runWarmJobStep,
  WARM_STEP_EXECUTORS,
  type WarmStepExecutor,
} from "./warm-step-runner";

const auth = {
  userId: "00000000-0000-0000-0000-000000000001",
  workspaceId: "00000000-0000-0000-0000-000000000002",
  organizationId: "00000000-0000-0000-0000-000000000003",
};
const cloudAgentId = "00000000-0000-0000-0000-000000000004";
const jobInput = () => ({ workspaceId: auth.workspaceId, cloudAgentId, userId: auth.userId, organizationId: auth.organizationId });

function makeDeps(db: AppDb, opts: { createThrows?: Error } = {}): CloudAgentBoxDeps {
  let n = 1;
  const sandbox = {
    id: "sbx_1", organizationId: "org", state: "started",
    getUserHomeDir: vi.fn(async () => "/home/daytona"),
    getSignedPreviewUrl: vi.fn(async () => ({ url: "https://sbx-1.daytona.test/" })),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined),
    process: { executeCommand: vi.fn(async () => ({ exitCode: 0, result: "ok" })) },
    fs: { uploadFile: vi.fn(async () => undefined) },
  };
  const daytona = {
    create: vi.fn(async () => { if (opts.createThrows) throw opts.createThrows; sandbox.id = `sbx_${n++}`; return sandbox; }),
    get: vi.fn(async (id: string) => { sandbox.id = id; return sandbox; }),
    start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
  };
  return {
    findCredential: vi.fn(async () => ({ id: cloudAgentId, organizationId: auth.organizationId, workspaceId: auth.workspaceId, userId: auth.userId, harness: "claude", modelProvider: "anthropic", authType: "provider_oauth", displayName: "Claude", defaultModel: "claude-sonnet-4-5", status: "connected", credentialExpiresAt: null, refreshExhausted: false, lastError: null })),
    getCredentialSecret: vi.fn(async () => JSON.stringify({ oauth: true })),
    createDaytonaClient: vi.fn(() => daytona),
    getSnapshotName: vi.fn(async () => "snap"),
    mountCliCredentials: vi.fn(async () => undefined),
    startRelayfileMount: vi.fn(async () => ({ pid: "1" })),
    flushRelayfileMount: vi.fn(async () => undefined),
    mintPathScopedRelayfileToken: vi.fn(async (i: { paths: string[] }) => `relay_pa_${i.paths.join("_")}`),
    mintRelayAuthWorkspaceToken: vi.fn(async (i: { workspaceId: string }) => `relay_ws_${i.workspaceId}`),
    evictRelayAuthWorkspaceTokenCache: vi.fn(),
    resolveRelayAuthConfig: vi.fn(() => ({ relayAuthUrl: "https://api.relayauth.test", relayAuthApiKey: "k" })),
    resolveRelayfileConfig: vi.fn(() => ({ relayfileUrl: "https://relayfile.test", relayAuthUrl: "https://api.relayauth.test", relayAuthApiKey: "k" })),
    getBrokerKeySecret: vi.fn(() => "secret"),
    deriveBrokerApiKey: vi.fn((_s: string, id: string) => `api_${id}`),
    resolveGitCloneCredentials: vi.fn(async () => null),
    now: vi.fn(() => new Date("2026-05-29T12:00:00.000Z")),
    markCredentialUsed: vi.fn(async () => undefined),
    insertSandbox: vi.fn(async (i: { sandboxId: string; auth: { userId: string; organizationId: string }; workspaceId: string; cloudAgentId: string; status: string }) => {
      const now = new Date();
      await db.insert(sandboxes).values({ id: i.sandboxId, userId: i.auth.userId, organizationId: i.auth.organizationId, workspaceId: i.workspaceId, source: "cloud-agent", runId: null, cloudAgentId: i.cloudAgentId, status: i.status, brokerPort: null, error: null, expectedReadyBy: null, createdAt: now, updatedAt: now }).onConflictDoUpdate({ target: sandboxes.id, set: { status: i.status, updatedAt: now } });
    }),
    updateSandbox: vi.fn(async (i: { sandboxId: string; status?: string; error?: string | null }) => {
      await db.update(sandboxes).set({ ...(i.status ? { status: i.status } : {}), ...(i.error !== undefined ? { error: i.error } : {}), updatedAt: new Date() }).where(eq(sandboxes.id, i.sandboxId));
    }),
  } as unknown as CloudAgentBoxDeps;
}

type Pglite = Awaited<ReturnType<typeof createPgliteDb>>;

describe("warm step processor (slice 3, PGlite)", () => {
  let pg: Pglite; let db: AppDb;
  beforeEach(async () => { pg = await createPgliteDb(); db = pg.db as unknown as AppDb; });
  afterEach(async () => { await pg.cleanup(); });

  it("drives a job ensure-sandbox -> finalize to READY + flips the sandbox row to running", async () => {
    const deps = makeDeps(db);
    const job = await createCloudAgentBoxWarmJob(db, { ...jobInput(), request: { mountPaths: ["/workspace"] } });
    let payload: { jobId: string; expectedStep: string } | null = { jobId: job.id, expectedStep: "ensure-sandbox" };
    const enqueue = vi.fn(async (p: { jobId: string; expectedStep: string }) => { payload = p; });
    let guard = 0; let last = "";
    while (payload && guard++ < CLOUD_AGENT_BOX_WARM_STEPS.length + 2) {
      const cur = payload; payload = null;
      const r = await processCloudAgentBoxWarmStep({ db, deps, enqueue, payload: cur as never });
      last = r.outcome;
      if (r.outcome !== "advanced") break;
    }
    expect(last).toBe("ready");
    const done = await getCloudAgentBoxWarmJob(db, job.id);
    expect(done?.status).toBe("ready");
    expect(done?.currentStep).toBe("finalize");
    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, done!.sandboxId!));
    expect(row?.status).toBe("running");
    expect(row?.activeWarmJobId).toBe(job.id);
  });

  it("rehydrates broker identity from the job row into the runtime env (#125)", async () => {
    const deps = makeDeps(db);
    const job = await createCloudAgentBoxWarmJob(db, {
      ...jobInput(),
      request: {
        mountPaths: ["/workspace"],
        workspaceKey: "wsk_explicit-workspace",
        brokerName: "cloud-00000000",
      },
    });

    const ctx = await buildWarmStepContext(deps, job);

    expect(ctx.input.workspaceKey).toBe("wsk_explicit-workspace");
    expect(ctx.input.brokerName).toBe("cloud-00000000");
    expect(ctx.envVars.AGENT_RELAY_WORKSPACE_KEY).toBe("wsk_explicit-workspace");
    expect(ctx.envVars.AGENT_RELAY_BROKER_NAME).toBe("cloud-00000000");

    const plainJob = await createCloudAgentBoxWarmJob(db, {
      ...jobInput(),
      request: { mountPaths: ["/workspace"] },
    });
    const plainCtx = await buildWarmStepContext(deps, plainJob);
    expect(plainCtx.envVars).not.toHaveProperty("AGENT_RELAY_WORKSPACE_KEY");
    expect(plainCtx.envVars).not.toHaveProperty("AGENT_RELAY_BROKER_NAME");
  });

  it("idempotent on redelivery; failure-state contract on a throwing step; failExhausted marks failed", async () => {
    const okDeps = makeDeps(db);
    const j1 = await createCloudAgentBoxWarmJob(db, { ...jobInput(), request: { mountPaths: ["/workspace"] } });
    const enq = vi.fn(async () => undefined);
    expect((await processCloudAgentBoxWarmStep({ db, deps: okDeps, enqueue: enq, payload: { jobId: j1.id, expectedStep: "ensure-sandbox" } })).outcome).toBe("advanced");
    expect((await processCloudAgentBoxWarmStep({ db, deps: okDeps, enqueue: enq, payload: { jobId: j1.id, expectedStep: "ensure-sandbox" } }))).toEqual({ outcome: "skipped", reason: "duplicate" });
    expect(enq).toHaveBeenCalledTimes(1);

    const failDeps = makeDeps(db, { createThrows: new Error("daytona boom") });
    const j2 = await createCloudAgentBoxWarmJob(db, { ...jobInput(), request: { mountPaths: ["/workspace"] } });
    const r = await processCloudAgentBoxWarmStep({ db, deps: failDeps, enqueue: vi.fn(async () => undefined), payload: { jobId: j2.id, expectedStep: "ensure-sandbox" } });
    expect(r.outcome).toBe("failed");
    expect((await getCloudAgentBoxWarmJob(db, j2.id))?.status).toBe("failed");

    const j3 = await createCloudAgentBoxWarmJob(db, { ...jobInput(), sandboxId: "sbx_z" });
    await okDeps.insertSandbox({ sandboxId: "sbx_z", auth, workspaceId: auth.workspaceId, cloudAgentId, status: "warming", brokerPort: null, error: null, expectedReadyBy: null });
    await markCloudAgentBoxWarmJobFailed(db, j3.id, "broker timeout");
    const j4 = await createCloudAgentBoxWarmJob(db, { ...jobInput(), sandboxId: "sbx_z" });
    await failExhaustedCloudAgentBoxWarmJob({ jobId: j4.id, expectedStep: "ensure-broker" }, { db, deps: okDeps });
    expect((await getCloudAgentBoxWarmJob(db, j4.id))?.lastError).toContain("warm exhausted retries");
    const [row] = await db.select().from(sandboxes).where(eq(sandboxes.id, "sbx_z"));
    expect(row?.status).toBe("failed");
  });

  it("emits one structured per-step duration log per executed step (#1384 50-run observability)", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => Promise.resolve());
    try {
      const deps = makeDeps(db);
      const job = await createCloudAgentBoxWarmJob(db, { ...jobInput(), request: { mountPaths: ["/workspace"] } });
      let payload: { jobId: string; expectedStep: string } | null = { jobId: job.id, expectedStep: "ensure-sandbox" };
      const enqueue = vi.fn(async (p: { jobId: string; expectedStep: string }) => { payload = p; });
      let guard = 0;
      while (payload && guard++ < CLOUD_AGENT_BOX_WARM_STEPS.length + 2) {
        const cur = payload; payload = null;
        const r = await processCloudAgentBoxWarmStep({ db, deps, enqueue, payload: cur as never });
        if (r.outcome !== "advanced") break;
      }

      const stepLogs = infoSpy.mock.calls.filter(([msg]) => msg === "[cloud-agent-warm] warm step complete");
      // One per-step-complete log for every step in the pipeline, in order.
      const loggedSteps = stepLogs.map(([, meta]) => (meta as { step: string }).step);
      expect(loggedSteps).toEqual([...CLOUD_AGENT_BOX_WARM_STEPS]);
      for (const [, meta] of stepLogs) {
        const m = meta as { jobId: string; step: string; durationMs: number; outcome: string };
        expect(m.jobId).toBe(job.id);
        expect(typeof m.durationMs).toBe("number");
        expect(m.durationMs).toBeGreaterThanOrEqual(0);
        expect(m.outcome).not.toBe("failed");
      }
    } finally {
      infoSpy.mockRestore();
    }
  });
});

describe("warm step runner — retryable Daytona upstream classification (#1384)", () => {
  let pg: Pglite; let db: AppDb;
  beforeEach(async () => { pg = await createPgliteDb(); db = pg.db as unknown as AppDb; });
  afterEach(async () => { await pg.cleanup(); });

  const stepThrowing = (err: unknown): Record<string, WarmStepExecutor> => ({
    ...WARM_STEP_EXECUTORS,
    "ensure-sandbox": (async () => { throw err; }) as WarmStepExecutor,
  });

  it("raw Daytona 524 in a step → RETRYABLE: lease released, step NOT advanced, NOT terminal; redelivery re-runs the same step", async () => {
    const deps = makeDeps(db);
    const job = await createCloudAgentBoxWarmJob(db, { ...jobInput(), request: { mountPaths: ["/workspace"] } });
    const ctx = await buildWarmStepContext(deps, job);
    const raw524 = new Error('Error 524: A timeout occurred — the origin (proxy.app.daytona.io) did not respond');

    const r = await runWarmJobStep({
      db, jobId: job.id, step: "ensure-sandbox", ctx,
      executors: stepThrowing(raw524) as never,
    });
    expect(r.outcome).toBe("retryable");

    const mid = await getCloudAgentBoxWarmJob(db, job.id);
    expect(mid?.status).toBe("running");   // NOT terminal-failed
    expect(mid?.currentStep).toBeNull();    // step NOT advanced
    expect(mid?.leaseUntil).toBeNull();     // lease released so redelivery can re-claim

    // CF-Queue redelivery: same {jobId, expectedStep}, healthy executors → re-claims + advances.
    const job2 = await getCloudAgentBoxWarmJob(db, job.id);
    const ctx2 = await buildWarmStepContext(makeDeps(db), job2!);
    const r2 = await runWarmJobStep({ db, jobId: job.id, step: "ensure-sandbox", ctx: ctx2 });
    expect(r2.outcome).toBe("ran");
    expect((await getCloudAgentBoxWarmJob(db, job.id))?.currentStep).toBe("ensure-sandbox");
  });

  it("CloudAgentBoxError(daytona_upstream_timeout) from exhausted in-step retry → also RETRYABLE (matched by code, not message)", async () => {
    const deps = makeDeps(db);
    const job = await createCloudAgentBoxWarmJob(db, { ...jobInput(), request: { mountPaths: ["/workspace"] } });
    const ctx = await buildWarmStepContext(deps, job);
    const exhausted = new CloudAgentBoxError("Daytona is currently unresponsive — please retry in a moment", "daytona_upstream_timeout", 504);

    const r = await runWarmJobStep({
      db, jobId: job.id, step: "ensure-sandbox", ctx,
      executors: stepThrowing(exhausted) as never,
    });
    expect(r.outcome).toBe("retryable");
    expect((await getCloudAgentBoxWarmJob(db, job.id))?.status).toBe("running");
  });

  it("non-upstream error (e.g. box_warm_failed) stays TERMINAL — no retry-loop on real failures", async () => {
    const deps = makeDeps(db);
    const job = await createCloudAgentBoxWarmJob(db, { ...jobInput(), request: { mountPaths: ["/workspace"] } });
    const ctx = await buildWarmStepContext(deps, job);
    const realFail = new CloudAgentBoxError("Cloud agent box broker failed to install SDK", "box_warm_failed", 503);

    const r = await runWarmJobStep({
      db, jobId: job.id, step: "ensure-sandbox", ctx,
      executors: stepThrowing(realFail) as never,
    });
    expect(r.outcome).toBe("failed");
    expect((await getCloudAgentBoxWarmJob(db, job.id))?.status).toBe("failed");
  });
});
