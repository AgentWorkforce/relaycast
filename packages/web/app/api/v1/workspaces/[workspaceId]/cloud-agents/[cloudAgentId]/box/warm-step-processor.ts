import type { AppDb } from "@/lib/db";
import { logger } from "@/lib/logger";

import { defaultCloudAgentBoxDeps, type CloudAgentBoxDeps } from "./box-manager";
import { buildWarmStepContext } from "./warm-context";
import { enqueueCloudAgentBoxWarm, type CloudAgentBoxWarmTransport } from "./warm-queue";
import { runWarmJobStep } from "./warm-step-runner";
import {
  getCloudAgentBoxWarmJob,
  linkSandboxActiveWarmJob,
  markCloudAgentBoxWarmJobFailed,
  nextWarmStep,
  setCloudAgentBoxWarmJobSandbox,
  type CloudAgentBoxWarmJobRow,
  type EnqueueCloudAgentBoxWarmPayload,
} from "./warm-job-store";

/**
 * Cloud-agent box warm step PROCESSOR (issue #1384, slice 3) — TRANSPORT-AGNOSTIC.
 * Runs ONE step for {jobId,expectedStep}, then re-enqueues the next (via the
 * seam) until ready/failed. Knows nothing about CF Queue/SQS — the cloud-web
 * internal endpoint (option b) calls this; the seam re-enqueues via cloud-web's
 * CF Queue binding. All cross-step state from the DB row / sandbox (#1445).
 */
export type ProcessCloudAgentBoxWarmStepResult =
  | { outcome: "advanced"; nextStep: string }
  | { outcome: "ready" }
  | { outcome: "retry"; error: string }
  | { outcome: "failed"; error: string }
  | { outcome: "skipped"; reason: "duplicate" | "contended" | "not_found" | "missing_job" };

export interface ProcessCloudAgentBoxWarmStepArgs {
  db?: AppDb;
  deps?: CloudAgentBoxDeps;
  enqueue?: CloudAgentBoxWarmTransport;
  payload: EnqueueCloudAgentBoxWarmPayload;
}

