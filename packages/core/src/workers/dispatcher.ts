import type {
  AssignmentBus,
  AssignmentBusListener,
  DispatchOptions,
  WorkerMaintenanceSweepOptions,
  WorkerMaintenanceSweepResult,
  WorkAssignment,
  WorkAssignmentPhase,
  WorkAssignmentPhaseDetail,
  WorkerDispatcherDb,
  WorkerRecord,
  WorkflowRef,
} from "./types.js";
import { WorkerRegistry } from "./registry.js";

const DEFAULT_MAX_QUEUE_WAIT_MS = 10 * 60 * 1000;
const DEFAULT_ACK_TIMEOUT_MS = 30 * 1000;
const DEFAULT_DISCONNECTED_GRACE_MS = 5 * 60 * 1000;

function isFuture(deadline: Date, now: Date): boolean {
  return deadline.getTime() > now.getTime();
}

function normalizeIdentifier(value: string, fieldName: string): string {
  const normalizedValue = value.trim();
  if (!normalizedValue) {
    throw new Error(`${fieldName} is required`);
  }

  return normalizedValue;
}

function assertPositiveDuration(durationMs: number, fieldName: string): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
}

function compareAssignmentsByQueueOrder(left: WorkAssignment, right: WorkAssignment): number {
  const queuedAtDelta = left.queuedAt.getTime() - right.queuedAt.getTime();
  if (queuedAtDelta !== 0) {
    return queuedAtDelta;
  }

  return left.id.localeCompare(right.id);
}

function normalizeWorkflowRef(workflowRef: WorkflowRef): WorkflowRef {
  if ((workflowRef.type !== "inline" && workflowRef.type !== "url") || !workflowRef.value.trim()) {
    throw new Error("workflowRef must include a non-empty inline or url value");
  }

  return {
    ...workflowRef,
    value: workflowRef.value.trim(),
  };
}

function normalizeDispatchOptions(options: DispatchOptions | undefined): DispatchOptions {
  if (!options) {
    return {};
  }

  return {
    ...options,
    ...(options.envSecrets ? { envSecrets: { ...options.envSecrets } } : {}),
  };
}

function isWorkerDispatcherDb(value: unknown): value is WorkerDispatcherDb {
  const candidate = value as Partial<WorkerDispatcherDb> | null;
  return (
    candidate !== null &&
    candidate !== undefined &&
    typeof candidate === "object" &&
    typeof candidate.createAssignment === "function" &&
    typeof candidate.claimQueuedAssignmentsForWorker === "function"
  );
}

export interface WorkerDispatcherOptions {
  now?: () => Date;
  defaultMaxQueueWaitMs?: number;
  defaultAckTimeoutMs?: number;
  defaultDisconnectedGraceMs?: number;
  registry?: WorkerRegistry;
}

export class WorkerDispatcher {
  private readonly db?: WorkerDispatcherDb;
  private readonly registry: WorkerRegistry;
  private readonly now: () => Date;
  private readonly defaultMaxQueueWaitMs: number;
  private readonly defaultAckTimeoutMs: number;
  private readonly defaultDisconnectedGraceMs: number;

  constructor(db: WorkerDispatcherDb, bus: AssignmentBus, options?: WorkerDispatcherOptions);
  constructor(
    registry: WorkerRegistry,
    bus: AssignmentBus,
    options?: WorkerDispatcherOptions,
  );
  constructor(
    dbOrRegistry: WorkerDispatcherDb | WorkerRegistry,
    private readonly bus: AssignmentBus,
    options: WorkerDispatcherOptions = {},
  ) {
    this.db = isWorkerDispatcherDb(dbOrRegistry) ? dbOrRegistry : undefined;
    this.registry = isWorkerDispatcherDb(dbOrRegistry)
      ? (options.registry ?? new WorkerRegistry())
      : dbOrRegistry;
    this.now = options.now ?? (() => new Date());
    this.defaultMaxQueueWaitMs = options.defaultMaxQueueWaitMs ?? DEFAULT_MAX_QUEUE_WAIT_MS;
    this.defaultAckTimeoutMs = options.defaultAckTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
    this.defaultDisconnectedGraceMs =
      options.defaultDisconnectedGraceMs ?? DEFAULT_DISCONNECTED_GRACE_MS;
  }

