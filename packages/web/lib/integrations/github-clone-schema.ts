const GITHUB_CLONE_JOB_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
] as const;

export type GithubCloneJobStatus = (typeof GITHUB_CLONE_JOB_STATUSES)[number];
// `connectionId` is optional on the wire so callers (sage, specialist-worker)
// don't need to plumb a Nango connection ID across repos. The route handler
// resolves it from `workspaceIntegrations` when not supplied. After
// resolution the executor still sees it as a required string.
//
// `mode` / `baseSha` are optional and default to a full clone. The webhook
// router (nango-webhook-router.ts handleGitHubForward push-event branch) is
// the only caller today that sets them; the public clone-request route
// continues to enqueue full clones.
export type GithubCloneJobMode = "full" | "incremental";
export type GithubCloneRequestBody = {
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  connectionId: string;
  mode?: GithubCloneJobMode;
  baseSha?: string | null;
};
export type GithubCloneRequestInput = Omit<GithubCloneRequestBody, "ref" | "connectionId"> & {
  ref?: string;
  connectionId?: string;
};
// Parsed shape: ref is always populated (defaulted to "HEAD"), connectionId
// remains optional until the route resolves it from the workspace integration.
export type GithubCloneRequestParsed = Omit<GithubCloneRequestBody, "connectionId"> & {
  connectionId?: string;
};
export type GithubCloneRequest = GithubCloneRequestBody;
export type GithubCloneResponse =
  | {
      ok: true;
      data: {
        filesWritten: number;
        headSha: string;
        durationMs: number;
      };
    }
  | {
      ok: false;
      error: string;
      code:
        | "unauthorized"
        | "forbidden"
        | "not_found"
        | "upstream_error"
        | "bad_request"
        | "partial_failure";
    };

type GithubCloneRequestField = keyof GithubCloneRequestBody;

type GithubCloneRequestSafeParseResult =
  | {
      success: true;
      data: GithubCloneRequestParsed;
    }
  | {
      success: false;
      error: {
        flatten(): {
          fieldErrors: Partial<Record<GithubCloneRequestField, string[]>>;
          formErrors: string[];
        };
      };
    };

export const githubCloneRequestSchema = {
  safeParse(input: unknown): GithubCloneRequestSafeParseResult {
    if (!isRecord(input)) {
      return invalidRequest({
        formErrors: ["Expected an object body"],
      });
    }

    const fieldErrors: Partial<Record<GithubCloneRequestField, string[]>> = {};
    const parsed: Partial<GithubCloneRequestBody> = {};

    // workspaceId / owner / repo are always required from the caller.
    for (const field of ["workspaceId", "owner", "repo"] as const) {
      const value = input[field];
      if (typeof value !== "string" || value.length === 0) {
        fieldErrors[field] = [`${field} is required`];
        continue;
      }
      parsed[field] = value;
    }

    // ref defaults to "HEAD" so callers don't have to know upstream branch
    // names; missing/empty is fine, but a non-string is a contract error.
    const refValue = input["ref"];
    if (refValue === undefined || refValue === "") {
      parsed.ref = "HEAD";
    } else if (typeof refValue === "string") {
      parsed.ref = refValue;
    } else {
      fieldErrors.ref = ["ref must be a string"];
    }

    // connectionId is optional on the wire; the route handler resolves it
    // from workspaceIntegrations when missing. Reject non-string values so
    // we don't accept garbage.
    const connectionIdValue = input["connectionId"];
    if (connectionIdValue === undefined || connectionIdValue === "") {
      // leave parsed.connectionId undefined; route fills it in.
    } else if (typeof connectionIdValue === "string") {
      parsed.connectionId = connectionIdValue;
    } else {
      fieldErrors.connectionId = ["connectionId must be a string"];
    }

    // mode / baseSha are optional. The webhook router passes them when a
    // push event arrives on the default branch with a known prior head;
    // every other caller (sage, specialist-worker, the public clone-request
    // route) leaves them off and falls through to a full clone.
    const modeValue = input["mode"];
    if (modeValue === undefined || modeValue === "") {
      // leave undefined — DB default + executor branch both fall through
      // to the existing full-clone behavior.
    } else if (modeValue === "full" || modeValue === "incremental") {
      parsed.mode = modeValue;
    } else {
      fieldErrors.mode = ["mode must be 'full' or 'incremental'"];
    }

    const baseShaValue = input["baseSha"];
    if (baseShaValue === undefined || baseShaValue === "" || baseShaValue === null) {
      // baseSha is only meaningful for incremental mode; ignore otherwise.
    } else if (typeof baseShaValue === "string") {
      parsed.baseSha = baseShaValue;
    } else {
      fieldErrors.baseSha = ["baseSha must be a string"];
    }

    if (Object.keys(fieldErrors).length > 0) {
      return invalidRequest({ fieldErrors });
    }

    return {
      success: true,
      data: parsed as GithubCloneRequestParsed,
    };
  },
};
export const GithubCloneRequestSchema = githubCloneRequestSchema;

