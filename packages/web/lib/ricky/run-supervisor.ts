import type { NextRequest } from "next/server";
import type { RequestAuth } from "@/lib/auth/request-auth";
import { uploadIsolatedRepairedSourceArchive } from "./artifact-store";
import { resolveAgentAvailability } from "./agent-availability";
import { buildWorkflowRunEvidence, diagnoseEvidence } from "./evidence-builder";
import { routeRepair, buildRepairResult } from "./repair-router";
import { redactText } from "./redaction";
import type { RickyRunRecord } from "./run-store";
import type {
  CreateRickyRunRequest,
  GateResolution,
  AgentAvailability,
  CloudWorkflowRunRow,
  RickyAutoFixPolicy,
  RickyDiagnosis,
  HumanGateType,
  RickyLaunchMetadata,
  RickyRepairMode,
  RickyRunStatus,
} from "./types";
import { RICKY_TERMINAL_STATUSES, WORKFLOW_TERMINAL_STATUSES } from "./types";

const DEFAULT_POLICY: RickyAutoFixPolicy = {
  enabled: true,
  maxAttempts: 3,
  preferWorkforcePersona: true,
  allowOpenRouterFallback: true,
  requireHumanApprovalFor: [],
};

const APPROVAL_REASONS = new Set<RickyAutoFixPolicy["requireHumanApprovalFor"][number]>([
  "repo_mutation",
  "external_side_effect",
  "credential_change",
  "ambiguous_repair",
  "cost_over_budget",
]);

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_WORKFLOW_ENV_KEYS = new Set([
  "RUN_ID", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN",
  "S3_BUCKET", "S3_PREFIX", "S3_CODE_KEY", "RELAY_API_KEY", "RELAY_WORKSPACE_ID",
  "USER_ID", "CLOUD_API_URL", "CLOUD_API_ACCESS_TOKEN", "CLOUD_API_REFRESH_TOKEN",
  "CLOUD_API_ACCESS_TOKEN_EXPIRES_AT", "AWS_REGION", "CALLBACK_URL", "CALLBACK_TOKEN",
  "WORKFLOW_CONFIG", "CLI_CREDENTIALS", "WORKFLOW_FILE", "INTERACTIVE",
  "RESUME_RUN_ID", "START_FROM", "PREVIOUS_RUN_ID",
  "RELAY_BROKER_API_KEY", "RELAY_BROKER_API_PORT",
  "RELAYFILE_URL", "RELAYFILE_TOKEN", "RELAYFILE_WORKSPACE", "RELAYFILE_WORKSPACE_ID",
  "RELAY_LLM_PROXY", "RELAY_LLM_PROXY_URL", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL",
  "GOOGLE_API_BASE", "OPENAI_API_BASE", "CREDENTIAL_PROXY_TOKEN", "RELAY_LLM_PROXY_TOKEN",
  "DAYTONA_API_KEY", "DAYTONA_JWT_TOKEN", "DAYTONA_ORGANIZATION_ID", "SANDBOX_ID",
  "CREDENTIAL_PROXY_URL", "CREDENTIAL_PROXY_TOKENS",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_API_BASE",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY", "GOOGLE_API_BASE",
]);

export function normalizeAutoFixPolicy(input: CreateRickyRunRequest["autoFix"]): RickyAutoFixPolicy {
  const raw = input as Record<string, unknown> | undefined;
  const requestedMaxAttempts = Number(raw?.maxAttempts);
  const maxAttempts = Number.isFinite(requestedMaxAttempts)
    ? Math.max(1, Math.min(Math.trunc(requestedMaxAttempts), 5))
    : DEFAULT_POLICY.maxAttempts;
  const requireHumanApprovalFor = Array.isArray(raw?.requireHumanApprovalFor)
    ? raw.requireHumanApprovalFor.filter((reason): reason is RickyAutoFixPolicy["requireHumanApprovalFor"][number] =>
        APPROVAL_REASONS.has(reason as RickyAutoFixPolicy["requireHumanApprovalFor"][number]),
      )
    : DEFAULT_POLICY.requireHumanApprovalFor;
  return {
    enabled: typeof raw?.enabled === "boolean" ? raw.enabled : DEFAULT_POLICY.enabled,
    maxAttempts,
    preferWorkforcePersona:
      typeof raw?.preferWorkforcePersona === "boolean"
        ? raw.preferWorkforcePersona
        : DEFAULT_POLICY.preferWorkforcePersona,
    allowOpenRouterFallback:
      typeof raw?.allowOpenRouterFallback === "boolean"
        ? raw.allowOpenRouterFallback
        : DEFAULT_POLICY.allowOpenRouterFallback,
    requireHumanApprovalFor,
  };
}

