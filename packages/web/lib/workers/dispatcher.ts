import {
  WorkerDispatcher as CoreWorkerDispatcher,
  WorkerRegistry as CoreWorkerRegistry,
  type WorkAssignment as CoreWorkAssignment,
  type WorkerDispatcherDb,
} from "@cloud/core/workers/index.js";
import { and, asc, eq, gt, lt, or } from "drizzle-orm";
import { getDb } from "@/lib/db/index";
import { workAssignments } from "@/lib/db/schema";
import { createCoreAssignmentBus } from "./bus";
import { createWorkerRegistryDb } from "./registry";
import { hashWorkerTokenBytes, mintWorkerToken } from "./tokens";
import type {
  AssignmentStatusDetail,
  WorkAssignmentRecord,
  WorkerRecord,
  WorkerWorkflowRef,
} from "./types";

type DispatcherDbClient = ReturnType<typeof getDb>;
type AssignmentRow = typeof workAssignments.$inferSelect;

function readWorkflowRef(value: unknown): WorkerWorkflowRef {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    ((value as { type?: unknown }).type === "inline" ||
      (value as { type?: unknown }).type === "url") &&
    typeof (value as { value?: unknown }).value === "string"
  ) {
    return value as WorkerWorkflowRef;
  }

  throw new Error("Invalid workflow_ref payload");
}

function readResult(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCoreResult(value: unknown): CoreWorkAssignment["result"] {
  const result = readResult(value);
  if (!result) {
    return undefined;
  }

  return typeof result.exitCode === "number" && typeof result.durationMs === "number"
    ? {
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        ...(typeof result.summary === "string" ? { summary: result.summary } : {}),
      }
    : undefined;
}

function mapAssignmentRowToCore(row: AssignmentRow): CoreWorkAssignment {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workerId: row.workerId ?? null,
    runId: row.runId,
    workflowRef: readWorkflowRef(row.workflowRef),
    status: row.status as CoreWorkAssignment["status"],
    queuedAt: row.queuedAt,
    assignedAt: row.assignedAt ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    queueDeadline: row.queueDeadline,
    result: readCoreResult(row.result),
    error: row.error ?? undefined,
  };
}

export function mapWorkAssignment(value: CoreWorkAssignment | AssignmentRow): WorkAssignmentRecord {
  const workflowRef = readWorkflowRef(value.workflowRef);
  const result =
    "result" in value && value.result && typeof value.result === "object" && !Array.isArray(value.result)
      ? (value.result as Record<string, unknown>)
      : undefined;

  return {
    id: value.id,
    workspaceId: value.workspaceId,
    workerId: value.workerId ?? null,
    runId: value.runId,
    workflowRef,
    status: value.status as WorkAssignmentRecord["status"],
    queuedAt: value.queuedAt.toISOString(),
    assignedAt: value.assignedAt ? value.assignedAt.toISOString() : null,
    startedAt: value.startedAt ? value.startedAt.toISOString() : null,
    completedAt: value.completedAt ? value.completedAt.toISOString() : null,
    queueDeadline: value.queueDeadline.toISOString(),
    result,
    error: value.error ?? undefined,
  };
}

function mapWorkerToCore(worker: WorkerRecord) {
  return {
    id: worker.id,
    workspaceId: worker.workspaceId,
    name: worker.name,
    displayName: worker.displayName,
    status: worker.status,
    lastSeen: worker.lastSeen ? new Date(worker.lastSeen) : null,
    hostInfo: worker.hostInfo,
    tags: worker.tags,
  };
}

function createCoreDispatcher(): CoreWorkerDispatcher {
  return new CoreWorkerDispatcher(
    new CoreWorkerRegistry({
      generateToken: mintWorkerToken,
      hashToken: hashWorkerTokenBytes,
    }),
    createCoreAssignmentBus(),
  );
}

