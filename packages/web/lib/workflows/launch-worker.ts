import type { SQSHandler, SQSRecord } from "aws-lambda";
import { Resource } from "sst";
import {
  claimWorkflowLaunchJob,
  getWorkflowLaunchJob,
  isWorkflowLaunchJobTerminal,
  markWorkflowLaunchJobFailed,
  markWorkflowLaunchJobLaunched,
  markWorkflowLaunchJobRelayWorkspace,
  markWorkflowLaunchJobSandboxCreated,
  recordWorkflowLaunchJobRetryableFailure,
  releaseWorkflowLaunchJobForRetry,
} from "@cloud/core/workflow-launch/job-store.js";
import {
  WORKFLOW_LAUNCH_JOB_MAX_ATTEMPTS,
  type EnqueueWorkflowLaunchJobPayload,
} from "@cloud/core/workflow-launch/job.js";
import { WorkflowSandboxProvisioningPendingError } from "@cloud/core/bootstrap/launcher.js";
import { getDb } from "../db";
import { workflowStore } from "../workflows";
import { enqueueWorkflowLaunchJob } from "./durable-launch-queue";
import {
  decryptWorkflowLaunchEnvelope,
  type WorkflowLaunchEnvelope,
} from "./launch-job-envelope";
import {
  runWorkflowLaunch,
  WorkflowLaunchError,
} from "./launch-runner";

type QueueRecord = {
  body: string;
};

const LAUNCH_FAILURE_COMMENT_TIMEOUT_MS = 5_000;
const LAUNCH_FAILURE_MESSAGE_MAX_LENGTH = 1_500;
const PROVISIONING_RETRY_DELAY_SECONDS = 60;

type LaunchFailureIssueCommenter = (input: {
  userId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  issueNumber: number;
  body: string;
}) => Promise<unknown>;

export const handler: SQSHandler = async (event) => {
  await processWorkflowLaunchQueueEvent(event.Records);
};

export async function processWorkflowLaunchQueueEvent(
  records: SQSRecord[],
): Promise<void> {
  for (const record of records) {
    await processWorkflowLaunchQueueRecord(record);
  }
}