function normalizeWorkflowPathParam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.includes("\\") || trimmed.startsWith("/")) return null;
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.trim() === "..")) return null;
  return trimmed;
}

function isValidEnvStringMap(value: unknown): value is Record<string, string> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string") &&
    Object.keys(value).every((key) => ENV_NAME_PATTERN.test(key) && !RESERVED_WORKFLOW_ENV_KEYS.has(key))
  );
}

export function isCreateRickyRunRequest(value: unknown): value is CreateRickyRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<CreateRickyRunRequest>;
  return (
    typeof body.workflow === "string" &&
    body.workflow.trim().length > 0 &&
    typeof body.fileType === "string" &&
    ["yaml", "ts", "py"].includes(body.fileType) &&
    (body.sourceFileType === undefined ||
      (typeof body.sourceFileType === "string" && ["yaml", "ts", "py"].includes(body.sourceFileType))) &&
    (body.workflowPath === undefined || normalizeWorkflowPathParam(body.workflowPath) !== null) &&
    (body.s3CodeKey === undefined || typeof body.s3CodeKey === "string") &&
    (body.envSecrets === undefined || isValidEnvStringMap(body.envSecrets)) &&
    (body.runtime === undefined ||
      (!!body.runtime &&
        typeof body.runtime === "object" &&
        !Array.isArray(body.runtime) &&
        typeof body.runtime.id === "string" &&
        body.runtime.id.trim().length > 0))
  );
}

export function canAccessRickyRun(
  auth: RequestAuth,
  run: Pick<
    RickyRunRecord,
    "userId" | "workspaceId" | "organizationId" | "rootWorkflowRunId" | "activeWorkflowRunId"
  >,
): boolean {
  if (auth.source === "session") {
    const orgWorkspaceIds = new Set(
      (auth.context?.workspaces ?? [])
        .filter((workspace) => workspace.organization_id === run.organizationId)
        .map((workspace) => workspace.id),
    );
    return auth.organizationId === run.organizationId && orgWorkspaceIds.has(run.workspaceId);
  }
  if (auth.runId && auth.runId !== run.rootWorkflowRunId && auth.runId !== run.activeWorkflowRunId) {
    return false;
  }
  return auth.userId === run.userId && auth.workspaceId === run.workspaceId;
}

export function canResolveRickyGate(
  run: Pick<RickyRunRecord, "status"> | null,
  gate: { status: string; rickyRunId: string } | null,
  rickyRunId: string,
): boolean {
  return Boolean(
    run &&
    gate &&
    gate.rickyRunId === rickyRunId &&
    gate.status === "open" &&
    run.status === "awaiting_human_gate",
  );
}

export class RickyRunSupervisor {
  async create(input: {
    request: NextRequest;
    auth: RequestAuth;
    body: CreateRickyRunRequest;
  }) {
    const rickyRunStore = await getRickyRunStore();
    const { launchViaWorkflowRunRoute } = await import("./workflow-launcher");
    const policy = normalizeAutoFixPolicy(input.body.autoFix);
    const rootRunId = crypto.randomUUID();
    const rickyRunId = crypto.randomUUID();

    const launch = await launchViaWorkflowRunRoute({
      request: input.request,
      body: {
        ...input.body,
        runId: rootRunId,
        autoFix: undefined,
        notification: undefined,
        metadata: buildRickyLaunchMetadata(rickyRunId, 1, "none"),
      },
    });

    const run = await rickyRunStore.createRun({
      id: rickyRunId,
      organizationId: input.auth.organizationId,
      workspaceId: input.auth.workspaceId,
      userId: input.auth.userId,
      rootWorkflowRunId: launch.runId,
      activeWorkflowRunId: launch.runId,
      sourceWorkflowPath: input.body.workflowPath,
      sourceFileType: input.body.sourceFileType ?? input.body.fileType,
      runtime: {
        ...(input.body.runtime ?? { id: "daytona" }),
        rickySource: {
          s3CodeKey: input.body.s3CodeKey,
          workflowPath: input.body.workflowPath,
        },
      } as Record<string, unknown>,
      autoFixPolicy: policy,
      maxAttempts: policy.maxAttempts,
    });

    const attempt = await rickyRunStore.createAttempt({
      rickyRunId,
      attempt: 1,
      workflowRunId: launch.runId,
      role: "original",
      repairMode: "none",
      status: launch.status === "pending" ? "pending" : "running",
    });

    await rickyRunStore.appendEvent(rickyRunId, "ricky.started", { policy });
    await rickyRunStore.appendEvent(rickyRunId, "workflow.launched", {
      workflowRunId: launch.runId,
      attempt: 1,
      role: "original",
      status: launch.status,
      sandboxId: launch.sandboxId,
      assignmentId: launch.assignmentId,
    });

    return {
      rickyRunId,
      rootRunId: launch.runId,
      status: run.status === "monitoring" ? "running" : run.status,
      monitorUrl: `/dashboard/workflow/${launch.runId}`,
      attempts: [
        {
          attempt: attempt.attempt,
          workflowRunId: attempt.workflowRunId,
          role: attempt.role,
          status: attempt.status,
        },
      ],
    };
  }

