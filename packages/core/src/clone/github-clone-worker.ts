import type { Context, SQSHandler, SQSRecord } from "aws-lambda";
import { getDb } from "../db.js";
import {
  markGithubCloneJobCompleted,
  markGithubCloneJobFailed,
  markGithubCloneJobRunning,
  markGithubCloneJobRetrying,
} from "./github-clone-job-store.js";
import type {
  EnqueueGithubCloneJobPayload,
  GithubCloneJobRequest,
} from "./github-clone-job.js";
import {
  executeGithubClone as defaultExecuteGithubClone,
  type GithubCloneExecutionDeps,
  type GithubCloneExecutionResult,
} from "./github-clone-executor.js";
import { getErrorStatus } from "./github-clone-stage-error.js";

type QueueRecord = {
  body: string;
  attributes?: {
    ApproximateReceiveCount?: string;
  };
};

type WorkerContext = {
  db: unknown;
  env?: Record<string, string | undefined>;
  executeGithubClone?: (
    deps: GithubCloneExecutionDeps,
    request: GithubCloneJobRequest,
  ) => Promise<GithubCloneExecutionResult>;
};

export const handler: SQSHandler = async (event, context) => {
  await processGithubCloneQueueEvent(event.Records, {
    db: getDb(),
    env: process.env,
    lambdaContext: context,
  });
};

export async function processGithubCloneQueueEvent(
  records: SQSRecord[],
  context: WorkerContext & { lambdaContext?: Context },
): Promise<void> {
  for (const record of records) {
    await processGithubCloneQueueRecord(record, context);
  }
}

export async function processGithubCloneQueueRecord(
  record: QueueRecord,
  context: WorkerContext,
): Promise<void> {
  const payload = parsePayload(record.body);
  const receiveCount = positiveInt(
    record.attributes?.ApproximateReceiveCount,
    1,
  );
  console.log("[gate-b-resolver-diag] github-clone-worker-start", {
    jobId: payload.jobId,
    status: "running",
    workspaceId: payload.request.workspaceId,
    mode: payload.request.mode ?? "full",
    receiveCount,
  });

  await markGithubCloneJobRunning(context.db, payload.jobId);

  try {
    const result = await resolveExecutor(context)(buildExecutionDeps(context, payload), payload.request);
    await markGithubCloneJobCompleted(context.db, payload.jobId, result);
    console.log("[gate-b-resolver-diag] github-clone-worker-completed", {
      jobId: payload.jobId,
      status: "completed",
      workspaceId: payload.request.workspaceId,
      mode: payload.request.mode ?? "full",
      receiveCount,
      filesWritten: result.filesWritten ?? null,
      materializationMode: result.materialization?.mode ?? null,
    });
  } catch (error) {
    const message = toErrorMessage(error);
    const terminal = isTerminalGithubCloneError(error);
    const finalAttempt = isFinalQueueAttempt(record, context);
    console.error("[gate-b-resolver-diag] github-clone-worker-error", {
      jobId: payload.jobId,
      status: terminal || finalAttempt ? "failed" : "retrying",
      workspaceId: payload.request.workspaceId,
      mode: payload.request.mode ?? "full",
      receiveCount,
      terminal,
      finalAttempt,
    });
    if (terminal || finalAttempt) {
      await markGithubCloneJobFailed(context.db, payload.jobId, message);
      if (!terminal) {
        throw error;
      }
      return;
    }

    await markGithubCloneJobRetrying(context.db, payload.jobId, message);
    throw error;
  }
}

function parsePayload(body: string): EnqueueGithubCloneJobPayload {
  const payload = JSON.parse(body) as Partial<EnqueueGithubCloneJobPayload>;

  if (!payload.jobId || !payload.request) {
    throw new Error("Invalid GitHub clone queue payload");
  }

  return payload as EnqueueGithubCloneJobPayload;
}

function resolveExecutor(
  context: WorkerContext,
): (
  deps: GithubCloneExecutionDeps,
  request: GithubCloneJobRequest,
) => Promise<GithubCloneExecutionResult> {
  return context.executeGithubClone ?? defaultExecuteGithubClone;
}

function buildExecutionDeps(
  context: WorkerContext,
  payload: EnqueueGithubCloneJobPayload,
): GithubCloneExecutionDeps {
  return {
    db: context.db,
    jobId: payload.jobId,
    request: payload.request,
    workspaceId: payload.request.workspaceId,
    env: { ...context.env },
  };
}

function isTerminalGithubCloneError(error: unknown): boolean {
  const status = getErrorStatus(error);
  return status === 401 || status === 404;
}

function isFinalQueueAttempt(record: QueueRecord, context: WorkerContext): boolean {
  const receiveCount = positiveInt(
    record.attributes?.ApproximateReceiveCount,
    1,
  );
  const maxAttempts = positiveInt(
    context.env?.GITHUB_CLONE_QUEUE_MAX_RECEIVE_COUNT,
    3,
  );
  return receiveCount >= maxAttempts;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "GitHub clone worker failed";
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
