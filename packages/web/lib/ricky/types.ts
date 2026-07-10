import type { WorkflowFileType } from "@/lib/workflows";

export type RickyRunStatus =
  | "pending"
  | "launching_original"
  | "monitoring"
  | "diagnosing"
  | "selecting_repair_agent"
  | "repairing"
  | "awaiting_human_gate"
  | "launching_rerun"
  | "succeeded"
  | "exhausted"
  | "failed"
  | "human_denied"
  | "canceled";

export type RickyAttemptStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled"
  | "repairing"
  | "awaiting_human_gate";

export type RickyRepairMode =
  | "workforce_persona"
  | "subscription_agent"
  | "ricky_openrouter"
  | "deterministic"
  | "human_gate"
  | "none";

export type RepairMode = RickyRepairMode;
export type RickyCli = "claude" | "opencode" | "codex";
export type SubscriptionAgentAvailability = AgentAvailability["subscriptionAgents"][number];
export type AutoFixPolicy = Partial<RickyAutoFixPolicy>;

export type RickyGateStatus = "open" | "approved" | "denied" | "edited" | "expired" | "canceled";

export type HumanGateType =
  | "missing_credentials"
  | "missing_secret"
  | "approval_required"
  | "ambiguous_repair"
  | "cost_over_budget"
  | "unsafe_patch"
  | "max_attempts_reached"
  | "missing_agent_capacity";

export type WorkflowRuntimeDescriptor = {
  id: string;
  config?: unknown;
};

export type RickyAutoFixPolicy = {
  enabled: boolean;
  maxAttempts: number;
  preferWorkforcePersona: boolean;
  allowOpenRouterFallback: boolean;
  requireHumanApprovalFor: Array<
    | "repo_mutation"
    | "external_side_effect"
    | "credential_change"
    | "ambiguous_repair"
    | "cost_over_budget"
  >;
};

export type CreateRickyRunRequest = {
  workflow: string;
  fileType: WorkflowFileType;
  sourceFileType?: WorkflowFileType;
  workflowPath?: string;
  s3CodeKey?: string;
  runtime?: WorkflowRuntimeDescriptor;
  envSecrets?: Record<string, string>;
  autoFix?: Partial<RickyAutoFixPolicy>;
  notification?: {
    surface?: "none" | "webhook" | "slack";
    webhookUrl?: string;
  };
};

export type RickyLaunchMetadata = {
  RICKY_RUN_ID: string;
  RICKY_ATTEMPT: string;
  RICKY_REPAIR_MODE: RickyRepairMode;
};

export type AgentAvailability = {
  checkedAt: string;
  workspaceId: string;
  userId: string;
  requestedClis: string[];
  subscriptionAgents: Array<{
    cli: "claude" | "opencode" | "codex";
    provider: "anthropic" | "opencode" | "openai";
    source: "cloud_agents" | "cli_credentials" | "worker";
    status: "usable" | "expired" | "missing" | "unhealthy" | "unsupported";
    credentialExpiresAt?: string;
    lastAuthenticatedAt?: string;
    reason?: string;
  }>;
  workforcePersona?: {
    status: "usable" | "missing" | "unmatched" | "unhealthy";
    personaId?: string;
    tier?: string;
    harness?: string;
    model?: string;
    selectedIntent?: string;
    reason?: string;
  };
  openRouterFallback: {
    status: "usable" | "missing" | "disabled" | "unhealthy";
    provider: "openrouter";
    model: string;
    reason?: string;
  };
};

export type WorkflowRunEvidence = {
  schemaVersion: 1;
  capturedAt: string;
  rickyRunId: string;
  attempt: number;
  workflowRun: {
    runId: string;
    status: string;
    result?: unknown;
    error?: string;
    fileType: WorkflowFileType;
    workflow: string;
    sandboxId: string | null;
    relayWorkspaceId?: string;
  };
  retry: {
    attempt?: number;
    previousRunId?: string;
    startFrom?: string;
  };
  steps: Array<{
    stepName: string;
    agent: string;
    preset: string;
    cli: string;
    sandboxId: string;
    startTime: string;
    endTime: string;
    durationMs: number;
    exitCode: number;
    outputSummary: string;
    status?: string;
    error?: string;
  }>;
  events: Array<{
    sequence: number;
    eventType: string;
    stepName?: string;
    sandboxId?: string;
    payload: unknown;
    createdAt: string;
  }>;
  logs: {
    runner?: string;
    stepLogs: Array<{ sandboxId: string; content: string }>;
  };
  patch?: {
    patch: string;
    hasChanges: boolean;
  };
  runtime: {
    id?: string;
    sandboxId: string | null;
    workerAssignmentId?: string;
    relayWorkspaceId?: string;
  };
};

export type RickyDiagnosis = {
  classification:
    | "success"
    | "missing_credentials"
    | "missing_secret"
    | "unsafe_side_effect"
    | "workflow_artifact"
    | "ambiguous"
    | "unknown"
    | (string & {});
  failedStep?: string;
  firstFailedStepId?: string;
  repairHint?: string;
  summary: string;
  repairable: boolean;
  evidenceRefs: string[];
  safety?:
    | "safe_workflow_artifact"
    | "unsafe_patch"
    | "ambiguous_repair"
    | "credential_change"
    | "missing_credentials"
    | "missing_secret"
    | "cost_over_budget"
    | "external_side_effect";
  proposedAction?: {
    file?: string;
    action?: string;
    summary?: string;
    [key: string]: unknown;
  };
};

export type RepairDecision = {
  mode: RickyRepairMode;
  reason: string;
  selectedAgent?: Record<string, unknown>;
  gate?: {
    gateType: HumanGateType;
    prompt: string;
    proposedAction?: unknown;
  };
};

export type HumanGatePayload = NonNullable<RepairDecision["gate"]>;

export type RepairResult = {
  mode: Exclude<RickyRepairMode, "human_gate" | "none">;
  summary: string;
  repairedWorkflow: string;
  digest: string;
  selectedAgent?: Record<string, unknown>;
  safety: {
    isolated: true;
    externalSideEffects: false;
  };
  resumePlan: {
    previousRunId: string;
    startFrom?: string;
  };
};

export type GateResolution =
  | { decision: "approve"; comment?: string }
  | { decision: "deny"; comment?: string }
  | { decision: "edit"; instruction: string; comment?: string };

export type CloudWorkflowRunRow = {
  runId?: string;
  id?: string;
  status: string;
  result?: unknown;
  error?: string | null;
  fileType?: WorkflowFileType;
  workflow?: string;
  workflowPath?: string;
  previousRunId?: string;
  startFrom?: string;
};

export type RickyAttemptRecord = {
  attempt: number;
  workflowRunId: string;
  previousWorkflowRunId?: string;
  startFromStep?: string;
  role: "original" | "repaired_rerun";
  repairMode: RickyRepairMode;
  status: string;
};

export type RickyHumanGateRecord = {
  id: string;
  gateType: HumanGateType;
  status: "open";
  prompt: string;
  proposedAction?: unknown;
};

export const RICKY_TERMINAL_STATUSES: ReadonlySet<RickyRunStatus> = new Set([
  "succeeded",
  "exhausted",
  "failed",
  "human_denied",
  "canceled",
]);

export const WORKFLOW_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);
