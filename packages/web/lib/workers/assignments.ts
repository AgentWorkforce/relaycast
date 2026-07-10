import { and, desc, eq, isNotNull, lte, or } from "drizzle-orm";
import { getDb } from "@/lib/db/index";
import { workAssignments, workers } from "@/lib/db/schema";
import { workflowStore } from "@/lib/workflows";
import { getWorkerAssignmentBus } from "./bus";
import { WorkerDispatcher, mapWorkAssignment } from "./dispatcher";
import type {
  AssignmentStatus,
  AssignmentStatusDetail,
  WorkAssignmentRecord,
  WorkerRecord,
  WorkerWorkflowRef,
} from "./types";

const DISCONNECTED_WORKER_FAILOVER_MS = 5 * 60 * 1000;
const QUEUE_TIMEOUT_ERROR = "queue-timeout";
const WORKER_DISCONNECTED_ERROR = "worker-disconnected";
const WORKER_REVOKED_ERROR = "worker-revoked";

function createDispatcher(): WorkerDispatcher {
  return new WorkerDispatcher();
}

async function markRunsFailed(
  assignments: WorkAssignmentRecord[],
  fallbackError: string,
): Promise<void> {
  const updates = assignments.map((assignment) =>
    workflowStore.update(assignment.runId, {
      status: "failed",
      result: assignment.result,
      error: assignment.error ?? fallbackError,
    }),
  );

  const results = await Promise.allSettled(updates);
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(
        "Worker assignment workflow update failed:",
        result.reason instanceof Error ? result.reason.message : String(result.reason),
      );
    }
  }
}

async function publishTimeoutAssignments(assignments: WorkAssignmentRecord[]): Promise<void> {
  const bus = getWorkerAssignmentBus();

  await Promise.allSettled(
    assignments
      .filter((assignment): assignment is WorkAssignmentRecord & { workerId: string } =>
        typeof assignment.workerId === "string",
      )
      .map((assignment) =>
        bus.publish(assignment.workerId, {
          type: "timeout",
          assignment,
        }),
      ),
  );
}

async function failAssignmentsForWorkerIds(
  workerIds: string[],
  statuses: Array<"queued" | "assigned" | "running">,
  error: string,
  at: Date,
): Promise<WorkAssignmentRecord[]> {
  if (workerIds.length === 0 || statuses.length === 0) {
    return [];
  }

  const rows = await getDb()
    .update(workAssignments)
    .set({
      status: "failed",
      completedAt: at,
      error,
    })
    .where(
      and(
        or(...workerIds.map((workerId) => eq(workAssignments.workerId, workerId))),
        or(...statuses.map((status) => eq(workAssignments.status, status))),
      ),
    )
    .returning();

  return rows.map(mapWorkAssignment);
}

async function failRevokedAssignments(at: Date): Promise<WorkAssignmentRecord[]> {
  const revokedWorkers = await getDb()
    .select({ id: workers.id })
    .from(workers)
    .where(eq(workers.status, "revoked"));

  return failAssignmentsForWorkerIds(
    revokedWorkers.map((worker) => worker.id),
    ["queued", "assigned"],
    WORKER_REVOKED_ERROR,
    at,
  );
}

async function failDisconnectedRunningAssignments(at: Date): Promise<WorkAssignmentRecord[]> {
  const cutoff = new Date(at.getTime() - DISCONNECTED_WORKER_FAILOVER_MS);
  const staleWorkers = await getDb()
    .select({ id: workers.id })
    .from(workers)
    .where(
      and(
        eq(workers.status, "offline"),
        isNotNull(workers.lastSeen),
        lte(workers.lastSeen, cutoff),
      ),
    );

  return failAssignmentsForWorkerIds(
    staleWorkers.map((worker) => worker.id),
    ["running"],
    WORKER_DISCONNECTED_ERROR,
    at,
  );
}

async function timeoutQueuedAssignments(at: Date): Promise<WorkAssignmentRecord[]> {
  const rows = await getDb()
    .update(workAssignments)
    .set({
      status: "timeout",
      completedAt: at,
      error: QUEUE_TIMEOUT_ERROR,
    })
    .where(
      and(
        eq(workAssignments.status, "queued"),
        lte(workAssignments.queueDeadline, at),
      ),
    )
    .returning();

  const assignments = rows.map(mapWorkAssignment);
  await publishTimeoutAssignments(assignments);
  return assignments;
}