  private requireDb(db?: WorkerDispatcherDb): WorkerDispatcherDb {
    if (db) {
      return db;
    }
    if (this.db) {
      return this.db;
    }

    throw new Error("WorkerDispatcherDb is required");
  }

  private async publishTimeoutEvents(assignments: readonly WorkAssignment[]): Promise<void> {
    await Promise.all(
      assignments
        .filter(
          (assignment): assignment is WorkAssignment & { workerId: string } =>
            typeof assignment.workerId === "string",
        )
        .map((assignment) =>
          this.bus.publish(assignment.workerId, {
            type: "timeout",
            assignment,
          }),
        ),
    );
  }

  private async redispatchRequeuedAssignment(
    db: WorkerDispatcherDb,
    assignment: WorkAssignment,
    assignedAt: Date,
  ): Promise<WorkAssignment> {
    if (!assignment.workerId) {
      return assignment;
    }

    const worker = await this.registry.findById(db, assignment.workerId);
    if (!worker || worker.status !== "online") {
      return assignment;
    }

    const redispatchedAssignment = await db.markAssignmentAssigned({
      workerId: assignment.workerId,
      runId: assignment.runId,
      assignedAt,
    });

    if (!redispatchedAssignment) {
      return assignment;
    }

    await this.bus.publish(assignment.workerId, {
      type: "assignment",
      assignment: redispatchedAssignment,
    });

    return redispatchedAssignment;
  }

  subscribe(workerId: string, listener: AssignmentBusListener): () => void {
    return this.bus.subscribe(normalizeIdentifier(workerId, "workerId"), listener);
  }

  async enqueue(
    worker: WorkerRecord,
    workflowRef: WorkflowRef,
    runId: string,
    workspaceId: string,
    options?: DispatchOptions,
  ): Promise<WorkAssignment>;
  async enqueue(
    db: WorkerDispatcherDb,
    worker: WorkerRecord,
    workflowRef: WorkflowRef,
    runId: string,
    workspaceId: string,
    options?: DispatchOptions,
  ): Promise<WorkAssignment>;
  async enqueue(
    dbOrWorker: WorkerDispatcherDb | WorkerRecord,
    workerOrWorkflowRef: WorkerRecord | WorkflowRef,
    workflowRefOrRunId: WorkflowRef | string,
    runIdOrWorkspaceId?: string,
    workspaceIdOrOptions?: string | DispatchOptions,
    maybeOptions: DispatchOptions = {},
  ): Promise<WorkAssignment> {
    const db = isWorkerDispatcherDb(dbOrWorker) ? dbOrWorker : this.requireDb();
    const worker = (isWorkerDispatcherDb(dbOrWorker) ? workerOrWorkflowRef : dbOrWorker) as WorkerRecord;
    const workflowRef = (
      isWorkerDispatcherDb(dbOrWorker) ? workflowRefOrRunId : workerOrWorkflowRef
    ) as WorkflowRef;
    const runId = isWorkerDispatcherDb(dbOrWorker)
      ? runIdOrWorkspaceId
      : (workflowRefOrRunId as string);
    const workspaceId = isWorkerDispatcherDb(dbOrWorker)
      ? (workspaceIdOrOptions as string)
      : runIdOrWorkspaceId;
    const options = normalizeDispatchOptions(
      isWorkerDispatcherDb(dbOrWorker)
        ? maybeOptions
        : (workspaceIdOrOptions as DispatchOptions | undefined),
    );

    if (!runId || !workspaceId) {
      throw new Error("runId and workspaceId are required");
    }

    const normalizedWorkspaceId = normalizeIdentifier(workspaceId, "workspaceId");
    const currentWorker = await this.registry.findById(db, worker.id);
    if (!currentWorker || currentWorker.workspaceId !== normalizedWorkspaceId) {
      throw new Error("Worker not found");
    }
    if (currentWorker.status === "revoked") {
      throw new Error("Worker is revoked");
    }

    const now = this.now();
    const queueWaitMs = options.maxQueueWaitMs ?? this.defaultMaxQueueWaitMs;
    assertPositiveDuration(queueWaitMs, "maxQueueWaitMs");
    const queueDeadline = new Date(now.getTime() + queueWaitMs);

    if (!isFuture(queueDeadline, now)) {
      throw new Error("maxQueueWaitMs must produce a future queue deadline");
    }

    const queuedAssignment = await db.createAssignment({
      workspaceId: normalizedWorkspaceId,
      workerId: currentWorker.id,
      runId: normalizeIdentifier(runId, "runId"),
      workflowRef: normalizeWorkflowRef(workflowRef),
      status: "queued",
      queuedAt: now,
      assignedAt: null,
      queueDeadline,
      envSecrets: options.envSecrets,
    });

    if (currentWorker.status !== "online") {
      return queuedAssignment;
    }

    const assignedAssignment = await db.markAssignmentAssigned({
      workerId: currentWorker.id,
      runId: normalizeIdentifier(runId, "runId"),
      assignedAt: now,
    });

    if (!assignedAssignment) {
      return queuedAssignment;
    }

    await this.bus.publish(currentWorker.id, {
      type: "assignment",
      assignment: assignedAssignment,
    });

    return assignedAssignment;
  }

