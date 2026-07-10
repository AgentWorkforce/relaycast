import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

import { getDb, type AppDb } from "@/lib/db";
import { cloudAgentBoxWarmJobs, sandboxes } from "@/lib/db/schema";
import type { CloudAgentBoxWarmJobRequest } from "@cloud/core/db/schema.js";

export type { CloudAgentBoxWarmJobRequest } from "@cloud/core/db/schema.js";

/**
 * Cloud-agent box warm job store (issue #1384, slice 2 — DORMANT).
 *
 * Pure DB layer for the durable warm-job record. Slice 3+ wires a queue
 * consumer to drive jobs through the slice-1 warm steps using these helpers;
 * nothing in the live warm path writes here yet.
 */

/**
 * Ordered warm steps. The order is the contract for checkpointing: a job's
 * `currentStep` is the last *completed* step, so a step is only claimable when
 * the immediately preceding step (or null, for the first step) is recorded.
 * The names mirror the slice-1 step functions in box-manager.ts.
 */
export const CLOUD_AGENT_BOX_WARM_STEPS = [
  "ensure-sandbox",
  "build-env",
  "mount-credentials",
  "flush-relayfile",
  "sync-git",
  "prepare-git-overlay-roots",
  "start-relayfile-mount",
  "write-env",
  "ensure-broker",
  "finalize",
] as const;

export type CloudAgentBoxWarmStep = (typeof CLOUD_AGENT_BOX_WARM_STEPS)[number];

export type CloudAgentBoxWarmJobStatus = "queued" | "running" | "ready" | "failed";

export const CLOUD_AGENT_BOX_WARM_JOB_LEASE_MS = 5 * 60 * 1000;

/** Queue message: run `expectedStep` for warm job `jobId`. */
export interface EnqueueCloudAgentBoxWarmPayload {
  jobId: string;
  expectedStep: CloudAgentBoxWarmStep;
}

/** The step to run after `step` completes, or null if `step` is the last. */
export function nextWarmStep(
  step: CloudAgentBoxWarmStep,
): CloudAgentBoxWarmStep | null {
  const idx = warmStepIndex(step);
  if (idx < 0 || idx >= CLOUD_AGENT_BOX_WARM_STEPS.length - 1) return null;
  return CLOUD_AGENT_BOX_WARM_STEPS[idx + 1];
}

