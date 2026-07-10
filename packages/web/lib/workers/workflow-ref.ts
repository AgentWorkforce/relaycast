import type { WorkflowFileType, WorkflowSourceFileType } from "@/lib/workflows";
import type { WorkerWorkflowPayload, WorkerWorkflowRef } from "./types";

function defaultWorkflowFileName(fileType: WorkflowFileType): string {
  switch (fileType) {
    case "ts":
      return "workflow.ts";
    case "py":
      return "workflow.py";
    case "yaml":
      return "workflow.yaml";
  }
}

export function packageWorkflowRef(input: {
  runId: string;
  workspaceId: string;
  relayWorkspaceId: string;
  relaycastApiKey: string;
  relaycastBaseUrl?: string;
  relayfileUrl: string;
  relayfileToken: string;
  workflow: string;
  fileType: WorkflowFileType;
  sourceFileType?: WorkflowSourceFileType;
  workflowFileName?: string;
  envSecrets?: Record<string, string>;
  metadata?: Record<string, string>;
  s3CodeKey?: string;
  paths?: Array<{
    name: string;
    s3CodeKey: string;
    repoOwner?: string;
    repoName?: string;
  }>;
  resumeRunId?: string;
  startFrom?: string;
  previousRunId?: string;
}): WorkerWorkflowRef {
  const payload: WorkerWorkflowPayload = {
    runId: input.runId,
    workspaceId: input.workspaceId,
    relayWorkspaceId: input.relayWorkspaceId,
    relaycastApiKey: input.relaycastApiKey,
    ...(input.relaycastBaseUrl ? { relaycastBaseUrl: input.relaycastBaseUrl } : {}),
    relayfileUrl: input.relayfileUrl,
    relayfileToken: input.relayfileToken,
    workflow: input.workflow,
    fileType: input.fileType,
    sourceFileType: input.sourceFileType ?? input.fileType,
    workflowFileName: input.workflowFileName ?? defaultWorkflowFileName(input.fileType),
    ...(input.envSecrets ? { envSecrets: input.envSecrets } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.s3CodeKey ? { s3CodeKey: input.s3CodeKey } : {}),
    ...(input.paths && input.paths.length > 0 ? { paths: input.paths } : {}),
    ...(input.resumeRunId ? { resumeRunId: input.resumeRunId } : {}),
    ...(input.startFrom ? { startFrom: input.startFrom } : {}),
    ...(input.previousRunId ? { previousRunId: input.previousRunId } : {}),
  };

  return {
    type: "inline",
    value: JSON.stringify(payload),
  };
}