  async ack(workerId: string, runId: string): Promise<WorkAssignment | null>;
  async ack(
    db: WorkerDispatcherDb,
    workerId: string,
    runId: string,
  ): Promise<WorkAssignment | null>;
  async ack(
    dbOrWorkerId: WorkerDispatcherDb | string,
    workerIdOrRunId: string,
    maybeRunId?: string,
  ): Promise<WorkAssignment | null> {
    const db = isWorkerDispatcherDb(dbOrWorkerId) ? dbOrWorkerId : this.requireDb();
    const workerId = isWorkerDispatcherDb(dbOrWorkerId) ? workerIdOrRunId : dbOrWorkerId;
    const runId = maybeRunId ?? workerIdOrRunId;

    return db.acknowledgeAssignment({
      workerId: normalizeIdentifier(workerId, "workerId"),
      runId: normalizeIdentifier(runId, "runId"),
      acknowledgedAt: this.now(),
    });
  }

  async reportStatus(
    workerId: string,
    runId: string,
    phase: WorkAssignmentPhase,
    detail?: WorkAssignmentPhaseDetail,
  ): Promise<WorkAssignment | null>;
  async reportStatus(
    db: WorkerDispatcherDb,
    workerId: string,
    runId: string,
    phase: WorkAssignmentPhase,
    detail?: WorkAssignmentPhaseDetail,
  ): Promise<WorkAssignment | null>;
  async reportStatus(
    dbOrWorkerId: WorkerDispatcherDb | string,
    workerIdOrRunId: string,
    runIdOrPhase: string | WorkAssignmentPhase,
    phaseOrDetail?: WorkAssignmentPhase | WorkAssignmentPhaseDetail,
    maybeDetail: WorkAssignmentPhaseDetail = {},
  ): Promise<WorkAssignment | null> {
    const db = isWorkerDispatcherDb(dbOrWorkerId) ? dbOrWorkerId : this.requireDb();
    const workerId = isWorkerDispatcherDb(dbOrWorkerId) ? workerIdOrRunId : dbOrWorkerId;
    const runId = isWorkerDispatcherDb(dbOrWorkerId)
      ? (runIdOrPhase as string)
      : workerIdOrRunId;
    const phase = isWorkerDispatcherDb(dbOrWorkerId)
      ? (phaseOrDetail as WorkAssignmentPhase)
      : (runIdOrPhase as WorkAssignmentPhase);
    const detail = isWorkerDispatcherDb(dbOrWorkerId)
      ? maybeDetail
      : ((phaseOrDetail as WorkAssignmentPhaseDetail | undefined) ?? {});

    return db.reportAssignmentStatus({
      workerId: normalizeIdentifier(workerId, "workerId"),
      runId: normalizeIdentifier(runId, "runId"),
      phase,
      detail,
      at: this.now(),
    });
  }

  async revokeWorker(workerId: string): Promise<void>;
  async revokeWorker(db: WorkerDispatcherDb, workerId: string): Promise<void>;
  async revokeWorker(
    dbOrWorkerId: WorkerDispatcherDb | string,
    maybeWorkerId?: string,
  ): Promise<void> {
    const db = isWorkerDispatcherDb(dbOrWorkerId) ? dbOrWorkerId : this.requireDb();
    const workerId = maybeWorkerId ?? (dbOrWorkerId as string);
    await this.registry.revoke(db, workerId);
  }