  async getDetail(id: string) {
    const rickyRunStore = await getRickyRunStore();
    const run = await rickyRunStore.getRun(id);
    if (!run) return null;
    const [attempts, gates, events] = await Promise.all([
      rickyRunStore.listAttempts(id),
      rickyRunStore.listGates(id),
      rickyRunStore.listEvents(id),
    ]);
    return {
      ...run,
      attempts,
      gates,
      events,
    };
  }

  async advance(id: string, request?: NextRequest): Promise<RickyRunRecord | null> {
    const rickyRunStore = await getRickyRunStore();
    const { workflowStore } = await import("@/lib/workflows");
    const { launchViaWorkflowRunRoute } = await import("./workflow-launcher");
    const run = await rickyRunStore.getRun(id);
    if (!run || RICKY_TERMINAL_STATUSES.has(run.status) || run.status === "awaiting_human_gate") {
      return run;
    }

    const attempt = await rickyRunStore.getAttemptByNumber(id, run.currentAttempt);
    if (!attempt) {
      return this.failRun(run, "Active Ricky attempt record is missing.");
    }

    const workflowRun = await workflowStore.get(attempt.workflowRunId);
    if (!workflowRun) {
      return this.failRun(run, `Workflow run not found: ${attempt.workflowRunId}`);
    }

    if (!WORKFLOW_TERMINAL_STATUSES.has(workflowRun.status)) {
      const status = workflowRun.status === "pending" ? "pending" : "running";
      await rickyRunStore.updateAttempt(attempt.id, { status });
      return rickyRunStore.updateRun(id, { status: "monitoring" });
    }

    await rickyRunStore.appendEvent(id, "workflow.terminal", {
      workflowRunId: workflowRun.runId,
      status: workflowRun.status,
      attempt: attempt.attempt,
    });

    if (workflowRun.status === "completed") {
      await rickyRunStore.updateAttempt(attempt.id, {
        status: "succeeded",
        completedAt: new Date(),
      });
      await rickyRunStore.appendEvent(id, "ricky.completed", {
        status: "succeeded",
        workflowRunId: workflowRun.runId,
      });
      return rickyRunStore.updateRun(id, {
        status: "succeeded",
        finalResult: {
          outcome: "succeeded",
          workflowRunId: workflowRun.runId,
          attempt: attempt.attempt,
        },
        completedAt: new Date(),
      });
    }

    if (!run.autoFixPolicy.enabled) {
      await rickyRunStore.updateAttempt(attempt.id, {
        status: "failed",
        error: workflowRun.error ?? "Workflow failed and auto-fix is disabled.",
        completedAt: new Date(),
      });
      return this.failRun(run, "Workflow failed and Ricky auto-fix is disabled.");
    }

    await rickyRunStore.updateRun(id, { status: "diagnosing" });
    const evidence = await buildWorkflowRunEvidence({
      rickyRunId: id,
      attempt: attempt.attempt,
      workflowRunId: workflowRun.runId,
      previousRunId: attempt.previousWorkflowRunId,
      startFrom: attempt.startFromStep,
      runtime: run.runtime as { id?: string } | undefined,
    });
    const diagnosis = diagnoseEvidence(evidence);
    await rickyRunStore.updateAttempt(attempt.id, {
      status: "failed",
      evidenceSnapshot: evidence as unknown as Record<string, unknown>,
      diagnosis,
      completedAt: new Date(),
    });
    await rickyRunStore.updateRun(id, {
      latestDiagnosis: diagnosis,
    });
    await rickyRunStore.appendEvent(id, "diagnosis.completed", {
      diagnosis,
      attempt: attempt.attempt,
    });

    await rickyRunStore.updateRun(id, { status: "selecting_repair_agent" });
    const availability = await resolveAgentAvailability({
      userId: run.userId,
      workspaceId: run.workspaceId,
      workflow: evidence.workflowRun.workflow,
      fileType: evidence.workflowRun.fileType,
      runtime: run.runtime as { id: string; config?: unknown } | undefined,
      policy: run.autoFixPolicy,
    });
    await rickyRunStore.appendEvent(id, "agent.availability.resolved", { availability });

    const source = readAttemptSource(run, attempt);
    const repairWorkflowPath = source.workflowPath ?? run.sourceWorkflowPath;
    const gateContext = await readResolvedGateContext({
      rickyRunStore,
      rickyRunId: id,
      attemptId: attempt.id,
      workflowRunId: workflowRun.runId,
    });
    const diagnosisForRepair = applyHumanGateInstruction(diagnosis, gateContext.humanInstruction);

    const decision = routeRepair({
      diagnosis: diagnosisForRepair,
      availability,
      policy: run.autoFixPolicy,
      attempt: attempt.attempt,
      maxAttempts: run.maxAttempts,
      sourceWorkflowPath: repairWorkflowPath,
      s3CodeKey: source.s3CodeKey,
      approvedGateTypes: gateContext.approvedGateTypes,
      humanInstruction: gateContext.humanInstruction,
    });
    if (gateContext.approvedGateTypes.length > 0) {
      await rickyRunStore.appendEvent(id, "gate.honored", {
        approvedGateTypes: gateContext.approvedGateTypes,
        hasHumanInstruction: Boolean(gateContext.humanInstruction),
      });
    }

    if (decision.mode === "human_gate" && decision.gate) {
      const gate = await rickyRunStore.createGate({
        rickyRunId: id,
        attemptId: attempt.id,
        workflowRunId: workflowRun.runId,
        gateType: decision.gate.gateType,
        reason: decision.reason,
        prompt: decision.gate.prompt,
        proposedAction: decision.gate.proposedAction as Record<string, unknown> | undefined,
        requestedByAgent: decision.selectedAgent,
      });
      await rickyRunStore.updateAttempt(attempt.id, {
        status: "awaiting_human_gate",
        repairMode: "human_gate",
        repairAgent: decision.selectedAgent ?? null,
      });
      await rickyRunStore.appendEvent(id, "gate.opened", {
        gateId: gate.id,
        gateType: gate.gateType,
        reason: gate.reason,
      });
      if (decision.gate.gateType === "max_attempts_reached") {
        await rickyRunStore.updateAttempt(attempt.id, {
          status: "failed",
          error: "Ricky reached the configured maximum number of attempts.",
          completedAt: new Date(),
        });
        await rickyRunStore.appendEvent(id, "ricky.completed", {
          status: "exhausted",
          gateId: gate.id,
          maxAttempts: run.maxAttempts,
        });
        return rickyRunStore.updateRun(id, {
          status: "exhausted",
          selectedAgent: decision.selectedAgent ?? null,
          finalResult: {
            outcome: "exhausted",
            gateId: gate.id,
            maxAttempts: run.maxAttempts,
          },
          completedAt: new Date(),
        });
      }
      return rickyRunStore.updateRun(id, {
        status: "awaiting_human_gate",
        selectedAgent: decision.selectedAgent ?? null,
      });
    }

    await rickyRunStore.updateRun(id, {
      status: "repairing",
      selectedAgent: decision.selectedAgent ?? null,
    });
    await rickyRunStore.appendEvent(id, "repair.started", {
      mode: decision.mode,
      reason: decision.reason,
      selectedAgent: decision.selectedAgent,
    });

    const repair = await buildRepairResult({
      mode: decision.mode as Exclude<typeof decision.mode, "human_gate" | "none">,
      decision,
      evidence,
      diagnosis: diagnosisForRepair,
      humanInstruction: gateContext.humanInstruction,
    });
    await rickyRunStore.updateAttempt(attempt.id, {
      repairMode: repair.mode,
      repairAgent: repair.selectedAgent ?? null,
      repairSummary: repair.summary,
      repairedWorkflowPath: repairWorkflowPath,
      repairedWorkflowDigest: repair.digest,
      repairedArtifact: {
        kind: "inline_workflow",
        digest: repair.digest,
        safety: repair.safety,
        resumePlan: repair.resumePlan,
      },
    });
    await rickyRunStore.appendEvent(id, "repair.completed", {
      mode: repair.mode,
      summary: repair.summary,
      digest: repair.digest,
      safety: repair.safety,
    });

    if (!request) {
      return this.failRun(
        run,
        "Ricky repair was prepared but no request context was available to relaunch through /api/v1/workflows/run.",
      );
    }

    const nextAttemptNumber = attempt.attempt + 1;
    const nextRunId = crypto.randomUUID();
    let launchS3CodeKey: string | undefined;
    let launchWorkflowPath: string | undefined;
    let repairedArtifact: Record<string, unknown> = {
      kind: "inline_workflow",
      digest: repair.digest,
    };

    if (source.s3CodeKey && repairWorkflowPath) {
      const isolated = await uploadIsolatedRepairedSourceArchive({
        userId: run.userId,
        sourceRunId: source.sourceRunId,
        sourceS3CodeKey: source.s3CodeKey,
        targetRunId: nextRunId,
        workflowPath: repairWorkflowPath,
        repairedWorkflow: repair.repairedWorkflow,
      });
      launchS3CodeKey = isolated.s3CodeKey;
      launchWorkflowPath = repairWorkflowPath;
      repairedArtifact = {
        kind: "source_sync_archive",
        sourceRunId: source.sourceRunId,
        sourceS3CodeKey: source.s3CodeKey,
        targetRunId: nextRunId,
        s3CodeKey: isolated.s3CodeKey,
        objectKey: isolated.objectKey,
        digest: isolated.digest,
        workflowPath: repairWorkflowPath,
        safety: repair.safety,
        resumePlan: repair.resumePlan,
      };
      await rickyRunStore.updateAttempt(attempt.id, {
        repairedWorkflowDigest: isolated.digest,
        repairedArtifact,
      });
    }

    await rickyRunStore.updateRun(id, { status: "launching_rerun" });
    const launch = await launchViaWorkflowRunRoute({
      request,
      body: {
        runId: nextRunId,
        workflow: repair.repairedWorkflow,
        fileType: evidence.workflowRun.fileType,
        sourceFileType: evidence.workflowRun.fileType,
        runtime: run.runtime as { id: string; config?: unknown } | undefined,
        s3CodeKey: launchS3CodeKey,
        workflowPath: launchWorkflowPath,
        previousRunId: repair.resumePlan.previousRunId,
        startFrom: repair.resumePlan.startFrom,
        metadata: buildRickyLaunchMetadata(id, nextAttemptNumber, repair.mode),
      },
    });

    const nextAttempt = await rickyRunStore.createAttempt({
      rickyRunId: id,
      attempt: nextAttemptNumber,
      workflowRunId: launch.runId,
      previousWorkflowRunId: repair.resumePlan.previousRunId,
      startFromStep: repair.resumePlan.startFrom,
      role: "repaired_rerun",
      repairMode: repair.mode,
      repairAgent: repair.selectedAgent,
      repairSummary: repair.summary,
      repairedWorkflowPath: repairWorkflowPath,
      repairedWorkflowDigest:
        typeof repairedArtifact.digest === "string" ? repairedArtifact.digest : repair.digest,
      repairedArtifact,
      status: launch.status === "pending" ? "pending" : "running",
    });
    await rickyRunStore.appendEvent(id, "rerun.launched", {
      workflowRunId: launch.runId,
      previousRunId: repair.resumePlan.previousRunId,
      startFrom: repair.resumePlan.startFrom,
      attempt: nextAttempt.attempt,
      repairMode: repair.mode,
    });

    return rickyRunStore.updateRun(id, {
      status: "monitoring",
      activeWorkflowRunId: launch.runId,
      currentAttempt: nextAttemptNumber,
    });
  }