export async function processCloudAgentBoxWarmStep(
  args: ProcessCloudAgentBoxWarmStepArgs,
): Promise<ProcessCloudAgentBoxWarmStepResult> {
  const { payload } = args;
  const deps = args.deps ?? defaultCloudAgentBoxDeps();
  const db = args.db;
  const enqueue = args.enqueue ?? enqueueCloudAgentBoxWarm;

  const job = await getCloudAgentBoxWarmJob(db, payload.jobId);
  if (!job) {
    logger.warn("[cloud-agent-warm] step for unknown job; skipping", { area: "cloud-agent-warm", jobId: payload.jobId, expectedStep: payload.expectedStep });
    return { outcome: "skipped", reason: "missing_job" };
  }

  const stepStartedAt = Date.now();
  const ctx = await buildWarmStepContext(deps, job);
  const result = await runWarmJobStep({ db, jobId: payload.jobId, step: payload.expectedStep, ctx });
  const durationMs = Date.now() - stepStartedAt;

  // Per-step duration observability (#1384): one structured line per executed
  // step so the queue-backed 50-run yields empirical {step -> durationMs}
  // splits. The warm path was previously instrumented only for failures, so
  // there was no way to see e.g. ensure-broker's /health poll eating the cold
  // budget. `outcome` lets analysis separate real work (advanced/ready/failed)
  // from idempotency no-ops (duplicate/contended/not_found, ~0ms).
  logger.info("[cloud-agent-warm] warm step complete", {
    area: "cloud-agent-warm",
    jobId: payload.jobId,
    step: payload.expectedStep,
    durationMs,
    outcome: result.outcome,
    sandboxId: ctx.sandbox?.id ?? job.sandboxId ?? null,
  });

  if (result.outcome === "duplicate" || result.outcome === "contended" || result.outcome === "not_found") {
    logger.info("[cloud-agent-warm] step not run; skipping", { area: "cloud-agent-warm", jobId: payload.jobId, expectedStep: payload.expectedStep, outcome: result.outcome });
    return { outcome: "skipped", reason: result.outcome };
  }
  if (result.outcome === "retryable") {
    // Transient Daytona upstream timeout — runWarmJobStep released the lease
    // without advancing. Surface `retry` so the internal step route returns 503
    // → the CF-Queue consumer does NOT ack → the queue redelivers this same
    // {jobId, expectedStep} (maxRetries → DLQ → failExhausted on exhaustion).
    logger.warn("[cloud-agent-warm] warm step hit retryable upstream timeout; lease released for queue retry", { area: "cloud-agent-warm", jobId: payload.jobId, expectedStep: payload.expectedStep, error: result.error });
    return { outcome: "retry", error: result.error };
  }
  if (result.outcome === "failed") {
    logger.error("[cloud-agent-warm] warm step failed terminally", { area: "cloud-agent-warm", jobId: payload.jobId, expectedStep: payload.expectedStep, error: result.error });
    return { outcome: "failed", error: result.error };
  }

  if (payload.expectedStep === "ensure-sandbox" && ctx.sandbox) {
    await persistEnsuredSandbox(deps, db, job, ctx.sandbox.id, payload.jobId);
  }

  const next = nextWarmStep(payload.expectedStep);
  if (next) {
    await enqueue({ jobId: payload.jobId, expectedStep: next });
    return { outcome: "advanced", nextStep: next };
  }

  const sandboxId = ctx.sandbox?.id ?? result.job?.sandboxId ?? job.sandboxId;
  if (sandboxId) {
    await deps.updateSandbox({ sandboxId, workspaceId: job.workspaceId, status: "running", error: null, expectedReadyBy: null });
  }
  logger.info("[cloud-agent-warm] warm job ready", { area: "cloud-agent-warm", jobId: payload.jobId, sandboxId: sandboxId ?? null });
  return { outcome: "ready" };
}

/** DLQ / retries-exhausted handler: mark job + sandbox failed ('warm exhausted retries: <lastError>'). */
export async function failExhaustedCloudAgentBoxWarmJob(
  payload: EnqueueCloudAgentBoxWarmPayload,
  options: { db?: AppDb; deps?: CloudAgentBoxDeps } = {},
): Promise<void> {
  const db = options.db;
  const job = await getCloudAgentBoxWarmJob(db, payload.jobId);
  if (!job || job.status === "ready" || job.status === "failed") return;
  const message = job.lastError ? `warm exhausted retries: ${job.lastError}` : "warm exhausted retries before the box became ready";
  await markCloudAgentBoxWarmJobFailed(db, payload.jobId, message);
  if (job.sandboxId) {
    const deps = options.deps ?? defaultCloudAgentBoxDeps();
    await deps.updateSandbox({ sandboxId: job.sandboxId, workspaceId: job.workspaceId, status: "failed", error: message, expectedReadyBy: null });
  }
  logger.error("[cloud-agent-warm] warm job marked failed (retries exhausted)", { area: "cloud-agent-warm", jobId: payload.jobId, sandboxId: job.sandboxId, expectedStep: payload.expectedStep, message });
}

async function persistEnsuredSandbox(
  deps: CloudAgentBoxDeps,
  db: AppDb | undefined,
  job: CloudAgentBoxWarmJobRow,
  sandboxId: string,
  jobId: string,
): Promise<void> {
  await setCloudAgentBoxWarmJobSandbox(db, jobId, sandboxId);
  await deps.insertSandbox({
    sandboxId,
    auth: { userId: job.userId, workspaceId: job.workspaceId, organizationId: job.organizationId },
    workspaceId: job.workspaceId,
    cloudAgentId: job.cloudAgentId,
    status: "warming",
    brokerPort: null,
    error: null,
    expectedReadyBy: null,
  });
  await linkSandboxActiveWarmJob(db, sandboxId, job.workspaceId, jobId);
}
