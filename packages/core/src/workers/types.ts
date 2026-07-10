export type WorkerStatus = "pending" | "online" | "offline" | "revoked";

export type WorkAssignmentStatus =
  | "queued"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

export interface WorkerHostInfo {
  [key: string]: unknown;
  os?: string;
  arch?: string;
  agentRelayVersion?: string;
}

export interface WorkerRecord {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  status: WorkerStatus;
  lastSeen: Date | null;
  hostInfo: WorkerHostInfo;
  tags: string[];
}

export interface WorkerSelection {
  workerId?: string;
  name?: string;
  tags?: string[];
}

export interface DispatchOptions {
  maxQueueWaitMs?: number;
  envSecrets?: Record<string, string>;
}

export interface WorkflowRef {
  [key: string]: unknown;
  type: "url" | "inline";
  value: string;
}

export interface WorkAssignmentResult {
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  [key: string]: unknown;
}

export interface WorkAssignment {
  id: string;
  workspaceId: string;
  workerId: string | null;
  runId: string;
  workflowRef: WorkflowRef;
  status: WorkAssignmentStatus;
  queuedAt: Date;
  assignedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  queueDeadline: Date;
  result?: WorkAssignmentResult;
  error?: string;
  envSecrets?: Record<string, string>;
}

export interface NewWorkerRow {
  id?: string;
  workspaceId: string;
  name: string;
  displayName: string;
  status?: WorkerStatus;
  lastSeen?: Date | null;
  hostInfo?: WorkerHostInfo;
  tags?: string[];
}

export interface RegisterWorkerRecord extends NewWorkerRow {
  tokenHash: Uint8Array;
}

export interface WorkerTokenRecord {
  workerId: string;
  tokenHash: Uint8Array;
  worker: WorkerRecord;
}

export interface UpdateWorkerStatusInput {
  workerId: string;
  status: Extract<WorkerStatus, "online" | "offline">;
  lastSeen?: Date | null;
}

export interface CreateAssignmentInput {
  id?: string;
  workspaceId: string;
  workerId: string;
  runId: string;
  workflowRef: WorkflowRef;
  status: WorkAssignmentStatus;
  queuedAt: Date;
  assignedAt?: Date | null;
  queueDeadline: Date;
  envSecrets?: Record<string, string>;
}

export interface WorkAssignmentLookup {
  workerId: string;
  runId: string;
}

export type WorkAssignmentPhase = "started" | "running" | "completed" | "failed";

export interface WorkAssignmentPhaseDetail {
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
  result?: WorkAssignmentResult;
}

export interface ClaimQueuedAssignmentsInput {
  workerId: string;
  now: Date;
}

export interface RequeueStaleAssignedAssignmentsInput {
  now: Date;
  assignedBefore: Date;
}

export interface FailRunningAssignmentsForOfflineWorkersInput {
  now: Date;
  lastSeenBefore: Date;
}

export interface ReportAssignmentStatusInput extends WorkAssignmentLookup {
  phase: WorkAssignmentPhase;
  detail?: WorkAssignmentPhaseDetail;
  at: Date;
}

export interface WorkerRegistryDb {
  registerWorker(input: RegisterWorkerRecord): Promise<WorkerRecord>;
  findWorkerByName(workspaceId: string, name: string): Promise<WorkerRecord | null>;
  findWorkerById(workerId: string): Promise<WorkerRecord | null>;
  listWorkersByWorkspace(workspaceId: string): Promise<WorkerRecord[]>;
  updateWorkerStatus(input: UpdateWorkerStatusInput): Promise<void>;
  revokeWorker(workerId: string): Promise<void>;
  getWorkerToken(workerId: string): Promise<WorkerTokenRecord | null>;
}

export interface WorkerDispatcherDb extends WorkerRegistryDb {
  createAssignment(input: CreateAssignmentInput): Promise<WorkAssignment>;
  markAssignmentAssigned(
    input: WorkAssignmentLookup & { assignedAt: Date },
  ): Promise<WorkAssignment | null>;
  acknowledgeAssignment(
    input: WorkAssignmentLookup & { acknowledgedAt: Date },
  ): Promise<WorkAssignment | null>;
  reportAssignmentStatus(input: ReportAssignmentStatusInput): Promise<WorkAssignment | null>;
  timeoutQueuedAssignments(now: Date): Promise<WorkAssignment[]>;
  // Adapters should claim queued rows in `queued_at ASC` order and must enforce
  // `status = "queued"` with `queue_deadline > now` before claiming rows.
  // `WorkerDispatcher.pollQueueForWorker()` keeps a second post-claim filter as a defensive guard.
  claimQueuedAssignmentsForWorker(input: ClaimQueuedAssignmentsInput): Promise<WorkAssignment[]>;
  requeueStaleAssignedAssignments?(
    input: RequeueStaleAssignedAssignmentsInput,
  ): Promise<WorkAssignment[]>;
  failRunningAssignmentsForOfflineWorkers?(
    input: FailRunningAssignmentsForOfflineWorkersInput,
  ): Promise<WorkAssignment[]>;
}

export interface WorkerMaintenanceSweepOptions {
  ackTimeoutMs?: number;
  disconnectedGraceMs?: number;
}

export interface WorkerMaintenanceSweepResult {
  timedOutAssignments: WorkAssignment[];
  requeuedAssignments: WorkAssignment[];
  failedAssignments: WorkAssignment[];
}

export interface AssignmentAvailableEvent {
  type: "assignment";
  assignment: WorkAssignment;
}

export interface AssignmentTimeoutEvent {
  type: "timeout";
  assignment: WorkAssignment;
}

export type AssignmentBusEvent = AssignmentAvailableEvent | AssignmentTimeoutEvent;

export type AssignmentBusListener = (event: AssignmentBusEvent) => void | Promise<void>;

export interface AssignmentBus {
  subscribe(workerId: string, listener: AssignmentBusListener): () => void;
  publish(workerId: string, event: AssignmentBusEvent): Promise<void>;
}