  async cancel(id: string, request: NextRequest): Promise<RickyRunRecord | null> {
    const rickyRunStore = await getRickyRunStore();
    const { cancelViaWorkflowRunRoute } = await import("./workflow-launcher");
    const run = await rickyRunStore.getRun(id);
    if (!run) return null;
    if (RICKY_TERMINAL_STATUSES.has(run.status)) return run;

    if (run.activeWorkflowRunId) {
      await cancelViaWorkflowRunRoute({ request, runId: run.activeWorkflowRunId }).catch(() => null);
    }

    const attempt = await rickyRunStore.getAttemptByNumber(id, run.currentAttempt);
    if (attempt) {
      await rickyRunStore.updateAttempt(attempt.id, {
        status: "canceled",
        completedAt: new Date(),
      });
    }
    await rickyRunStore.appendEvent(id, "ricky.completed", { status: "canceled" });
    return rickyRunStore.updateRun(id, {
      status: "canceled",
      finalResult: { outcome: "canceled" },
      completedAt: new Date(),
    });
  }

  async resolveGate(input: {
    rickyRunId: string;
    gateId: string;
    auth: RequestAuth;
    resolution: GateResolution;
  }) {
    const rickyRunStore = await getRickyRunStore();
    const gate = await rickyRunStore.getGate(input.gateId);
    const run = await rickyRunStore.getRun(input.rickyRunId);
    if (!gate || !run || !canResolveRickyGate(run, gate, input.rickyRunId)) {
      return null;
    }

    const resolved = await rickyRunStore.resolveGate(input.gateId, input.auth.userId, input.resolution);
    await rickyRunStore.appendEvent(input.rickyRunId, "gate.resolved", {
      gateId: input.gateId,
      decision: input.resolution.decision,
    });

    if (input.resolution.decision === "deny") {
      const attempt = await rickyRunStore.getAttempt(gate.attemptId);
      if (attempt) {
        await rickyRunStore.updateAttempt(attempt.id, {
          status: "failed",
          error: "Human denied Ricky gate.",
          completedAt: new Date(),
        });
      }
      await rickyRunStore.appendEvent(input.rickyRunId, "ricky.completed", { status: "human_denied" });
      await rickyRunStore.updateRun(input.rickyRunId, {
        status: "human_denied",
        finalResult: {
          outcome: "human_denied",
          gateId: input.gateId,
          comment: input.resolution.comment,
        },
        completedAt: new Date(),
      });
      return resolved;
    }

    await rickyRunStore.updateRun(input.rickyRunId, {
      status: "monitoring",
      error: null,
    });
    return resolved;
  }

