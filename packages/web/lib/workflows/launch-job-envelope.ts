import {
  decryptCredentialAsync,
  encryptCredential,
  encryptCredentialAsync,
  type EncryptedEnvelope,
} from "@cloud/core/auth/credential-encryption.js";

export type WorkflowExecutionMode = "per-step-sandbox" | "shared-sandbox";

export type WorkflowLaunchEnvelope = {
  runId: string;
  callbackToken: string;
  appOrigin: string;
  workflowOwnerUserId: string;
  workflowOwnerOrganizationId: string;
  workspaceId: string;
  rawWorkflow: string;
  workflow: string;
  fileType: "yaml" | "ts" | "py";
  sourceFileType: "yaml" | "ts" | "py" | "workflow";
  normalizedFileType: "yaml" | "typescript" | "python";
  runtime: {
    id: string;
    executionMode: WorkflowExecutionMode;
    config?: unknown;
  };
  s3CodeKey?: string;
  workflowPath?: string;
  envSecrets?: Record<string, string>;
  metadata?: Record<string, string>;
  paths: Array<{
    name: string;
    s3CodeKey: string;
    repoOwner?: string;
    repoName?: string;
    pushBranch?: string;
    pushBase?: string;
    pushPrBody?: string;
  }>;
  resumeRunId?: string;
  startFrom?: string;
  previousRunId?: string;
  runInputs?: Record<string, unknown>;
  githubWrite?: {
    slug: string;
    owner: string;
    repo: string;
    envTokenNames: string[];
    relayfileSponsorId: string;
  };
  failureNotification?: {
    githubIssue?: {
      owner: string;
      repo: string;
      issueNumber: number;
    };
  };
};

export function encryptWorkflowLaunchEnvelope(
  envelope: WorkflowLaunchEnvelope,
  encryptionKey: string,
): EncryptedEnvelope {
  return encryptCredential(JSON.stringify(envelope), encryptionKey);
}

export async function encryptWorkflowLaunchEnvelopeAsync(
  envelope: WorkflowLaunchEnvelope,
  encryptionKey: string,
): Promise<EncryptedEnvelope> {
  return encryptCredentialAsync(JSON.stringify(envelope), encryptionKey);
}

export async function decryptWorkflowLaunchEnvelope(
  envelope: EncryptedEnvelope,
  encryptionKey: string,
): Promise<WorkflowLaunchEnvelope> {
  return JSON.parse(await decryptCredentialAsync(envelope, encryptionKey)) as WorkflowLaunchEnvelope;
}