export interface CloudAgentBoxWarmJobRow {
  id: string;
  workspaceId: string;
  cloudAgentId: string;
  userId: string;
  organizationId: string;
  sandboxId: string | null;
  status: CloudAgentBoxWarmJobStatus;
  currentStep: CloudAgentBoxWarmStep | null;
  attemptCount: number;
  leaseUntil: Date | null;
  lastError: string | null;
  request: CloudAgentBoxWarmJobRequest | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCloudAgentBoxWarmJobInput {
  workspaceId: string;
  cloudAgentId: string;
  userId: string;
  organizationId: string;
  sandboxId?: string | null;
  request?: CloudAgentBoxWarmJobRequest | null;
}

/**
 * Result of a claim attempt. `claimed` => the caller owns the lease and should
 * run `step`. `duplicate` => the job is terminal or already past `step` (a
 * duplicate/retried delivery), so the caller must ACK without re-running.
 * `contended` => another worker holds a live lease (try again later).
 * `not_found` => no such job.
 */
export type ClaimCloudAgentBoxWarmJobResult =
  | { outcome: "claimed"; job: CloudAgentBoxWarmJobRow }
  | { outcome: "duplicate"; job: CloudAgentBoxWarmJobRow }
  | { outcome: "contended"; job: CloudAgentBoxWarmJobRow }
  | { outcome: "not_found"; job: null };

const TERMINAL_STATUSES: ReadonlySet<CloudAgentBoxWarmJobStatus> = new Set([
  "ready",
  "failed",
]);

function resolveDb(db?: AppDb): AppDb {
  return db ?? getDb();
}

/** Index of a step in the ordered pipeline; null/unknown => -1 (before all). */
export function warmStepIndex(step: CloudAgentBoxWarmStep | null): number {
  if (step === null) return -1;
  return CLOUD_AGENT_BOX_WARM_STEPS.indexOf(step);
}

function toRow(row: typeof cloudAgentBoxWarmJobs.$inferSelect): CloudAgentBoxWarmJobRow {
  return row as unknown as CloudAgentBoxWarmJobRow;
}

export async function createCloudAgentBoxWarmJob(
  db: AppDb | undefined,
  input: CreateCloudAgentBoxWarmJobInput,
): Promise<CloudAgentBoxWarmJobRow> {
  const [job] = await resolveDb(db)
    .insert(cloudAgentBoxWarmJobs)
    .values({
      workspaceId: input.workspaceId,
      cloudAgentId: input.cloudAgentId,
      userId: input.userId,
      organizationId: input.organizationId,
      sandboxId: input.sandboxId ?? null,
      request: input.request ?? null,
      status: "queued",
      currentStep: null,
      attemptCount: 0,
      leaseUntil: null,
      lastError: null,
      startedAt: null,
      completedAt: null,
    })
    .returning();
  if (!job) throw new Error("Failed to create cloud agent box warm job");
  return toRow(job);
}

export async function getCloudAgentBoxWarmJob(
  db: AppDb | undefined,
  jobId: string,
): Promise<CloudAgentBoxWarmJobRow | null> {
  const [job] = await resolveDb(db)
    .select()
    .from(cloudAgentBoxWarmJobs)
    .where(eq(cloudAgentBoxWarmJobs.id, jobId))
    .limit(1);
  return job ? toRow(job) : null;
}

/** Most recently created warm job for a (workspace, cloud agent), or null. */
export async function getLatestCloudAgentBoxWarmJob(
  db: AppDb | undefined,
  workspaceId: string,
  cloudAgentId: string,
): Promise<CloudAgentBoxWarmJobRow | null> {
  const [job] = await resolveDb(db)
    .select()
    .from(cloudAgentBoxWarmJobs)
    .where(
      and(
        eq(cloudAgentBoxWarmJobs.workspaceId, workspaceId),
        eq(cloudAgentBoxWarmJobs.cloudAgentId, cloudAgentId),
      ),
    )
    .orderBy(desc(cloudAgentBoxWarmJobs.createdAt))
    .limit(1);
  return job ? toRow(job) : null;
}

export function isCloudAgentBoxWarmJobPending(
  job: CloudAgentBoxWarmJobRow | null,
): boolean {
  return Boolean(job && (job.status === "queued" || job.status === "running"));
}

/**
 * Claim a job to run `expectedStep`, taking a single-flight lease.
 *
 * Idempotent by design: a terminal job, or one whose `currentStep` is already
 * at/after `expectedStep`, returns `duplicate` (the caller ACKs without
 * re-running). The claim itself is one atomic UPDATE guarded on the precise
 * precondition (non-terminal, prior step completed, lease free or expired), so
 * concurrent consumers cannot both claim the same step.
 */
export async function claimCloudAgentBoxWarmJob(
  db: AppDb | undefined,
  jobId: string,
  expectedStep: CloudAgentBoxWarmStep,
  leaseMs: number = CLOUD_AGENT_BOX_WARM_JOB_LEASE_MS,
): Promise<ClaimCloudAgentBoxWarmJobResult> {
  const resolved = resolveDb(db);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const expectedIndex = warmStepIndex(expectedStep);
  // The step immediately before `expectedStep` must be the recorded checkpoint
  // (null when claiming the very first step).
  const requiredPrevStep =
    expectedIndex <= 0 ? null : CLOUD_AGENT_BOX_WARM_STEPS[expectedIndex - 1];

  const prevStepCondition =
    requiredPrevStep === null
      ? isNull(cloudAgentBoxWarmJobs.currentStep)
      : eq(cloudAgentBoxWarmJobs.currentStep, requiredPrevStep);

  const rows = await resolved
    .update(cloudAgentBoxWarmJobs)
    .set({
      status: "running",
      attemptCount: sql`${cloudAgentBoxWarmJobs.attemptCount} + 1`,
      leaseUntil,
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(cloudAgentBoxWarmJobs.id, jobId),
        prevStepCondition,
        or(
          eq(cloudAgentBoxWarmJobs.status, "queued"),
          eq(cloudAgentBoxWarmJobs.status, "running"),
        ),
        or(
          isNull(cloudAgentBoxWarmJobs.leaseUntil),
          lt(cloudAgentBoxWarmJobs.leaseUntil, now),
        ),
      ),
    )
    .returning();

  if (rows[0]) {
    return { outcome: "claimed", job: toRow(rows[0]) };
  }

  // The atomic claim missed — classify why by reading the current state.
  const job = await getCloudAgentBoxWarmJob(resolved, jobId);
  if (!job) {
    return { outcome: "not_found", job: null };
  }
  if (TERMINAL_STATUSES.has(job.status)) {
    return { outcome: "duplicate", job };
  }
  if (warmStepIndex(job.currentStep) >= expectedIndex) {
    // expectedStep already completed — duplicate/retried delivery.
    return { outcome: "duplicate", job };
  }
  // Non-terminal, correct step, but a live lease is held by another worker.
  return { outcome: "contended", job };
}

/**
 * Record `completedStep` as the new checkpoint and release the lease, keeping
 * the job `running` for the next step.
 */
export async function advanceCloudAgentBoxWarmJob(
  db: AppDb | undefined,
  jobId: string,
  completedStep: CloudAgentBoxWarmStep,
): Promise<void> {
  const now = new Date();
  await resolveDb(db)
    .update(cloudAgentBoxWarmJobs)
    .set({
      status: "running",
      currentStep: completedStep,
      leaseUntil: null,
      updatedAt: now,
    })
    .where(eq(cloudAgentBoxWarmJobs.id, jobId));
}

/** Mark the job ready (terminal success): clears the lease and last error. */
export async function markCloudAgentBoxWarmJobReady(
  db: AppDb | undefined,
  jobId: string,
  sandboxId?: string,
): Promise<void> {
  const completedAt = new Date();
  await resolveDb(db)
    .update(cloudAgentBoxWarmJobs)
    .set({
      status: "ready",
      currentStep: "finalize",
      leaseUntil: null,
      lastError: null,
      ...(sandboxId ? { sandboxId } : {}),
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(cloudAgentBoxWarmJobs.id, jobId));
}

/** Mark the job failed (terminal): clears the lease and records the error. */
export async function markCloudAgentBoxWarmJobFailed(
  db: AppDb | undefined,
  jobId: string,
  error: string,
): Promise<void> {
  const completedAt = new Date();
  await resolveDb(db)
    .update(cloudAgentBoxWarmJobs)
    .set({
      status: "failed",
      leaseUntil: null,
      lastError: error,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(cloudAgentBoxWarmJobs.id, jobId));
}

/**
 * Release the step lease WITHOUT advancing (retryable upstream failure).
 *
 * Unlike {@link markCloudAgentBoxWarmJobFailed} (terminal) this keeps the job
 * NON-terminal: it clears `leaseUntil` and leaves `status='running'` and
 * `currentStep` UNCHANGED (still the prior checkpoint), so a CF-Queue
 * redelivery of the SAME `{jobId, expectedStep}` re-validates the claim
 * precondition (`currentStep === requiredPrevStep`, lease free) and genuinely
 * re-runs that step. `lastError` is recorded for observability. Used when a
 * step throws a transient Daytona upstream timeout (524) — see
 * `isDaytonaUpstreamTimeout`. CF-Queue `maxRetries` bounds the retries; the DLQ
 * path then calls {@link markCloudAgentBoxWarmJobFailed} via `failExhausted`.
 */
export async function releaseCloudAgentBoxWarmJobLease(
  db: AppDb | undefined,
  jobId: string,
  lastError: string,
): Promise<void> {
  const now = new Date();
  await resolveDb(db)
    .update(cloudAgentBoxWarmJobs)
    .set({
      status: "running",
      leaseUntil: null,
      lastError,
      updatedAt: now,
    })
    .where(eq(cloudAgentBoxWarmJobs.id, jobId));
}

/** Record the sandbox id on the job once ensure-sandbox materializes it. */
export async function setCloudAgentBoxWarmJobSandbox(
  db: AppDb | undefined,
  jobId: string,
  sandboxId: string,
): Promise<void> {
  await resolveDb(db)
    .update(cloudAgentBoxWarmJobs)
    .set({ sandboxId, updatedAt: new Date() })
    .where(eq(cloudAgentBoxWarmJobs.id, jobId));
}

/** Point a sandboxes row at its in-flight warm job (sandboxes.active_warm_job_id). */
export async function linkSandboxActiveWarmJob(
  db: AppDb | undefined,
  sandboxId: string,
  workspaceId: string,
  jobId: string,
): Promise<void> {
  await resolveDb(db)
    .update(sandboxes)
    .set({ activeWarmJobId: jobId, updatedAt: new Date() })
    .where(and(eq(sandboxes.id, sandboxId), eq(sandboxes.workspaceId, workspaceId)));
}