  private async failRun(run: RickyRunRecord, error: string): Promise<RickyRunRecord> {
    const rickyRunStore = await getRickyRunStore();
    await rickyRunStore.appendEvent(run.id, "ricky.failed", { error });
    return rickyRunStore.updateRun(run.id, {
      status: "failed",
      error,
      finalResult: {
        outcome: "failed",
        error,
      },
      completedAt: new Date(),
    });
  }
}

export const rickyRunSupervisor = new RickyRunSupervisor();

export type WorkflowLaunchInput = {
  workflow: string;
  workflowPath?: string;
  fileType?: string;
  previousRunId?: string;
  startFrom?: string;
  metadata?: Record<string, string>;
};

type RickyLoopInput = {
  rickyRunId: string;
  workflow: string;
  workflowPath?: string;
  fileType: "yaml" | "ts" | "py";
  policy?: Partial<RickyAutoFixPolicy>;
};

type RickyLoopDeps = {
  launchWorkflow(input: WorkflowLaunchInput): Promise<{ runId: string }>;
  waitForTerminal(runId: string): Promise<CloudWorkflowRunRow>;
  buildEvidence(input: { run: CloudWorkflowRunRow; attempt: number }): Promise<unknown>;
  resolveAvailability(input: { run: CloudWorkflowRunRow; attempt: number }): Promise<AgentAvailability>;
  diagnose(input: unknown): Promise<RickyDiagnosis>;
  repair(input: {
    mode: Exclude<RickyRepairMode, "human_gate" | "none">;
    evidence: unknown;
    diagnosis: RickyDiagnosis;
    selectedAgent?: Record<string, unknown>;
  }): Promise<{ workflow: string; workflowPath?: string; summary: string; digest: string }>;
};