export async function processWorkflowLaunchQueueRecord(
  record: QueueRecord,
): Promise<void> {
  const payload = parsePayload(record.body);
  const db = getDb();
  const claimed = await claimWorkflowLaunchJob(db, payload.jobId);
  if (!claimed) {
    if (await isWorkflowLaunchJobTerminal(db, payload.jobId)) {
      return;
    }
    const current = await getWorkflowLaunchJob(db, payload.jobId);
    if (await workflowRunHasTerminalSandbox(payload.runId)) {
      if (current?.status === "launching" && isLeaseActive(current.leaseUntil)) {
        throw new Error(`Workflow launch job ${payload.jobId} is already launching`);
      }
      const message =
        "Workflow launch job already recorded a sandbox before completion; refusing duplicate launch";
      await markWorkflowLaunchJobFailed(db, payload.jobId, message);
      await workflowStore.update(payload.runId, {
        status: "failed",
        error: message,
      });
      console.error("[workflow-launch] job already has a sandbox; marked failed", {
        runId: payload.runId,
        jobId: payload.jobId,
        sandboxId: current?.sandboxId ?? null,
        message,
      });
      return;
    }
    throw new Error(`Workflow launch job ${payload.jobId} is not claimable yet`);
  }

  if (claimed.attempts > WORKFLOW_LAUNCH_JOB_MAX_ATTEMPTS) {
    const message = "Workflow launch exhausted retries before sandbox launch completed";
    await markWorkflowLaunchJobFailed(db, claimed.id, message);
    await workflowStore.update(claimed.runId, {
      status: "failed",
      error: message,
    });
    console.error("[workflow-launch] launch job exceeded max attempts", {
      runId: claimed.runId,
      jobId: claimed.id,
      attempts: claimed.attempts,
      message,
    });
    return;
  }

  if (await workflowRunHasTerminalSandbox(claimed.runId)) {
    const message =
      "Workflow launch job already recorded a sandbox before completion; refusing duplicate launch";
    await markWorkflowLaunchJobFailed(db, claimed.id, message);
    await workflowStore.update(claimed.runId, {
      status: "failed",
      error: message,
    });
    console.error("[workflow-launch] claimed job already has a sandbox; marked failed", {
      runId: claimed.runId,
      jobId: claimed.id,
      sandboxId: claimed.sandboxId ?? null,
      message,
    });
    return;
  }

  let sandboxCreated = false;
  let envelope: WorkflowLaunchEnvelope | null = null;
  try {
    envelope = await decryptWorkflowLaunchEnvelope(
      claimed.requestEnvelope,
      Resource.CredentialEncryptionKey.value,
    );
    const result = await runWorkflowLaunch({
      envelope,
      provisioningSandboxId: claimed.sandboxId,
      onSandboxCreated: async (sandboxId) => {
        sandboxCreated = true;
        await markWorkflowLaunchJobSandboxCreated(db, claimed.id, sandboxId);
        await workflowStore.update(claimed.runId, { sandboxId });
      },
    });
    await markWorkflowLaunchJobRelayWorkspace(db, claimed.id, result.relayWorkspaceId);
    await workflowStore.update(claimed.runId, {
      sandboxId: result.sandboxId,
      relayWorkspaceId: result.relayWorkspaceId,
    });
    await markWorkflowLaunchJobLaunched(db, claimed.id, {
      sandboxId: result.sandboxId,
      relayWorkspaceId: result.relayWorkspaceId,
    });
    console.log("[workflow-launch] launch job completed", {
      runId: claimed.runId,
      jobId: claimed.id,
      sandboxId: result.sandboxId,
      relayWorkspaceId: result.relayWorkspaceId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow launch worker failed";
    const terminal =
      error instanceof WorkflowLaunchError
        ? error.kind === "terminal"
        : false;
    const provisioningError = error instanceof WorkflowSandboxProvisioningPendingError ? error : null;
    const provisioningPending = Boolean(provisioningError);
    const exhausted = claimed.attempts >= WORKFLOW_LAUNCH_JOB_MAX_ATTEMPTS;
    const unretryableAfterSandboxCreate =
      !provisioningPending && (sandboxCreated || Boolean(claimed.sandboxId));

    if (provisioningError && !exhausted) {
      await releaseWorkflowLaunchJobForRetry(db, claimed.id, message);
      await enqueueWorkflowLaunchJob(
        { jobId: claimed.id, runId: claimed.runId },
        { delaySeconds: PROVISIONING_RETRY_DELAY_SECONDS },
      );
      console.info("[workflow-launch] sandbox still provisioning; re-enqueued launch poll", {
        runId: claimed.runId,
        jobId: claimed.id,
        attempts: claimed.attempts,
        sandboxId: provisioningError.sandboxId,
        state: provisioningError.state ?? null,
        ageMs: workflowLaunchJobAgeMs(claimed.createdAt),
      });
      return;
    }

    if (terminal || exhausted || unretryableAfterSandboxCreate) {
      await markWorkflowLaunchJobFailed(db, claimed.id, message);
      await workflowStore.update(claimed.runId, {
        status: "failed",
        error: message,
      });
      console.error("[workflow-launch] launch job failed terminally", {
        runId: claimed.runId,
        jobId: claimed.id,
        attempts: claimed.attempts,
        terminal,
        exhausted,
        unretryableAfterSandboxCreate,
        message,
      });
      await commentWorkflowLaunchFailure({
        envelope,
        runId: claimed.runId,
        jobId: claimed.id,
        attempts: claimed.attempts,
        message,
        disposition: "terminal",
        terminal,
        exhausted,
        unretryableAfterSandboxCreate,
      });
      return;
    }

    await recordWorkflowLaunchJobRetryableFailure(db, claimed.id, message);
    console.warn("[workflow-launch] launch job failed retryably", {
      runId: claimed.runId,
      jobId: claimed.id,
      attempts: claimed.attempts,
      message,
    });
    if (claimed.attempts === 1) {
      await commentWorkflowLaunchFailure({
        envelope,
        runId: claimed.runId,
        jobId: claimed.id,
        attempts: claimed.attempts,
        message,
        disposition: "retryable",
        terminal,
        exhausted,
        unretryableAfterSandboxCreate,
      });
    }
    throw error;
  }
}

function parsePayload(body: string): EnqueueWorkflowLaunchJobPayload {
  const payload = JSON.parse(body) as Partial<EnqueueWorkflowLaunchJobPayload>;
  if (!payload.jobId || !payload.runId) {
    throw new Error("Invalid workflow launch queue payload");
  }
  return payload as EnqueueWorkflowLaunchJobPayload;
}

async function workflowRunHasTerminalSandbox(runId: string): Promise<boolean> {
  const run = await workflowStore.get(runId);
  return Boolean(run && ["completed", "failed", "cancelled"].includes(run.status));
}

function workflowLaunchJobAgeMs(createdAt: Date | string | null | undefined): number | null {
  if (!createdAt) return null;
  const value = createdAt instanceof Date ? createdAt.getTime() : Date.parse(createdAt);
  return Number.isFinite(value) ? Date.now() - value : null;
}

function isLeaseActive(leaseUntil: Date | string | null | undefined): boolean {
  if (!leaseUntil) return false;
  const value = leaseUntil instanceof Date ? leaseUntil.getTime() : Date.parse(leaseUntil);
  return Number.isFinite(value) && value > Date.now();
}

async function commentWorkflowLaunchFailure(input: {
  envelope: WorkflowLaunchEnvelope | null;
  runId: string;
  jobId: string;
  attempts: number;
  message: string;
  disposition: "retryable" | "terminal";
  terminal: boolean;
  exhausted: boolean;
  unretryableAfterSandboxCreate: boolean;
}): Promise<void> {
  const issue = input.envelope?.failureNotification?.githubIssue;
  if (!input.envelope || !issue) return;

  const commentBody = [
    "Workflow launch failed before completion.",
    "",
    `Run: \`${input.runId}\``,
    `Launch job: \`${input.jobId}\``,
    `Attempt: ${input.attempts}`,
    `Disposition: ${input.disposition}`,
    `Terminal: ${input.terminal ? "yes" : "no"}`,
    `Retries exhausted: ${input.exhausted ? "yes" : "no"}`,
    `After sandbox create: ${input.unretryableAfterSandboxCreate ? "yes" : "no"}`,
    "",
    "Error:",
    "```",
    truncateLaunchFailureMessage(input.message),
    "```",
  ].join("\n");

  try {
    const createGithubProxyIssueComment =
      await getWorkflowLaunchFailureCommenter();
    await withTimeout(
      createGithubProxyIssueComment({
        userId: input.envelope.workflowOwnerUserId,
        workspaceId: input.envelope.workspaceId,
        owner: issue.owner,
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        body: commentBody,
      }),
      LAUNCH_FAILURE_COMMENT_TIMEOUT_MS,
      `GitHub launch-failure comment timed out after ${LAUNCH_FAILURE_COMMENT_TIMEOUT_MS}ms`,
    );
  } catch (error) {
    console.warn("[workflow-launch] failed to comment launch failure on GitHub issue", {
      runId: input.runId,
      jobId: input.jobId,
      issue: `${issue.owner}/${issue.repo}#${issue.issueNumber}`,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function getWorkflowLaunchFailureCommenter(): Promise<LaunchFailureIssueCommenter> {
  const { createGithubProxyIssueComment } = await import(
    "../integrations/github-proxy-pull-request"
  );
  return createGithubProxyIssueComment;
}

function truncateLaunchFailureMessage(message: string): string {
  if (message.length <= LAUNCH_FAILURE_MESSAGE_MAX_LENGTH) {
    return message;
  }
  return `${message.slice(0, LAUNCH_FAILURE_MESSAGE_MAX_LENGTH)}...`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
