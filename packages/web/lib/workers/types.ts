export type WorkerStatus = "pending" | "online" | "offline" | "revoked";

export type AssignmentStatus =
  | "queued"
  | "assigned"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

export type WorkerSelection = {
  workerId?: string;
  name?: string;
  tags?: string[];
};

export type RuntimeDescriptor = {
  id: string;
  config?: WorkerSelection | null;
};

export type WorkerHostInfo = Record<string, unknown>;

export type WorkerRecord = {
  id: string;
  workspaceId: string;
  name: string;
  displayName: string;
  hostInfo: WorkerHostInfo;
  status: WorkerStatus;
  lastSeen: string | null;
  registeredAt: string;
  registeredBy: string;
  tags: string[];
};

export type WorkerWorkflowPayload = {
  runId: string;
  workspaceId: string;
  relayWorkspaceId: string;
  relaycastApiKey: string;
  /**
   * Relaycast base URL the `relaycastApiKey` was minted against. Workers
   * must target this when registering agents via `mcp-args --register`,
   * otherwise the minted key is rejected by the wrong backend. Optional
   * for backward-compat with in-flight payloads; workers should default
   * to https://api.relaycast.dev when absent.
   */
  relaycastBaseUrl?: string;
  relayfileUrl: string;
  relayfileToken: string;
  workflow: string;
  fileType: "yaml" | "ts" | "py";
  sourceFileType: "yaml" | "ts" | "py" | "workflow";
  workflowFileName: string;
  envSecrets?: Record<string, string>;
  metadata?: Record<string, string>;
  s3CodeKey?: string;
  /**
   * Multi-repo workflows: per-repo mount coordinates. Workers download each
   * tarball into `/workspace/<name>/` and the bootstrap mounts them in
   * parallel. May coexist with `s3CodeKey` for hybrid runs.
   */
  paths?: Array<{
    name: string;
    s3CodeKey: string;
    repoOwner?: string;
    repoName?: string;
  }>;
  resumeRunId?: string;
  startFrom?: string;
  previousRunId?: string;
};

export type WorkerWorkflowRef = {
  type: "inline" | "url";
  value: string;
};

export type WorkAssignmentRecord = {
  id: string;
  workspaceId: string;
  workerId: string | null;
  runId: string;
  workflowRef: WorkerWorkflowRef;
  status: AssignmentStatus;
  queuedAt: string;
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  queueDeadline: string;
  result?: Record<string, unknown>;
  error?: string;
};

export type WorkerBusEvent =
  | {
      type: "assignment";
      assignment: WorkAssignmentRecord;
    }
  | {
      type: "timeout";
      assignment: WorkAssignmentRecord;
    }
  | {
      type: "revoke";
      workerId: string;
    };

export type AssignmentStatusDetail = {
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
  result?: Record<string, unknown>;
};