export async function runRickyAutoFix(input: RickyLoopInput, deps: RickyLoopDeps) {
  const policy = normalizeAutoFixPolicy(input.policy);
  const attempts: Array<{
    attempt: number;
    workflowRunId: string;
    status: string;
    role: "original" | "repaired_rerun";
    repairMode: RickyRepairMode;
  }> = [];
  const selectedRepairs: Array<{
    mode: Exclude<RickyRepairMode, "human_gate" | "none">;
    selectedAgent?: Record<string, unknown>;
    summary: string;
    digest: string;
  }> = [];
  const gates: Array<{ gateType: string; prompt: string }> = [];

  let rootRunId = "";
  let active = await deps.launchWorkflow({
    workflow: input.workflow,
    workflowPath: input.workflowPath,
    fileType: input.fileType,
    metadata: {
      RICKY_RUN_ID: input.rickyRunId,
      RICKY_ATTEMPT: "1",
      RICKY_REPAIR_MODE: "none",
    },
  });
  rootRunId = active.runId;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const terminal = await deps.waitForTerminal(active.runId);
    const terminalRunId = getCloudWorkflowRunId(terminal);
    const terminalStatus = terminal.status === "succeeded" ? "completed" : terminal.status;
    attempts.push({
      attempt,
      workflowRunId: terminalRunId,
      status: terminalStatus,
      role: attempt === 1 ? "original" : "repaired_rerun",
      repairMode: "none",
    });

    if (terminalStatus === "completed") {
      return {
        status: "succeeded" as const,
        rootRunId,
        activeWorkflowRunId: terminalRunId,
        attempts,
        selectedRepairs,
        gates,
        finalResult: { status: "succeeded", workflowRunId: terminalRunId },
      };
    }

    const evidence = await deps.buildEvidence({ run: terminal, attempt });
    const diagnosis = await deps.diagnose(evidence);
    const availability = await deps.resolveAvailability({ run: terminal, attempt });
    const decision = routeRepair({
      diagnosis,
      availability,
      policy,
      attempt,
      maxAttempts: policy.maxAttempts,
    });

    if (decision.mode === "human_gate" || !decision.gate && attempt >= policy.maxAttempts) {
      if (decision.gate?.gateType === "max_attempts_reached" || attempt >= policy.maxAttempts) {
        return {
          status: "exhausted" as const,
          rootRunId,
          activeWorkflowRunId: terminalRunId,
          attempts,
          selectedRepairs,
          gates,
          finalResult: { status: "exhausted", maxAttempts: policy.maxAttempts },
        };
      }
      gates.push({
        gateType: decision.gate?.gateType ?? "approval_required",
        prompt:
          decision.gate?.prompt ??
          diagnosis.proposedAction?.summary ??
          diagnosis.summary,
      });
      return {
        status: "awaiting_human_gate" as const,
        rootRunId,
        activeWorkflowRunId: terminalRunId,
        attempts,
        selectedRepairs,
        gates,
      };
    }

    const mode = decision.mode as Exclude<RickyRepairMode, "human_gate" | "none">;
    const repaired = await deps.repair({
      mode,
      evidence,
      diagnosis,
      selectedAgent: decision.selectedAgent,
    });
    attempts[attempts.length - 1]!.repairMode = mode;
    selectedRepairs.push({
      mode,
      selectedAgent: decision.selectedAgent,
      summary: repaired.summary,
      digest: repaired.digest,
    });

    active = await deps.launchWorkflow({
      workflow: repaired.workflow,
      workflowPath: repaired.workflowPath ?? input.workflowPath,
      fileType: input.fileType,
      previousRunId: terminalRunId,
      startFrom: diagnosis.failedStep ?? diagnosis.firstFailedStepId,
      metadata: {
        RICKY_RUN_ID: input.rickyRunId,
        RICKY_ATTEMPT: String(attempt + 1),
        RICKY_REPAIR_MODE: mode,
      },
    });
  }

  return {
    status: "exhausted" as const,
    rootRunId,
    activeWorkflowRunId: active.runId,
    attempts,
    selectedRepairs,
    gates,
    finalResult: { status: "exhausted", maxAttempts: policy.maxAttempts },
  };
}

