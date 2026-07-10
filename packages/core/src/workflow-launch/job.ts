import type { EncryptedEnvelope } from "../auth/credential-encryption.js";

// Registered workflow launches can spend up to 25 minutes materializing a
// Relayfile-backed GitHub clone before the implementation/review work and PR
// handoff. Keep the single-flight lease above that full path so a live launch
// does not get reclaimed and failed as a duplicate while its sandbox is still
// working.
export const WORKFLOW_LAUNCH_JOB_LEASE_MS = 40 * 60 * 1000;
export const WORKFLOW_LAUNCH_JOB_MAX_ATTEMPTS = 3;

export type WorkflowLaunchJobStatus =
  | "queued"
  | "launching"
  | "launched"
  | "failed";

export type WorkflowLaunchRequestEnvelope = EncryptedEnvelope;

export interface WorkflowLaunchJobRequest {
  runId: string;
  userId: string;
  workspaceId: string;
  organizationId: string;
  requestEnvelope: WorkflowLaunchRequestEnvelope;
}

export interface EnqueueWorkflowLaunchJobPayload {
  jobId: string;
  runId: string;
}

export interface WorkflowLaunchJobRow extends WorkflowLaunchJobRequest {
  id: string;
  status: WorkflowLaunchJobStatus;
  attempts: number;
  leaseUntil: Date | null;
  sandboxId: string | null;
  relayWorkspaceId: string | null;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