/**
 * ACK timeout and disconnect failover are control-plane maintenance sweeps in v4,
 * not worker-pushed transitions. Without a durable `acknowledged_at` marker, this
 * sweep enforces queue expiry, revoked-worker cleanup, and disconnected-run failover.
 */
export async function runWorkerAssignmentMaintenance(): Promise<{
  timedOut: number;
  revoked: number;
  disconnected: number;
}> {
  const now = new Date();
  const timedOutAssignments = await timeoutQueuedAssignments(now);
  const revokedAssignments = await failRevokedAssignments(now);
  const disconnectedAssignments = await failDisconnectedRunningAssignments(now);

  await Promise.all([
    markRunsFailed(timedOutAssignments, QUEUE_TIMEOUT_ERROR),
    markRunsFailed(revokedAssignments, WORKER_REVOKED_ERROR),
    markRunsFailed(disconnectedAssignments, WORKER_DISCONNECTED_ERROR),
  ]);

  return {
    timedOut: timedOutAssignments.length,
    revoked: revokedAssignments.length,
    disconnected: disconnectedAssignments.length,
  };
}

export async function enqueueForWorker(input: {
  worker: WorkerRecord;
  workspaceId: string;
  runId: string;
  workflowRef: WorkerWorkflowRef;
  maxQueueWaitMs?: number;
}): Promise<WorkAssignmentRecord> {
  await runWorkerAssignmentMaintenance();
  return createDispatcher().enqueue(
    input.worker,
    input.workflowRef,
    input.runId,
    input.workspaceId,
    { maxQueueWaitMs: input.maxQueueWaitMs },
  );
}

export async function acknowledgeAssignment(
  workerId: string,
  runId: string,
): Promise<WorkAssignmentRecord | null> {
  await runWorkerAssignmentMaintenance();
  return createDispatcher().ack(workerId, runId);
}

export async function pollQueueForWorker(workerId: string): Promise<WorkAssignmentRecord[]> {
  await runWorkerAssignmentMaintenance();
  return createDispatcher().pollQueueForWorker(workerId);
}

export async function publishWorkerRevocation(workerId: string): Promise<void> {
  await getWorkerAssignmentBus().publish(workerId, {
    type: "revoke",
    workerId,
  });
}

export async function revokePendingAssignmentsForWorker(
  workerId: string,
): Promise<WorkAssignmentRecord[]> {
  const assignments = await failAssignmentsForWorkerIds(
    [workerId],
    ["queued", "assigned"],
    WORKER_REVOKED_ERROR,
    new Date(),
  );
  await markRunsFailed(assignments, WORKER_REVOKED_ERROR);
  return assignments;
}

export async function recordPhaseTransition(
  workerId: string,
  runId: string,
  phase: "running" | "completed" | "failed",
  detail: AssignmentStatusDetail,
): Promise<WorkAssignmentRecord | null> {
  await runWorkerAssignmentMaintenance();

  const assignment = await createDispatcher().reportStatus(workerId, runId, phase, detail);
  if (!assignment) {
    return null;
  }

  if (assignment.status === "running") {
    await workflowStore.update(runId, {
      status: "running",
      error: undefined,
    });
    return assignment;
  }

  if (assignment.status === "completed") {
    await workflowStore.update(runId, {
      status: "completed",
      result:
        assignment.result ??
        detail.result ??
        {
          ...(detail.exitCode !== undefined ? { exitCode: detail.exitCode } : {}),
          ...(detail.durationMs !== undefined ? { durationMs: detail.durationMs } : {}),
          ...(detail.summary !== undefined ? { summary: detail.summary } : {}),
        },
      error: undefined,
    });
    return assignment;
  }

  await workflowStore.update(runId, {
    status: "failed",
    result: assignment.result ?? detail.result,
    error:
      assignment.status === "timeout"
        ? QUEUE_TIMEOUT_ERROR
        : detail.error ?? assignment.error ?? "worker-failed",
  });
  return assignment;
}

export async function listAssignmentsForWorker(
  workerId: string,
  options?: { status?: AssignmentStatus },
): Promise<WorkAssignmentRecord[]> {
  const filters = [eq(workAssignments.workerId, workerId)];
  if (options?.status) {
    filters.push(eq(workAssignments.status, options.status));
  }

  const rows = await getDb()
    .select()
    .from(workAssignments)
    .where(and(...filters))
    .orderBy(desc(workAssignments.queuedAt));

  return rows.map(mapWorkAssignment);
}