function getCloudWorkflowRunId(run: CloudWorkflowRunRow): string {
  const runId = run.runId ?? run.id;
  if (!runId) {
    throw new Error("Cloud workflow run row is missing runId.");
  }
  return runId;
}

export default {
  RickyRunSupervisor,
  rickyRunSupervisor,
  runRickyAutoFix,
};

async function getRickyRunStore() {
  return (await import("./run-store")).rickyRunStore;
}

function readRickySource(runtime: unknown): { s3CodeKey?: string; workflowPath?: string } {
  if (!runtime || typeof runtime !== "object") return {};
  const source = (runtime as { rickySource?: unknown }).rickySource;
  if (!source || typeof source !== "object") return {};
  const s3CodeKey = (source as { s3CodeKey?: unknown }).s3CodeKey;
  const workflowPath = (source as { workflowPath?: unknown }).workflowPath;
  return {
    s3CodeKey: typeof s3CodeKey === "string" && s3CodeKey ? s3CodeKey : undefined,
    workflowPath: typeof workflowPath === "string" && workflowPath ? workflowPath : undefined,
  };
}

function readAttemptSource(
  run: RickyRunRecord,
  attempt: {
    workflowRunId: string;
    repairedArtifact?: unknown;
  },
): { s3CodeKey?: string; workflowPath?: string; sourceRunId: string } {
  if (attempt.repairedArtifact && typeof attempt.repairedArtifact === "object") {
    const artifact = attempt.repairedArtifact as {
      kind?: unknown;
      s3CodeKey?: unknown;
      workflowPath?: unknown;
      targetRunId?: unknown;
    };
    if (artifact.kind === "source_sync_archive" && typeof artifact.s3CodeKey === "string") {
      return {
        s3CodeKey: artifact.s3CodeKey,
        workflowPath: typeof artifact.workflowPath === "string" ? artifact.workflowPath : run.sourceWorkflowPath,
        sourceRunId: typeof artifact.targetRunId === "string" ? artifact.targetRunId : attempt.workflowRunId,
      };
    }
  }

  const source = readRickySource(run.runtime);
  return {
    s3CodeKey: source.s3CodeKey,
    workflowPath: source.workflowPath,
    sourceRunId: run.rootWorkflowRunId,
  };
}