export interface GithubCloneAcceptedResponse {
  ok: true;
  jobId: string;
  status: GithubCloneJobStatus;
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

export interface GithubCloneStatusView {
  id: string;
  jobId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  connectionId: string;
  status: GithubCloneJobStatus;
  mode: GithubCloneJobMode;
  attempts: number;
  filesWritten: number | null;
  headSha: string | null;
  baseSha: string | null;
  durationMs: number | null;
  lastError: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  materialization: GithubCloneMaterialization | null;
}

export interface GithubCloneStatusResponse {
  ok: true;
  jobId: string;
  status: GithubCloneJobStatus;
  attempts: number;
  lastError: string | null;
  completedAt: string | null;
  materialization: GithubCloneMaterialization | null;
  job: GithubCloneStatusView;
}

export interface LegacyGithubCloneJobRecord {
  id: string;
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  connectionId: string;
  status: GithubCloneJobStatus;
  mode: GithubCloneJobMode;
  attempts: number;
  filesWritten: number | null;
  headSha: string | null;
  baseSha: string | null;
  durationMs: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

type LegacyGithubCloneState = {
  jobs: Map<string, LegacyGithubCloneJobRecord>;
};

declare global {
  var __githubCloneLegacyState: LegacyGithubCloneState | undefined;
}

export function isDurableCloneQueueEnabled(): boolean {
  return process.env.USE_DURABLE_CLONE_QUEUE !== "false";
}

export function getLegacyGithubCloneState(): LegacyGithubCloneState {
  if (!globalThis.__githubCloneLegacyState) {
    globalThis.__githubCloneLegacyState = {
      jobs: new Map<string, LegacyGithubCloneJobRecord>(),
    };
  }

  return globalThis.__githubCloneLegacyState;
}

export function createGithubCloneAcceptedResponse(
  jobId: string,
  status: GithubCloneJobStatus | string,
): GithubCloneAcceptedResponse {
  return {
    ok: true,
    jobId,
    status: toGithubCloneJobStatus(status),
  };
}

export function mapGithubCloneStatusJob(
  job: {
    id: string;
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
    connectionId: string;
    status: GithubCloneJobStatus | string;
    mode?: GithubCloneJobMode | string | null;
    attempts: number | null;
    filesWritten?: number | null;
    headSha?: string | null;
    baseSha?: string | null;
    durationMs?: number | null;
    lastError?: string | null;
    createdAt?: Date | string | null;
    updatedAt?: Date | string | null;
    startedAt?: Date | string | null;
    completedAt?: Date | string | null;
    materialization?: GithubCloneMaterialization | null;
    materializationJson?: GithubCloneMaterialization | null;
  },
): GithubCloneStatusView {
  const status = toGithubCloneJobStatus(job.status);
  const headSha = job.headSha ?? null;
  const filesWritten = job.filesWritten ?? null;
  return {
    id: job.id,
    jobId: job.id,
    workspaceId: job.workspaceId,
    owner: job.owner,
    repo: job.repo,
    ref: job.ref,
    connectionId: job.connectionId,
    status,
    mode: toGithubCloneJobMode(job.mode),
    attempts: job.attempts ?? 0,
    filesWritten,
    headSha,
    baseSha: job.baseSha ?? null,
    durationMs: job.durationMs ?? null,
    lastError: job.lastError ?? null,
    createdAt: toIsoString(job.createdAt),
    updatedAt: toIsoString(job.updatedAt),
    startedAt: toIsoString(job.startedAt),
    completedAt: toIsoString(job.completedAt),
    materialization:
      normalizeGithubCloneMaterialization(job.materialization ?? job.materializationJson) ??
      createDefaultMaterialization({
        status,
        mode: toGithubCloneJobMode(job.mode),
        owner: job.owner,
        repo: job.repo,
        headSha,
        filesWritten,
      }),
  };
}

function toGithubCloneJobMode(
  value: GithubCloneJobMode | string | null | undefined,
): GithubCloneJobMode {
  return value === "incremental" ? "incremental" : "full";
}

export function createGithubCloneStatusResponse(
  job: GithubCloneStatusView,
): GithubCloneStatusResponse {
  return {
    ok: true,
    jobId: job.jobId,
    status: job.status,
    attempts: job.attempts,
    lastError: job.lastError,
    completedAt: job.completedAt,
    materialization: job.materialization,
    job,
  };
}

export const githubCloneStatusResponseSchema = {
  parse(value: GithubCloneStatusResponse): GithubCloneStatusResponse {
    return value;
  },
};

export function buildGithubCloneDedupeKey(
  request: Pick<
    GithubCloneRequestBody,
    "workspaceId" | "owner" | "repo" | "ref"
  >,
): string {
  return [
    request.workspaceId,
    request.owner,
    request.repo,
    request.ref,
  ].join(":");
}

function toIsoString(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

function toGithubCloneJobStatus(
  value: GithubCloneJobStatus | string,
): GithubCloneJobStatus {
  return isGithubCloneJobStatus(value) ? value : "failed";
}

function isGithubCloneJobStatus(value: string): value is GithubCloneJobStatus {
  return GITHUB_CLONE_JOB_STATUSES.includes(value as GithubCloneJobStatus);
}

function createDefaultMaterialization(input: {
  status: GithubCloneJobStatus;
  mode: GithubCloneJobMode;
  owner: string;
  repo: string;
  headSha: string | null;
  filesWritten: number | null;
}): GithubCloneMaterialization | null {
  if (input.status !== "completed" || input.mode !== "full" || !input.headSha) {
    return null;
  }
  const contentRoot = githubRepoContentRoot(input.owner, input.repo);
  return {
    mode: "relayfile_export",
    headSha: input.headSha,
    filesExpected: input.filesWritten,
    sentinelPath: `${githubRepoRoot(input.owner, input.repo)}/.relayfile/clone.json`,
    contentRoot,
    exportParams: {
      format: "tar",
      decode: "github-working-tree",
      gzip: false,
    },
  };
}

function normalizeGithubCloneMaterialization(
  value: GithubCloneMaterialization | null | undefined,
): GithubCloneMaterialization | null {
  if (!value) {
    return null;
  }
  if (
    value.mode === "relayfile_export" &&
    typeof value.headSha === "string" &&
    value.headSha.length > 0 &&
    typeof value.contentRoot === "string" &&
    typeof value.sentinelPath === "string"
  ) {
    return {
      ...value,
      filesExpected: normalizeNullableNumber(value.filesExpected),
      exportParams: {
        format: "tar",
        decode: "github-working-tree",
        gzip: false,
      },
    };
  }
  if (
    value.mode === "local_archive" &&
    typeof value.headSha === "string" &&
    value.headSha.length > 0 &&
    typeof value.archiveUrl === "string" &&
    value.archiveUrl.length > 0
  ) {
    return {
      ...value,
      filesExpected: normalizeNullableNumber(value.filesExpected),
      stripComponents: normalizeArchiveStripComponents(value.stripComponents),
      expiresAt: value.expiresAt ?? null,
    };
  }
  return null;
}

function normalizeNullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeArchiveStripComponents(value: number | null | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 1;
}

function githubRepoRoot(owner: string, repo: string): string {
  return `/github/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function githubRepoContentRoot(owner: string, repo: string): string {
  return `${githubRepoRoot(owner, repo)}/contents`;
}

function invalidRequest(input: {
  fieldErrors?: Partial<Record<GithubCloneRequestField, string[]>>;
  formErrors?: string[];
}): GithubCloneRequestSafeParseResult {
  return {
    success: false,
    error: {
      flatten() {
        return {
          fieldErrors: input.fieldErrors ?? {},
          formErrors: input.formErrors ?? [],
        };
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