function createWorkerDispatcherDb(db: DispatcherDbClient): WorkerDispatcherDb {
  const registryDb = createWorkerRegistryDb(db);

  return {
    ...registryDb,

    async createAssignment(input) {
      const [row] = await db
        .insert(workAssignments)
        .values({
          ...(input.id ? { id: input.id } : {}),
          workspaceId: input.workspaceId,
          workerId: input.workerId,
          runId: input.runId,
          workflowRef: input.workflowRef,
          status: input.status,
          queuedAt: input.queuedAt,
          assignedAt: input.assignedAt ?? null,
          queueDeadline: input.queueDeadline,
        })
        .returning();

      return mapAssignmentRowToCore(row);
    },

    async markAssignmentAssigned(input) {
      const [row] = await db
        .update(workAssignments)
        .set({
          status: "assigned",
          assignedAt: input.assignedAt,
        })
        .where(
          and(
            eq(workAssignments.workerId, input.workerId),
            eq(workAssignments.runId, input.runId),
            or(eq(workAssignments.status, "queued"), eq(workAssignments.status, "assigned")),
          ),
        )
        .returning();

      return row ? mapAssignmentRowToCore(row) : null;
    },

    async acknowledgeAssignment(input) {
      const [row] = await db
        .update(workAssignments)
        .set({
          status: "assigned",
          assignedAt: input.acknowledgedAt,
        })
        .where(
          and(
            eq(workAssignments.workerId, input.workerId),
            eq(workAssignments.runId, input.runId),
            or(eq(workAssignments.status, "queued"), eq(workAssignments.status, "assigned")),
          ),
        )
        .returning();

      if (row) {
        return mapAssignmentRowToCore(row);
      }

      const [existing] = await db
        .select()
        .from(workAssignments)
        .where(
          and(
            eq(workAssignments.workerId, input.workerId),
            eq(workAssignments.runId, input.runId),
          ),
        )
        .limit(1);

      return existing ? mapAssignmentRowToCore(existing) : null;
    },

    async reportAssignmentStatus(input) {
      const [current] = await db
        .select()
        .from(workAssignments)
        .where(
          and(
            eq(workAssignments.workerId, input.workerId),
            eq(workAssignments.runId, input.runId),
          ),
        )
        .limit(1);

      if (!current) {
        return null;
      }

      if (
        current.status === "completed" ||
        current.status === "failed" ||
        current.status === "timeout"
      ) {
        return mapAssignmentRowToCore(current);
      }

      const patch: Partial<typeof workAssignments.$inferInsert> = {
        assignedAt: current.assignedAt ?? input.at,
      };

      if (input.phase === "started" || input.phase === "running") {
        patch.status = "running";
        patch.startedAt = current.startedAt ?? input.at;
      } else {
        const partialResult = {
          ...(input.detail?.exitCode !== undefined ? { exitCode: input.detail.exitCode } : {}),
          ...(input.detail?.durationMs !== undefined ? { durationMs: input.detail.durationMs } : {}),
          ...(input.detail?.summary !== undefined ? { summary: input.detail.summary } : {}),
        };

        patch.status = input.phase;
        patch.startedAt = current.startedAt ?? input.at;
        patch.completedAt = input.at;
        patch.result = Object.keys(partialResult).length > 0 ? partialResult : null;
        patch.error = input.detail?.error ?? null;
      }

      const [row] = await db
        .update(workAssignments)
        .set(patch)
        .where(
          and(
            eq(workAssignments.workerId, input.workerId),
            eq(workAssignments.runId, input.runId),
          ),
        )
        .returning();

      return row ? mapAssignmentRowToCore(row) : null;
    },

    async timeoutQueuedAssignments(now) {
      const rows = await db
        .update(workAssignments)
        .set({
          status: "timeout",
          completedAt: now,
          error: "queue-timeout",
        })
        .where(and(eq(workAssignments.status, "queued"), lt(workAssignments.queueDeadline, now)))
        .returning();

      return rows.map(mapAssignmentRowToCore);
    },

    async claimQueuedAssignmentsForWorker(input) {
      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(workAssignments)
          .where(
            and(
              eq(workAssignments.workerId, input.workerId),
              eq(workAssignments.status, "queued"),
              gt(workAssignments.queueDeadline, input.now),
            ),
          )
          .orderBy(asc(workAssignments.queuedAt));

        if (rows.length === 0) {
          return [];
        }

        const claimed: CoreWorkAssignment[] = [];
        for (const row of rows) {
          const [updated] = await tx
            .update(workAssignments)
            .set({
              status: "assigned",
              assignedAt: input.now,
            })
            .where(and(eq(workAssignments.id, row.id), eq(workAssignments.status, "queued")))
            .returning();

          if (updated) {
            claimed.push(mapAssignmentRowToCore(updated));
          }
        }

        return claimed;
      });
    },
  };
}

export class WorkerDispatcher {
  private readonly db = getDb();
  private readonly core = createCoreDispatcher();
  private readonly dispatcherDb = createWorkerDispatcherDb(this.db);

  async enqueue(
    worker: WorkerRecord,
    workflowRef: WorkerWorkflowRef,
    runId: string,
    workspaceId: string,
    options?: { maxQueueWaitMs?: number },
  ): Promise<WorkAssignmentRecord> {
    // TODO: Worker-side concurrency remains the effective limiter in v4; workers still default to concurrency=1.
    const assignment = await this.core.enqueue(
      this.dispatcherDb,
      mapWorkerToCore(worker),
      workflowRef,
      runId,
      workspaceId,
      { maxQueueWaitMs: options?.maxQueueWaitMs },
    );

    return mapWorkAssignment(assignment);
  }

  async ack(workerId: string, runId: string): Promise<WorkAssignmentRecord | null> {
    const assignment = await this.core.ack(this.dispatcherDb, workerId, runId);
    return assignment ? mapWorkAssignment(assignment) : null;
  }

  async reportStatus(
    workerId: string,
    runId: string,
    phase: "running" | "completed" | "failed",
    detail: AssignmentStatusDetail,
  ): Promise<WorkAssignmentRecord | null> {
    const assignment = await this.core.reportStatus(this.dispatcherDb, workerId, runId, phase, {
      exitCode: detail.exitCode,
      durationMs: detail.durationMs,
      summary: detail.summary,
      error: detail.error,
    });

    if (!assignment) {
      return null;
    }

    if (detail.result && phase !== "running") {
      const [row] = await this.db
        .update(workAssignments)
        .set({
          result: detail.result,
        })
        .where(
          and(
            eq(workAssignments.workerId, workerId),
            eq(workAssignments.runId, runId),
          ),
        )
        .returning();

      return row ? mapWorkAssignment(row) : mapWorkAssignment(assignment);
    }

    return mapWorkAssignment(assignment);
  }

  async pollQueueForWorker(workerId: string): Promise<WorkAssignmentRecord[]> {
    const assignments = await this.core.pollQueueForWorker(this.dispatcherDb, workerId);
    return assignments.map(mapWorkAssignment);
  }

  async reapTimeouts(): Promise<number> {
    // TODO: Timeout reaping exists, but production still needs a scheduler to invoke it.
    return this.core.reapTimeouts(this.dispatcherDb);
  }
}
