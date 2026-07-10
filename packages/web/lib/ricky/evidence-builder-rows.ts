import { createHash } from "node:crypto";
import { redactForRicky, redactText } from "./redaction";
import type { WorkflowRunEvidence } from "./types";

function truncate(value: string, maxBytes = 64 * 1024): string {
  const redacted = redactText(value);
  if (Buffer.byteLength(redacted, "utf8") <= maxBytes) {
    return redacted;
  }
  return `${redacted.slice(0, maxBytes)}\n[truncated]`;
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
  const evidence = redactForRicky({
    schemaVersion: 1 as const,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    rickyRunId: input.rickyRunId,
    attempt: input.attempt,
    workflowRun: {
      runId: input.run.runId,
      status: input.run.status,
      result: redactForRicky(input.run.result),
      error: input.run.error ? redactText(input.run.error) : undefined,
      fileType: input.run.fileType,
      workflow: redactText(input.run.workflow),
      sandboxId: input.run.sandboxId ?? null,
      relayWorkspaceId: input.run.relayWorkspaceId,
    },
    retry: {
      attempt: input.attempt,
      previousRunId: input.previousRunId,
      startFrom: input.startFrom,
    },
    steps: [...(input.steps ?? [])]
      .sort((left, right) => {
        const timeDelta = Date.parse(left.startTime) - Date.parse(right.startTime);
        return timeDelta === 0 ? left.stepName.localeCompare(right.stepName) : timeDelta;
      })
      .map((step) => ({
        ...step,
        outputSummary: truncate(step.outputSummary, 16 * 1024),
        error: step.error ? truncate(step.error, 16 * 1024) : undefined,
      })),
    events: [...(input.events ?? [])].sort((left, right) => left.sequence - right.sequence),
    logs: input.logs
      ? {
          runner: input.logs.runner ? truncate(input.logs.runner) : undefined,
          stepLogs: input.logs.stepLogs.map((entry) => ({
            sandboxId: entry.sandboxId,
            content: truncate(entry.content),
          })),
        }
      : { stepLogs: [] },
    patch: input.patch
      ? {
          patch: truncate(input.patch.patch),
          hasChanges: input.patch.hasChanges,
        }
      : undefined,
    runtime: input.runtime ?? {
      sandboxId: input.run.sandboxId ?? null,
      relayWorkspaceId: input.run.relayWorkspaceId,
    },
  } satisfies WorkflowRunEvidence);

  if (!input.snapshotStore) {
    return { evidence };
  }

  const content = `${JSON.stringify(evidence, null, 2)}\n`;
  const digest = createHash("sha256").update(content).digest("hex");
  const stored = await input.snapshotStore.put({
    rickyRunId: input.rickyRunId,
    attempt: input.attempt,
    workflowRunId: input.run.runId,
    content,
    digest,
  });

  return {
    evidence,
    snapshotRef: {
      objectKey: stored.objectKey,
      digest,
      sizeBytes: Buffer.byteLength(content),
    },
  };
}
