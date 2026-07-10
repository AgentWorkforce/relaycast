import { parseAndRedactJson, redactForRicky, redactText } from "./redaction";
import { buildWorkflowRunEvidenceFromRows as buildEvidenceFromRows } from "./evidence-builder-rows";
import type { WorkflowRunEvidence } from "./types";

const WORKFLOW_TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "canceled"]);

async function readS3Text(key: string): Promise<string | undefined> {
  const { createWorkflowStorageS3Client, readWorkflowStorageBucket } = await import("@/lib/storage");
  const bucket = readWorkflowStorageBucket();
  if (!bucket) return undefined;

  const [{ GetObjectCommand }] = await Promise.all([
    import("@aws-sdk/client-s3"),
  ]);
  const s3 = createWorkflowStorageS3Client();

  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!response.Body) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return undefined;
  }
}

function buildFallbackRunnerLog(
  run: {
    runId: string;
    status: string;
    sandboxId: string | null;
    error?: string;
  },
): string {
  return redactText(
    [
      `run_id=${run.runId}`,
      `workflow_status=${run.status}`,
      `orchestrator_sandbox=${run.sandboxId}`,
      run.error ?? "Runner log stream is not available.",
    ].join("\n") + "\n",
  );
}

function buildFallbackStepLog(step: WorkflowRunEvidence["steps"][number]): string {
  const lines = [
    `[${step.agent}] ${step.stepName}`,
    `preset=${step.preset} cli=${step.cli} sandbox=${step.sandboxId}`,
    step.outputSummary,
    `exit_code=${step.exitCode}`,
    step.error ? `ERROR: ${step.error}` : undefined,
  ];
  return redactText(`${lines.filter(Boolean).join("\n")}\n`);
}

export async function buildWorkflowRunEvidence(input: {
  rickyRunId: string;
  attempt: number;
  workflowRunId: string;
  previousRunId?: string;
  startFrom?: string;
  runtime?: {
    id?: string;
  };
}): Promise<WorkflowRunEvidence> {
  const [{ eq }, { getDb }, { sessionEvents, workAssignments }, { workflowStore }] = await Promise.all([
    import("drizzle-orm"),
    import("@/lib/db"),
    import("@/lib/db/schema"),
    import("@/lib/workflows"),
  ]);
  const run = await workflowStore.get(input.workflowRunId);
  if (!run) {
    throw new Error(`Workflow run not found: ${input.workflowRunId}`);
  }

  const db = getDb();
  const [steps, eventRows, assignmentRows] = await Promise.all([
    workflowStore.listSteps(input.workflowRunId),
    db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.runId, input.workflowRunId))
      .orderBy(sessionEvents.sequence),
    db
      .select()
      .from(workAssignments)
      .where(eq(workAssignments.runId, input.workflowRunId))
      .limit(1)
      .catch(() => []),
  ]);

  const runnerLog = await readS3Text(`${run.userId}/${input.workflowRunId}/runner.log`);
  const stepLogs = await Promise.all(
    [...new Set(steps.map((step) => step.sandboxId).filter(Boolean))].map(async (sandboxId) => {
      const content = await readS3Text(`${run.userId}/${input.workflowRunId}/${sandboxId}/agent.log`);
      const fallbackStep = steps.find((step) => step.sandboxId === sandboxId);
      return {
        sandboxId,
        content: content ?? (fallbackStep ? buildFallbackStepLog(fallbackStep) : ""),
      };
    }),
  );
  const patchText = await readS3Text(`${run.userId}/${input.workflowRunId}/changes.patch`);

  const { evidence } = await buildEvidenceFromRows({
    rickyRunId: input.rickyRunId,
    attempt: input.attempt,
    run: {
      runId: run.runId,
      status: run.status,
      result: run.result,
      error: run.error,
      fileType: run.fileType,
      workflow: run.workflow,
      sandboxId: run.sandboxId,
      relayWorkspaceId: run.relayWorkspaceId,
    },
    previousRunId: input.previousRunId,
    startFrom: input.startFrom,
    steps,
    events: eventRows.map((event) => ({
      sequence: event.sequence,
      eventType: event.eventType,
      stepName: event.stepName ?? undefined,
      sandboxId: event.sandboxId ?? undefined,
      payload: parseAndRedactJson(event.payload),
      createdAt: event.createdAt.toISOString(),
    })),
    logs: {
      runner: runnerLog ?? buildFallbackRunnerLog(run),
      stepLogs: stepLogs.filter((entry) => entry.content.length > 0),
    },
    patch: patchText !== undefined || WORKFLOW_TERMINAL_STATUSES.has(run.status)
      ? {
          patch: patchText ?? "",
          hasChanges: (patchText ?? "").trim().length > 0,
        }
      : undefined,
    runtime: {
      id: input.runtime?.id,
      sandboxId: run.sandboxId,
      workerAssignmentId: assignmentRows[0]?.id,
      relayWorkspaceId: run.relayWorkspaceId,
    },
  });

  return evidence;
}

