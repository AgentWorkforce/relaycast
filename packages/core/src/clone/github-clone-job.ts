export const GITHUB_CLONE_JOB_DEDUPE_TTL_MS = 30 * 60 * 1000;

export type GithubCloneJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

// Distinguishes the existing tarball-based pipeline from the webhook-driven
// incremental sync. `full` is the default and matches pre-existing behavior;
// `incremental` requires `baseSha` to be set on the request (see executor for
// the diverged/truncated fallback semantics).
export type GithubCloneMode = "full" | "incremental";

export interface GithubCloneJobRequest {
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  connectionId: string;
  mode?: GithubCloneMode;
  // Required when mode === 'incremental'; ignored otherwise.
  baseSha?: string | null;
}

export type GithubCloneMaterialization =
  | {
      mode: "relayfile_export";
      headSha: string;
      filesExpected: number | null;
      sentinelPath: string;
      contentRoot: string;
      exportParams: {
        format: "tar";
        decode: "github-working-tree";
        gzip: false;
      };
    }
  | {
      mode: "local_archive";
      headSha: string;
      filesExpected: number | null;
      archiveUrl: string;
      stripComponents: number;
      expiresAt: string | null;
    };

export interface EnqueueGithubCloneJobPayload {
  jobId: string;
  request: GithubCloneJobRequest;
}

export interface GithubCloneCompletion {
  filesWritten?: number | null;
  headSha?: string | null;
  durationMs?: number | null;
  completedAt?: Date;
  materialization?: GithubCloneMaterialization | null;
}

export interface GithubCloneJobRow extends GithubCloneJobRequest {
  id: string;
  status: GithubCloneJobStatus;
  mode: GithubCloneMode;
  attempts: number;
  filesWritten: number | null;
  headSha: string | null;
  baseSha: string | null;
  durationMs: number | null;
  materializationJson: GithubCloneMaterialization | null;
  lastError: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