  async reapTimeouts(): Promise<number>;
  async reapTimeouts(db: WorkerDispatcherDb): Promise<number>;
  async reapTimeouts(db?: WorkerDispatcherDb): Promise<number> {
    const dbHandle = this.requireDb(db);
    const timedOutAssignments = await dbHandle.timeoutQueuedAssignments(this.now());
    await this.publishTimeoutEvents(timedOutAssignments);

    return timedOutAssignments.length;
  }

  async runMaintenanceSweep(
    options?: WorkerMaintenanceSweepOptions,
  ): Promise<WorkerMaintenanceSweepResult>;
  async runMaintenanceSweep(
    db: WorkerDispatcherDb,
    options?: WorkerMaintenanceSweepOptions,
  ): Promise<WorkerMaintenanceSweepResult>;
  async runMaintenanceSweep(
    dbOrOptions?: WorkerDispatcherDb | WorkerMaintenanceSweepOptions,
    maybeOptions: WorkerMaintenanceSweepOptions = {},
  ): Promise<WorkerMaintenanceSweepResult> {
    const dbHandle = isWorkerDispatcherDb(dbOrOptions) ? dbOrOptions : this.requireDb();
    const options = isWorkerDispatcherDb(dbOrOptions)
      ? maybeOptions
      : (dbOrOptions ?? {});
    const now = this.now();

    const ackTimeoutMs = options.ackTimeoutMs ?? this.defaultAckTimeoutMs;
    const disconnectedGraceMs =
      options.disconnectedGraceMs ?? this.defaultDisconnectedGraceMs;
    assertPositiveDuration(ackTimeoutMs, "ackTimeoutMs");
    assertPositiveDuration(disconnectedGraceMs, "disconnectedGraceMs");

    const timedOutAssignments = await dbHandle.timeoutQueuedAssignments(now);
    await this.publishTimeoutEvents(timedOutAssignments);

    // ACK timeout and disconnect failover are control-plane sweeps in v4, not worker-pushed transitions.
    const requeuedAssignments = dbHandle.requeueStaleAssignedAssignments
      ? await Promise.all(
          (
            await dbHandle.requeueStaleAssignedAssignments({
              now,
              assignedBefore: new Date(now.getTime() - ackTimeoutMs),
            })
          ).map((assignment) => this.redispatchRequeuedAssignment(dbHandle, assignment, now)),
        )
      : [];

    const failedAssignments = dbHandle.failRunningAssignmentsForOfflineWorkers
      ? await dbHandle.failRunningAssignmentsForOfflineWorkers({
          now,
          lastSeenBefore: new Date(now.getTime() - disconnectedGraceMs),
        })
      : [];

    return {
      timedOutAssignments,
      requeuedAssignments,
      failedAssignments,
    };
  }

  async pollQueueForWorker(workerId: string): Promise<WorkAssignment[]>;
  async pollQueueForWorker(
    db: WorkerDispatcherDb,
    workerId: string,
  ): Promise<WorkAssignment[]>;
  async pollQueueForWorker(
    dbOrWorkerId: WorkerDispatcherDb | string,
    maybeWorkerId?: string,
  ): Promise<WorkAssignment[]> {
    const dbHandle = isWorkerDispatcherDb(dbOrWorkerId) ? dbOrWorkerId : this.requireDb();
    const workerId = maybeWorkerId ?? (dbOrWorkerId as string);
    const normalizedWorkerId = normalizeIdentifier(workerId, "workerId");
    const worker = await this.registry.findById(dbHandle, normalizedWorkerId);
    if (!worker || worker.status !== "online") {
      return [];
    }

    const now = this.now();
    const assignments = await dbHandle.claimQueuedAssignmentsForWorker({
      workerId: normalizedWorkerId,
      now,
    });

    // Queue adapters should filter `queue_deadline > now` before claiming rows. Keep this as a
    // second guard so callers never serve expired assignments if an adapter or clock drifts.
    return assignments
      .filter((assignment) => isFuture(assignment.queueDeadline, now))
      .sort(compareAssignmentsByQueueOrder);
  }
}
