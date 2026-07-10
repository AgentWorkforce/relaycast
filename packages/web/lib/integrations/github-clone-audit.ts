import { logger } from "../logger";
import type {
  GithubCloneJobRequest,
  GithubCloneJobRow,
} from "@cloud/core/clone/github-clone-job.js";

export interface GithubCloneAuditEntry {
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  httpStatus: number;
  outcome:
    | "ok"
    | "unauthorized"
    | "forbidden"
    | "not_found"
    | "upstream_error"
    | "bad_request"
    | "partial_failure";
  filesWritten: number;
  durationMs: number;
  errorCount: number;
}

type GithubCloneAuditJob = Pick<GithubCloneJobRow, "id" | "status"> &
  Partial<
    Pick<
      GithubCloneJobRow,
      | "workspaceId"
      | "owner"
      | "repo"
      | "ref"
      | "attempts"
      | "completedAt"
      | "lastError"
    >
  >;

function audit(event: string, payload: Record<string, unknown>): void {
  console.info(event, payload);
}

function sanitizeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "unknown_error";
}

function basePayload(job: GithubCloneAuditJob, request?: GithubCloneJobRequest) {
  return {
    jobId: job.id,
    workspaceId: job.workspaceId ?? request?.workspaceId ?? "(unknown)",
    owner: job.owner ?? request?.owner ?? "(unknown)",
    repo: job.repo ?? request?.repo ?? "(unknown)",
    ref: job.ref ?? request?.ref ?? "HEAD",
  };
}

export function auditGithubCloneEnqueued(
  job: GithubCloneAuditJob,
  request?: GithubCloneJobRequest,
): void {
  audit("github_clone_enqueued", basePayload(job, request));
}

export function auditGithubCloneStarted(job: GithubCloneAuditJob): void {
  audit("github_clone_started", {
    ...basePayload(job),
    attempts: job.attempts ?? null,
  });
}

export function auditGithubCloneCompleted(job: GithubCloneAuditJob): void {
  audit("github_clone_completed", {
    ...basePayload(job),
    attempts: job.attempts ?? null,
    completedAt: job.completedAt?.toISOString() ?? null,
  });
}

export function auditGithubCloneFailed(
  job: GithubCloneAuditJob,
  error: unknown,
  request?: GithubCloneJobRequest,
): void {
  console.warn("github_clone_failed", {
    ...basePayload(job, request),
    attempts: job.attempts ?? null,
    error: sanitizeError(error),
    completedAt: job.completedAt?.toISOString() ?? null,
  });
}

export function getGithubCloneAuditErrorMessage(error: unknown): string {
  return sanitizeError(error);
}

export function recordGithubCloneCall(entry: GithubCloneAuditEntry): void {
  const context = {
    area: "github-clone",
    route: "/api/v1/github/clone",
    workspaceId: entry.workspaceId,
    owner: entry.owner,
    repo: entry.repo,
    ref: entry.ref,
    httpStatus: entry.httpStatus,
    outcome: entry.outcome,
    filesWritten: entry.filesWritten,
    durationMs: entry.durationMs,
    errorCount: entry.errorCount,
  };

  if (entry.outcome === "ok") {
    void logger.info("GitHub clone request completed", context);
    return;
  }

  void logger.warn("GitHub clone request failed", context);
}

export default {
  auditGithubCloneCompleted,
  auditGithubCloneEnqueued,
  auditGithubCloneFailed,
  auditGithubCloneStarted,
  getGithubCloneAuditErrorMessage,
  recordGithubCloneCall,
};