export async function buildWorkflowRunEvidenceFromRows(input: {
  rickyRunId: string;
  attempt: number;
  run: {
    runId: string;
    status: string;
    result?: unknown;
    error?: string;
    fileType: WorkflowRunEvidence["workflowRun"]["fileType"];
    workflow: string;
    sandboxId?: string | null;
    relayWorkspaceId?: string;
  };
  previousRunId?: string;
  startFrom?: string;
  steps?: WorkflowRunEvidence["steps"];
  events?: WorkflowRunEvidence["events"];
  logs?: WorkflowRunEvidence["logs"];
  patch?: WorkflowRunEvidence["patch"];
  runtime?: WorkflowRunEvidence["runtime"];
  capturedAt?: string;
  snapshotStore?: {
    put(input: {
      rickyRunId: string;
      attempt: number;
      workflowRunId: string;
      content: string;
      digest: string;
    }): Promise<{ objectKey: string }>;
  };
}): Promise<{
  evidence: WorkflowRunEvidence;
  snapshotRef?: {
    objectKey: string;
    digest: string;
    sizeBytes: number;
  };
}> {
  return buildEvidenceFromRows(input);
}

// The Daytona runner emits "[bootstrap] Mounted credentials for ..." lines
// before the workflow starts. They are operational chatter, not failure
// signals — and naive substring matching against "credential" used to
// hard-classify every Daytona-launched failure as `missing_credentials`,
// short-circuiting the repair-router. Strip those lines before classifying.
function stripBootstrapNoise(runnerLog: string): string {
  return runnerLog
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("[bootstrap]"))
    .join("\n");
}

// Credential-failure detection requires an actual failure context. A bare
// mention of "auth" or "credential" elsewhere in the log (paths, package
// names, normal SDK chatter) must not flip the classifier.
const CREDENTIAL_FAILURE_PATTERNS: RegExp[] = [
  /\b(401|403)\b/,
  /\bunauthorized\b/,
  /\bforbidden\b/,
  /authentication\s+(failed|denied|error|required)/,
  /(invalid|expired|missing|revoked|rejected|unable to (refresh|verify|obtain)).{0,40}(credential|token|api[ -]?key|bearer|secret)/,
  /(credential|token|api[ -]?key|bearer).{0,40}(invalid|expired|missing|revoked|rejected|denied|not provided)/,
  /permission denied/,
];

export function diagnoseEvidence(evidence: WorkflowRunEvidence) {
  const failedStep = evidence.steps.find((step) => step.exitCode !== 0 || step.error)?.stepName;

  if (evidence.workflowRun.status === "completed") {
    return {
      classification: "success" as const,
      failedStep,
      summary: "Workflow run completed.",
      repairable: false,
      evidenceRefs: ["workflowRun.status"],
    };
  }

  const filteredRunnerLog = stripBootstrapNoise(evidence.logs.runner ?? "");
  const text = [
    evidence.workflowRun.error ?? "",
    evidence.workflowRun.result ? JSON.stringify(evidence.workflowRun.result) : "",
    evidence.steps.map((step) => `${step.stepName} ${step.error ?? ""} ${step.outputSummary}`).join("\n"),
    filteredRunnerLog,
  ].join("\n").toLowerCase();

  if (CREDENTIAL_FAILURE_PATTERNS.some((pattern) => pattern.test(text))) {
    return {
      classification: "missing_credentials" as const,
      failedStep,
      summary: "The run appears blocked on missing or unusable credentials.",
      repairable: false,
      evidenceRefs: ["workflowRun.error", "steps"],
    };
  }

  if (/missing.*secret|secret.*missing|env var|environment variable/.test(text)) {
    return {
      classification: "missing_secret" as const,
      failedStep,
      summary: "The run appears blocked on a missing required environment secret.",
      repairable: false,
      evidenceRefs: ["workflowRun.error", "logs"],
    };
  }

  if (/deploy|push|production|delete repository|destructive/.test(text)) {
    return {
      classification: "unsafe_side_effect" as const,
      failedStep,
      summary: "The failure may require a repo mutation or external side effect.",
      repairable: false,
      evidenceRefs: ["steps", "logs"],
    };
  }

  if (/syntax|parse|workflow|artifact|step|dependency|path|not found|no such file/.test(text)) {
    return {
      classification: "workflow_artifact" as const,
      failedStep,
      summary: "The failure looks repairable by changing the isolated workflow artifact.",
      repairable: true,
      evidenceRefs: ["workflowRun.workflow", "steps", "events"],
    };
  }

  return {
    classification: "ambiguous" as const,
    failedStep,
    summary: "Ricky could not identify one deterministic repair path from the available cloud evidence.",
    repairable: true,
    evidenceRefs: ["workflowRun", "steps", "events"],
  };
}
