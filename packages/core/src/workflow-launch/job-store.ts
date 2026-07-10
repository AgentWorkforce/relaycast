import {
  and,
  eq,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";

import { getDb } from "../db.js";
import { workflowLaunchJobs } from "../db/schema.js";
import type {
  WorkflowLaunchJobRequest,
  WorkflowLaunchJobRow,
} from "./job.js";
import {
  WORKFLOW_LAUNCH_JOB_LEASE_MS,
} from "./job.js";

type WorkflowLaunchDb = {
  insert: (...args: unknown[]) => {
    values: (values: unknown) => {
      returning: () => Promise<WorkflowLaunchJobRow[]>;
    };
  };
  select: (...args: unknown[]) => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        limit: (count: number) => Promise<WorkflowLaunchJobRow[]>;
      };
      limit: (count: number) => Promise<WorkflowLaunchJobRow[]>;
    };
  };
  update: (table: unknown) => any;
};

function resolveDb(db?: unknown): WorkflowLaunchDb {
  return (db ?? getDb()) as WorkflowLaunchDb;
}

export async function createWorkflowLaunchJob(
  request: WorkflowLaunchJobRequest,
): Promise<WorkflowLaunchJobRow>;
export async function createWorkflowLaunchJob(
  db: unknown,
  request: WorkflowLaunchJobRequest,
): Promise<WorkflowLaunchJobRow>;
export async function createWorkflowLaunchJob(
  dbOrRequest: unknown,
  maybeRequest?: WorkflowLaunchJobRequest,
): Promise<WorkflowLaunchJobRow> {
  const db = resolveDb(maybeRequest ? dbOrRequest : undefined);
  const request = (maybeRequest ?? dbOrRequest) as WorkflowLaunchJobRequest;

  const [job] = await db
    .insert(workflowLaunchJobs)
    .values({
      runId: request.runId,
      userId: request.userId,
      workspaceId: request.workspaceId,
      organizationId: request.organizationId,
      requestEnvelope: request.requestEnvelope,
      status: "queued",
      attempts: 0,
      leaseUntil: null,
      sandboxId: null,
      relayWorkspaceId: null,
      lastError: null,
      startedAt: null,
      completedAt: null,
    })
    .returning();

  if (!job) throw new Error("Failed to create workflow launch job");
  return job;
}

export async function getWorkflowLaunchJob(
  jobId: string,
): Promise<WorkflowLaunchJobRow | null>;
export async function getWorkflowLaunchJob(
  db: unknown,
  jobId: string,
): Promise<WorkflowLaunchJobRow | null>;
export async function getWorkflowLaunchJob(
  dbOrJobId: unknown,
  maybeJobId?: string,
): Promise<WorkflowLaunchJobRow | null> {
  const db = resolveDb(maybeJobId ? dbOrJobId : undefined);
  const jobId = (maybeJobId ?? dbOrJobId) as string;
  const [job] = await db
    .select()
    .from(workflowLaunchJobs)
    .where(eq(workflowLaunchJobs.id, jobId))
    .limit(1);
  return job ?? null;
}

export async function claimWorkflowLaunchJob(
  db: unknown,
  jobId: string,
  leaseMs = WORKFLOW_LAUNCH_JOB_LEASE_MS,
): Promise<WorkflowLaunchJobRow | null> {
  const resolvedDb = resolveDb(db);
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + leaseMs);
  const rows = await resolvedDb
    .update(workflowLaunchJobs)
    .set({
      status: "launching",
      attempts: sql`${workflowLaunchJobs.attempts} + 1`,
      leaseUntil,
      startedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(workflowLaunchJobs.id, jobId),
        or(
          eq(workflowLaunchJobs.status, "queued"),
          and(
            eq(workflowLaunchJobs.status, "launching"),
            or(
              isNull(workflowLaunchJobs.leaseUntil),
              lt(workflowLaunchJobs.leaseUntil, now),
            ),
          ),
        ),
      ),
    )
    .returning();
  return rows[0] ?? null;
}

export async function markWorkflowLaunchJobSandboxCreated(
  db: unknown,
  jobId: string,
  sandboxId: string,
): Promise<void> {
  await resolveDb(db)
    .update(workflowLaunchJobs)
    .set({
      sandboxId,
      updatedAt: new Date(),
    })
    .where(eq(workflowLaunchJobs.id, jobId));
}

export async function markWorkflowLaunchJobRelayWorkspace(
  db: unknown,
  jobId: string,
  relayWorkspaceId: string,
): Promise<void> {
  await resolveDb(db)
    .update(workflowLaunchJobs)
    .set({
      relayWorkspaceId,
      updatedAt: new Date(),
    })
    .where(eq(workflowLaunchJobs.id, jobId));
}

export async function markWorkflowLaunchJobLaunched(
  db: unknown,
  jobId: string,
  input: { sandboxId: string; relayWorkspaceId: string },
): Promise<void> {
  const completedAt = new Date();
  await resolveDb(db)
    .update(workflowLaunchJobs)
    .set({
      status: "launched",
      sandboxId: input.sandboxId,
      relayWorkspaceId: input.relayWorkspaceId,
      leaseUntil: null,
      lastError: null,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(workflowLaunchJobs.id, jobId));
}

export async function markWorkflowLaunchJobFailed(
  db: unknown,
  jobId: string,
  error: string,
): Promise<void> {
  const completedAt = new Date();
  await resolveDb(db)
    .update(workflowLaunchJobs)
    .set({
      status: "failed",
      leaseUntil: null,
      lastError: error,
      completedAt,
      updatedAt: completedAt,
    })
    .where(eq(workflowLaunchJobs.id, jobId));
}

export async function recordWorkflowLaunchJobRetryableFailure(
  db: unknown,
  jobId: string,
  error: string,
): Promise<void> {
  await resolveDb(db)
    .update(workflowLaunchJobs)
    .set({
      lastError: error,
      updatedAt: new Date(),
    })
    .where(eq(workflowLaunchJobs.id, jobId));
}

export async function releaseWorkflowLaunchJobForRetry(
  db: unknown,
  jobId: string,
  error: string,
): Promise<void> {
  await resolveDb(db)
    .update(workflowLaunchJobs)
    .set({
      status: "queued",
      leaseUntil: null,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(eq(workflowLaunchJobs.id, jobId));
}

export async function isWorkflowLaunchJobTerminal(
  db: unknown,
  jobId: string,
): Promise<boolean> {
  const job = await getWorkflowLaunchJob(db, jobId);
  return Boolean(job && ["launched", "failed"].includes(job.status));
}