async function readResolvedGateContext(input: {
  rickyRunStore: Awaited<ReturnType<typeof getRickyRunStore>>;
  rickyRunId: string;
  attemptId: string;
  workflowRunId: string;
}): Promise<{ approvedGateTypes: HumanGateType[]; humanInstruction?: string }> {
  const gates = await input.rickyRunStore.listGates(input.rickyRunId);
  const resolved = gates
    .filter((gate) => {
      return (
        gate.attemptId === input.attemptId &&
        gate.workflowRunId === input.workflowRunId &&
        (gate.status === "approved" || gate.status === "edited")
      );
    })
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  const approvedGateTypes = [...new Set(resolved.map((gate) => gate.gateType as HumanGateType))];
  const edited = resolved.find((gate) => {
    const resolution = gate.resolution as { decision?: unknown; instruction?: unknown } | undefined;
    return gate.status === "edited" && resolution?.decision === "edit" && typeof resolution.instruction === "string";
  });
  const resolution = edited?.resolution as { instruction?: string } | undefined;
  const humanInstruction = resolution?.instruction ? redactText(resolution.instruction) : undefined;

  return { approvedGateTypes, humanInstruction };
}

function applyHumanGateInstruction(
  diagnosis: RickyDiagnosis,
  humanInstruction?: string,
): RickyDiagnosis {
  if (!humanInstruction) return diagnosis;
  const safeInstruction = redactText(humanInstruction);
  return {
    ...diagnosis,
    repairHint: [diagnosis.repairHint, `Human edit instruction: ${safeInstruction}`]
      .filter(Boolean)
      .join("\n"),
    proposedAction: {
      ...(diagnosis.proposedAction ?? {}),
      summary: [diagnosis.proposedAction?.summary, `Human edit instruction: ${safeInstruction}`]
        .filter(Boolean)
        .join(" "),
    },
  };
}

export function buildRickyLaunchMetadata(
  rickyRunId: string,
  attempt: number,
  repairMode: RickyRepairMode,
): RickyLaunchMetadata {
  return {
    RICKY_RUN_ID: rickyRunId,
    RICKY_ATTEMPT: String(attempt),
    RICKY_REPAIR_MODE: repairMode,
  };
}
