import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  cloneSentinelPath,
  hashContent,
  type CloneSentinel,
} from "../overlay-base.js";
import {
  getWorkspaceStub,
  jsonError,
  requireBearerScope,
  requireCorrelationId,
} from "../middleware/auth.js";
import { withWorkspaceWriteAdmission } from "../middleware/workspace-write-admission.js";
import { fetchWorkspaceDOWithBackpressure } from "../workspace-do-backpressure.js";
import {
  githubBaseBlobRef,
  githubBaseManifestRef,
  githubBaseSnapshotsEnabled,
  putGithubBaseManifest,
  readGithubBaseSnapshot,
  upsertGithubBaseSnapshot,
  type GithubBaseSnapshotRow,
  type GithubBaseManifestEntry,
} from "./github-base-snapshot.js";

export const importRoutes = new Hono<AppEnv>();

const GITHUB_CLONE_MAX_FILE_BYTES = 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const GITHUB_CLONE_IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".open-next",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".yarn",
]);
const GITHUB_CLONE_IGNORE_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
]);
const GITHUB_CLONE_IGNORE_EXTS = [".min.js", ".min.css", ".map"] as const;
const GITHUB_CLONE_BINARY_EXTS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".tar",
  ".gz",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".mov",
  ".wasm",
] as const;
const GITHUB_TAR_IMPORT_MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const GITHUB_BASE_IMPORT_CHUNK_ENTRIES_DEFAULT = 750;
const GITHUB_BASE_IMPORT_CHUNK_ENTRIES_MAX = 900;
const GITHUB_BASE_IMPORT_BLOB_PUT_CONCURRENCY_DEFAULT = 16;
const GITHUB_BASE_IMPORT_BLOB_PUT_CONCURRENCY_MAX = 32;

type ImportedFile = {
  path: string;
  contentRef: string;
  contentType: string;
  size: number;
  encoding: "utf-8" | "base64";
  contentHash: string;
};

type SkippedFile = {
  path: string;
  reason: "ignored" | "too-large" | "invalid";
};

type TarEntry = {
  path: string;
  type: string;
  size: number;
  mode: number;
  content: Uint8Array;
};

type GithubBaseImportEntryResult = {
  entry?: GithubBaseManifestEntry;
  skipped?: SkippedFile;
};

type GithubBaseImportPendingResult =
  | {
      order: number;
      imported: GithubBaseImportEntryResult;
    }
  | {
      order: number;
      error: unknown;
    };

type GithubBaseImportPending = {
  order: number;
  promise: Promise<GithubBaseImportPendingResult>;
};

class InvalidTarArchiveError extends Error {}

type FixedLengthStreamInstance = {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
};

type FixedLengthStreamConstructor = new (
  expectedLength: number,
) => FixedLengthStreamInstance;

const GITHUB_TAR_IMPORT_MAX_ERRORS = 50;

type GithubTarImportJobStatus =
  | "queued"
  | "fetching"
  | "importing"
  | "completed"
  | "failed";

type GithubTarImportJobRow = {
  job_id: string;
  workspace_id: string;
  owner: string;
  repo: string;
  ref: string;
  head_sha: string;
  tarball_url: string;
  archive_ref: string | null;
  status: GithubTarImportJobStatus;
  next_entry_index: number;
  imported: number;
  error_count: number;
  errors_json: string;
  skipped_json: string;
  bytes_written: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type GithubTarImportQueueMessage =
  | {
      type: "fetch";
      jobId: string;
      workspaceId: string;
      owner: string;
      repo: string;
      ref: string;
      headSha: string;
      tarballUrl: string;
      githubToken: string;
      correlationId?: string;
    }
  | {
      type: "process";
      jobId: string;
      workspaceId: string;
      startEntryIndex?: number;
      correlationId?: string;
    };

export type GithubTarImportJobSummary = {
  jobId: string;
  workspaceId: string;
  owner: string;
  repo: string;
  ref: string;
  headSha: string;
  status: GithubTarImportJobStatus;
  imported: number;
  errorCount: number;
  errors: Array<{ path: string; code: string; message: string }>;
  skipped: SkippedFile[];
  bytesWritten: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type GithubTarImportFetchStartResult = {
  summary: GithubTarImportJobSummary;
  statusCode: 200 | 202;
  enqueued: boolean;
};

class MissingGithubTokenError extends Error {}
class GithubTarImportQueueUnavailableError extends Error {}

importRoutes.post(
  "/v1/workspaces/:workspaceId/fs/import/github-tarball",
  requireBearerScope("fs:write"),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const owner = c.req.query("owner")?.trim() ?? "";
    const repo = c.req.query("repo")?.trim() ?? "";
    const headSha = c.req.query("headSha")?.trim() ?? "";
    const jobId = c.req.query("jobId")?.trim() || undefined;

    if (!owner || !repo || !headSha) {
      return jsonError(
        c,
        400,
        "bad_request",
        "owner, repo, and headSha are required",
        workspaceId,
      );
    }
    if (!c.req.raw.body) {
      return jsonError(
        c,
        400,
        "bad_request",
        "missing archive body",
        workspaceId,
      );
    }

    try {
      const { files, skipped } = await importGithubTarball(c, {
        workspaceId,
        owner,
        repo,
        headSha,
        archive: c.req.raw.body,
      });
      if (files.length === 0) {
        return c.json({
          imported: 0,
          errorCount: 0,
          errors: [],
          bytesWritten: 0,
          skipped,
        });
      }
      const registered = await withWorkspaceWriteAdmission(
        c,
        workspaceId,
        "github_tarball_import",
        () => registerImportedFiles(c, workspaceId, files, jobId),
      );
      if (!registered.ok) {
        return registered;
      }
      const body = (await registered.json()) as {
        written?: number;
        errorCount?: number;
        errors?: unknown[];
        bytesWritten?: number;
      };
      return c.json({
        imported: body.written ?? 0,
        errorCount: body.errorCount ?? 0,
        errors: body.errors ?? [],
        bytesWritten: body.bytesWritten ?? 0,
        skipped,
      });
    } catch (error) {
      if (error instanceof InvalidTarArchiveError) {
        return jsonError(c, 400, "bad_request", error.message, workspaceId);
      }
      console.error(
        "github tarball import failed",
        error instanceof Error ? error.message : String(error),
      );
      return jsonError(
        c,
        500,
        "internal_error",
        "failed to import GitHub tarball",
        workspaceId,
      );
    }
  },
);

importRoutes.post(
  "/v1/workspaces/:workspaceId/fs/import/github-tarball/fetch",
  requireBearerScope("fs:write"),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const body = (await c.req.json().catch(() => null)) as {
      owner?: unknown;
      repo?: unknown;
      ref?: unknown;
      headSha?: unknown;
      jobId?: unknown;
      tarballUrl?: unknown;
    } | null;
    const owner = readNonEmptyString(body?.owner);
    const repo = readNonEmptyString(body?.repo);
    const ref = readNonEmptyString(body?.ref) ?? "HEAD";
    const headSha = readNonEmptyString(body?.headSha);
    const tarballUrl = readNonEmptyString(body?.tarballUrl);
    const jobId = readNonEmptyString(body?.jobId) ?? crypto.randomUUID();

    if (!owner || !repo || !headSha || !tarballUrl) {
      return jsonError(
        c,
        400,
        "bad_request",
        "owner, repo, headSha, and tarballUrl are required",
        workspaceId,
      );
    }
    if (!isExpectedGithubTarballUrl(tarballUrl, owner, repo)) {
      return jsonError(
        c,
        400,
        "bad_request",
        "tarballUrl must be an api.github.com tarball URL for owner/repo",
        workspaceId,
      );
    }

    try {
      const started = await startGithubTarImportFetch(c.env, {
        jobId,
        workspaceId,
        owner,
        repo,
        ref,
        headSha,
        tarballUrl,
        githubToken: c.req.header("X-GitHub-Token")?.trim(),
        correlationId: c.req.header("X-Correlation-Id")?.trim(),
      });
      return c.json(started.summary, started.statusCode);
    } catch (error) {
      if (error instanceof MissingGithubTokenError) {
        return jsonError(
          c,
          400,
          "bad_request",
          "missing X-GitHub-Token header",
          workspaceId,
        );
      }
      if (error instanceof GithubTarImportQueueUnavailableError) {
        return jsonError(
          c,
          503,
          "unavailable",
          "GitHub tarball fetch import queue is not configured",
          workspaceId,
        );
      }
      throw error;
    }
  },
);

importRoutes.get(
  "/v1/workspaces/:workspaceId/fs/import/github-tarball/jobs/:jobId",
  requireBearerScope("fs:read"),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const jobId = c.req.param("jobId");
    const job = await readGithubTarImportJob(c.env, workspaceId, jobId);
    if (!job) {
      return jsonError(
        c,
        404,
        "not_found",
        "import job not found",
        workspaceId,
      );
    }
    return c.json(githubTarImportJobSummary(job));
  },
);

export async function admitGithubTarImportSnapshotCacheHit(
  env: AppEnv["Bindings"],
  input: {
    jobId: string;
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
    headSha: string;
    tarballUrl: string;
  },
): Promise<GithubTarImportJobSummary | null> {
  const snapshot = await readCompleteGithubBaseSnapshot(env, input);
  if (!snapshot) {
    return null;
  }

  await upsertGithubTarImportJob(env, {
    ...input,
    status: "completed",
  });
  await recordGithubTarImportProgress(env, {
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    nextEntryIndex: snapshot.file_count,
    imported: snapshot.file_count,
    errorCount: 0,
    errors: [],
    skipped: [],
    bytesWritten: snapshot.bytes,
    status: "completed",
    lastError: null,
  });

  const job = await readGithubTarImportJob(env, input.workspaceId, input.jobId);
  if (job) {
    return githubTarImportJobSummary(job);
  }

  throw new Error(
    `GitHub tar import job ${input.jobId} was not readable after snapshot cache admission`,
  );
}

export async function startGithubTarImportFetch(
  env: AppEnv["Bindings"],
  input: {
    jobId: string;
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
    headSha: string;
    tarballUrl: string;
    githubToken?: string;
    correlationId?: string;
  },
): Promise<GithubTarImportFetchStartResult> {
  const existing = await readGithubTarImportJob(
    env,
    input.workspaceId,
    input.jobId,
  );
  if (existing) {
    const summary = githubTarImportJobSummary(existing);
    return {
      summary,
      statusCode: githubTarImportJobResponseStatus(existing.status),
      enqueued: false,
    };
  }

  const cached = await admitGithubTarImportSnapshotCacheHit(env, input);
  if (cached) {
    return { summary: cached, statusCode: 200, enqueued: false };
  }

  const active = await readActiveGithubTarImportJobBySnapshotKey(env, input);
  if (active) {
    return {
      summary: githubTarImportJobSummary(active),
      statusCode: 202,
      enqueued: false,
    };
  }

  const githubToken = input.githubToken?.trim() ?? "";
  if (!githubToken) {
    throw new MissingGithubTokenError("missing X-GitHub-Token header");
  }
  if (!env.GITHUB_TAR_IMPORT_QUEUE) {
    throw new GithubTarImportQueueUnavailableError(
      "GITHUB_TAR_IMPORT_QUEUE is not configured",
    );
  }

  const inserted = await insertQueuedGithubTarImportJob(env, input);
  const admitted =
    (await readGithubTarImportJob(env, input.workspaceId, input.jobId)) ??
    (await readActiveGithubTarImportJobBySnapshotKey(env, input));
  if (!admitted) {
    throw new Error(
      `GitHub tar import job ${input.jobId} was not readable after admission`,
    );
  }

  const summary = githubTarImportJobSummary(admitted);
  if (!inserted) {
    return {
      summary,
      statusCode: githubTarImportJobResponseStatus(admitted.status),
      enqueued: false,
    };
  }

  await env.GITHUB_TAR_IMPORT_QUEUE.send({
    type: "fetch",
    jobId: input.jobId,
    workspaceId: input.workspaceId,
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    headSha: input.headSha,
    tarballUrl: input.tarballUrl,
    githubToken,
    correlationId: input.correlationId,
  } satisfies GithubTarImportQueueMessage);

  return { summary, statusCode: 202, enqueued: true };
}

async function readCompleteGithubBaseSnapshot(
  env: Pick<
    AppEnv["Bindings"],
    "CONTENT_BUCKET" | "DB" | "RELAYFILE_GITHUB_BASE_SNAPSHOT_WORKSPACES"
  >,
  input: {
    workspaceId: string;
    owner: string;
    repo: string;
    headSha: string;
  },
): Promise<GithubBaseSnapshotRow | null> {
  if (!githubBaseSnapshotsEnabled(env, input.workspaceId)) {
    return null;
  }
  const snapshot = await readGithubBaseSnapshot(env, input);
  if (!snapshot) {
    return null;
  }
  const manifest = await env.CONTENT_BUCKET.head(snapshot.manifest_ref);
  return manifest ? snapshot : null;
}

export async function importGithubTarball(
  c: { env: AppEnv["Bindings"] },
  input: {
    workspaceId: string;
    owner: string;
    repo: string;
    headSha: string;
    archive: ReadableStream<Uint8Array>;
  },
): Promise<{ files: ImportedFile[]; skipped: SkippedFile[] }> {
  const result = await importGithubTarballChunk(c, {
    ...input,
    startEntryIndex: 0,
    maxEntries: Number.POSITIVE_INFINITY,
  });
  return { files: result.files, skipped: result.skipped };
}

export async function importGithubTarballChunk(
  c: { env: AppEnv["Bindings"] },
  input: {
    workspaceId: string;
    owner: string;
    repo: string;
    headSha: string;
    archive: ReadableStream<Uint8Array>;
    startEntryIndex: number;
    maxEntries: number;
    maxDurationMs?: number;
  },
): Promise<{
  files: ImportedFile[];
  skipped: SkippedFile[];
  nextEntryIndex: number;
  done: boolean;
}> {
  const files: ImportedFile[] = [];
  const skipped: SkippedFile[] = [];
  const maxEntries = Math.max(1, input.maxEntries);
  const startedAt = Date.now();
  let regularEntryIndex = 0;

  for await (const entry of iterateTarGzip(input.archive)) {
    if (!isRegularFileType(entry.type)) {
      continue;
    }
    const currentIndex = regularEntryIndex;
    regularEntryIndex += 1;
    if (currentIndex < input.startEntryIndex) {
      continue;
    }
    if (
      files.length + skipped.length >= maxEntries ||
      (input.maxDurationMs &&
        files.length + skipped.length > 0 &&
        Date.now() - startedAt >= input.maxDurationMs)
    ) {
      return {
        files,
        skipped,
        nextEntryIndex: currentIndex,
        done: false,
      };
    }

    const imported = await importGithubTarEntry(c, input, entry);
    if (imported.file) {
      files.push(imported.file);
    } else if (imported.skipped) {
      skipped.push(imported.skipped);
    }
  }

  return {
    files,
    skipped,
    nextEntryIndex: regularEntryIndex,
    done: true,
  };
}

async function importGithubTarEntry(
  c: { env: AppEnv["Bindings"] },
  input: {
    workspaceId: string;
    owner: string;
    repo: string;
    headSha: string;
  },
  entry: TarEntry,
): Promise<{ file?: ImportedFile; skipped?: SkippedFile }> {
  const repoPath = normalizeGithubTarEntryPath(entry.path);
  if (!repoPath) {
    return { skipped: { path: entry.path, reason: "invalid" } };
  }
  if (isIgnoredPath(repoPath)) {
    return { skipped: { path: repoPath, reason: "ignored" } };
  }
  if (entry.size > GITHUB_CLONE_MAX_FILE_BYTES) {
    return { skipped: { path: repoPath, reason: "too-large" } };
  }

  const encoding = isBinary(repoPath, entry.content) ? "base64" : "utf-8";
  const relayfilePath = githubContentPath({
    owner: input.owner,
    repo: input.repo,
    headSha: input.headSha,
    repoPath,
  });
  const contentRef = `${input.workspaceId}/imports/github-clone/${crypto.randomUUID()}`;
  const contentType = getContentType(repoPath, encoding === "base64");
  const contentHash = await sha256Hex(entry.content);

  await c.env.CONTENT_BUCKET.put(contentRef, entry.content, {
    httpMetadata: { contentType },
    customMetadata: {
      workspaceId: input.workspaceId,
      path: relayfilePath,
      encoding,
      source: "github-tarball-import",
    },
  });

  return {
    file: {
      path: relayfilePath,
      contentRef,
      contentType,
      size: entry.size,
      encoding,
      contentHash,
    },
  };
}

async function importGithubTarballBaseSnapshotChunk(
  c: { env: AppEnv["Bindings"] },
  input: {
    workspaceId: string;
    owner: string;
    repo: string;
    headSha: string;
    archive: ReadableStream<Uint8Array>;
    startEntryIndex: number;
    maxEntries: number;
  },
): Promise<{
  entries: GithubBaseManifestEntry[];
  fileCount: number;
  bytesWritten: number;
  skipped: SkippedFile[];
  nextEntryIndex: number;
  done: boolean;
}> {
  const updatedAt = new Date().toISOString();
  const maxEntries = Math.max(1, input.maxEntries);
  const blobPutConcurrency = githubBaseImportBlobPutConcurrency(c.env);
  const results: GithubBaseImportEntryResult[] = [];
  const pending: GithubBaseImportPending[] = [];
  let regularEntryIndex = 0;
  let scheduledEntries = 0;

  for await (const entry of iterateTarGzip(input.archive)) {
    if (!isRegularFileType(entry.type)) {
      continue;
    }
    const currentIndex = regularEntryIndex;
    regularEntryIndex += 1;
    if (currentIndex < input.startEntryIndex) {
      continue;
    }
    if (scheduledEntries >= maxEntries) {
      await drainGithubBaseImportPending(pending, results);
      const summary = summarizeGithubBaseImportResults(results);
      return {
        entries: summary.entries,
        fileCount: summary.entries.length,
        bytesWritten: summary.bytesWritten,
        skipped: summary.skipped,
        nextEntryIndex: currentIndex,
        done: false,
      };
    }

    const order = scheduledEntries;
    scheduledEntries += 1;
    pending.push({
      order,
      promise: importGithubTarEntryAsBaseSnapshotEntry(
        c,
        input,
        entry,
        updatedAt,
      ).then(
        (imported) => ({ order, imported }),
        (error: unknown) => ({ order, error }),
      ),
    });
    if (pending.length >= blobPutConcurrency) {
      await drainOneGithubBaseImportPending(pending, results);
    }
  }

  await drainGithubBaseImportPending(pending, results);
  const summary = summarizeGithubBaseImportResults(results);
  return {
    entries: summary.entries,
    fileCount: summary.entries.length,
    bytesWritten: summary.bytesWritten,
    skipped: summary.skipped,
    nextEntryIndex: regularEntryIndex,
    done: true,
  };
}

async function drainGithubBaseImportPending(
  pending: GithubBaseImportPending[],
  results: GithubBaseImportEntryResult[],
): Promise<void> {
  while (pending.length > 0) {
    await drainOneGithubBaseImportPending(pending, results);
  }
}

async function drainOneGithubBaseImportPending(
  pending: GithubBaseImportPending[],
  results: GithubBaseImportEntryResult[],
): Promise<void> {
  const completed = await Promise.race(pending.map((item) => item.promise));
  const pendingIndex = pending.findIndex(
    (item) => item.order === completed.order,
  );
  if (pendingIndex !== -1) {
    pending.splice(pendingIndex, 1);
  }
  if ("error" in completed) {
    await Promise.allSettled(pending.map((item) => item.promise));
    throw completed.error;
  }
  results[completed.order] = completed.imported;
}

function summarizeGithubBaseImportResults(
  results: GithubBaseImportEntryResult[],
): {
  entries: GithubBaseManifestEntry[];
  bytesWritten: number;
  skipped: SkippedFile[];
} {
  const entries: GithubBaseManifestEntry[] = [];
  const skipped: SkippedFile[] = [];
  let bytesWritten = 0;
  for (const imported of results) {
    if (imported.entry) {
      entries.push(imported.entry);
      bytesWritten += imported.entry.size;
    } else if (imported.skipped) {
      skipped.push(imported.skipped);
    }
  }
  return { entries, bytesWritten, skipped };
}

function compareGithubBaseManifestEntriesByPath(
  a: GithubBaseManifestEntry,
  b: GithubBaseManifestEntry,
): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

async function importGithubTarEntryAsBaseSnapshotEntry(
  c: { env: AppEnv["Bindings"] },
  input: {
    workspaceId: string;
    owner: string;
    repo: string;
    headSha: string;
  },
  entry: TarEntry,
  updatedAt: string,
): Promise<{ entry?: GithubBaseManifestEntry; skipped?: SkippedFile }> {
  const repoPath = normalizeGithubTarEntryPath(entry.path);
  if (!repoPath) {
    return { skipped: { path: entry.path, reason: "invalid" } };
  }
  if (isIgnoredPath(repoPath)) {
    return { skipped: { path: repoPath, reason: "ignored" } };
  }
  if (entry.size > GITHUB_CLONE_MAX_FILE_BYTES) {
    return { skipped: { path: repoPath, reason: "too-large" } };
  }

  const encoding = isBinary(repoPath, entry.content) ? "base64" : "utf-8";
  const contentHash = await sha256Hex(entry.content);
  const blobRef = githubBaseBlobRef(contentHash);
  const contentType = getContentType(repoPath, encoding === "base64");

  await c.env.CONTENT_BUCKET.put(blobRef, entry.content, {
    httpMetadata: { contentType },
    customMetadata: {
      contentHash,
      encoding,
      source: "github-base-snapshot",
    },
  });

  return {
    entry: {
      path: githubContentPath({
        owner: input.owner,
        repo: input.repo,
        headSha: input.headSha,
        repoPath,
      }),
      repoPath,
      contentHash,
      blobRef,
      size: entry.size,
      encoding,
      contentType,
      headSha: input.headSha,
      updatedAt,
      mode: entry.mode,
    },
  };
}

async function registerImportedFiles(
  c: Context<AppEnv>,
  workspaceId: string,
  files: ImportedFile[],
  jobId?: string,
): Promise<Response> {
  return registerImportedFilesWithWorkspaceDO({
    env: c.env,
    workspaceId,
    files,
    jobId,
    requestUrl: c.req.url,
    authHeader: c.req.raw.headers.get("Authorization") ?? undefined,
    correlationId: c.req.raw.headers.get("X-Correlation-Id") ?? undefined,
    authWorkspaceId: c.get("authClaims")?.workspaceId,
    stub: getWorkspaceStub(c, workspaceId),
  });
}

async function registerImportedFilesFromQueue(input: {
  env: AppEnv["Bindings"];
  workspaceId: string;
  files: ImportedFile[];
  jobId: string;
  correlationId?: string;
}): Promise<Response> {
  const stub = input.env.WORKSPACE_DO.get(
    input.env.WORKSPACE_DO.idFromName(input.workspaceId),
  );
  return registerImportedFilesWithWorkspaceDO({
    ...input,
    requestUrl: "https://workspace-do/internal/register-imported-content",
    internalAgent: "github-clone-worker",
    stub,
  });
}

async function registerGithubBaseSentinelFromQueue(input: {
  env: AppEnv["Bindings"];
  workspaceId: string;
  owner: string;
  repo: string;
  headSha: string;
  jobId: string;
  correlationId?: string;
}): Promise<void> {
  const content = JSON.stringify({
    headSha: input.headSha,
  } satisfies CloneSentinel);
  const bytes = new TextEncoder().encode(content);
  const contentHash = await hashContent(content, "utf-8");
  const contentRef = githubBaseBlobRef(contentHash);
  await input.env.CONTENT_BUCKET.put(contentRef, bytes, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
    customMetadata: {
      source: "github-base-snapshot-sentinel",
      workspaceId: input.workspaceId,
      owner: input.owner,
      repo: input.repo,
      headSha: input.headSha,
    },
  });

  const response = await registerImportedFilesFromQueue({
    env: input.env,
    workspaceId: input.workspaceId,
    files: [
      {
        path: cloneSentinelPath(input.owner, input.repo),
        contentRef,
        contentType: "application/json; charset=utf-8",
        size: bytes.byteLength,
        encoding: "utf-8",
        contentHash,
      },
    ],
    jobId: input.jobId,
    correlationId: input.correlationId,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `WorkspaceDO clone sentinel registration failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }
  const parsed = text
    ? (JSON.parse(text) as {
        written?: number;
        errorCount?: number;
        errors?: Array<{ path: string; code: string; message: string }>;
      })
    : {};
  const errorCount = Number.isFinite(parsed.errorCount)
    ? Number(parsed.errorCount)
    : 0;
  const written = Number.isFinite(parsed.written) ? Number(parsed.written) : 0;
  if (errorCount > 0 || written < 1) {
    const firstError = Array.isArray(parsed.errors) ? parsed.errors[0] : null;
    throw new Error(
      firstError?.message ??
        "WorkspaceDO clone sentinel registration did not commit",
    );
  }
}

function githubBaseImportPartPrefix(input: {
  workspaceId: string;
  jobId: string;
}): string {
  return `${input.workspaceId}/imports/github-base-snapshot-parts/${input.jobId}/`;
}

function githubBaseImportPartRef(input: {
  workspaceId: string;
  jobId: string;
  startEntryIndex: number;
}): string {
  return `${githubBaseImportPartPrefix(input)}${String(input.startEntryIndex).padStart(12, "0")}.ndjson`;
}

async function putGithubBaseImportPart(
  env: Pick<AppEnv["Bindings"], "CONTENT_BUCKET">,
  input: {
    workspaceId: string;
    jobId: string;
    startEntryIndex: number;
    entries: readonly GithubBaseManifestEntry[];
  },
): Promise<string | null> {
  if (input.entries.length === 0) {
    return null;
  }
  const ref = githubBaseImportPartRef(input);
  const body = `${input.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  await env.CONTENT_BUCKET.put(ref, body, {
    httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" },
    customMetadata: {
      source: "github-base-snapshot-part",
      jobId: input.jobId,
      startEntryIndex: String(input.startEntryIndex),
    },
  });
  return ref;
}

async function readGithubBaseImportParts(
  env: Pick<AppEnv["Bindings"], "CONTENT_BUCKET">,
  input: {
    workspaceId: string;
    jobId: string;
  },
): Promise<{ refs: string[]; entries: GithubBaseManifestEntry[] }> {
  const prefix = githubBaseImportPartPrefix(input);
  const refs: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CONTENT_BUCKET.list({ prefix, cursor });
    refs.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  refs.sort();
  const entries: GithubBaseManifestEntry[] = [];
  for (const ref of refs) {
    const object = await env.CONTENT_BUCKET.get(ref);
    if (!object) {
      throw new Error(`GitHub base import part ${ref} not found`);
    }
    const text = await object.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) {
        entries.push(JSON.parse(trimmed) as GithubBaseManifestEntry);
      }
    }
  }
  return { refs, entries };
}

async function listGithubBaseImportPartRefs(
  env: Pick<AppEnv["Bindings"], "CONTENT_BUCKET">,
  input: {
    workspaceId: string;
    jobId: string;
  },
): Promise<string[]> {
  const prefix = githubBaseImportPartPrefix(input);
  const refs: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.CONTENT_BUCKET.list({ prefix, cursor });
    refs.push(...page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return refs;
}

async function deleteGithubBaseImportParts(
  env: Pick<AppEnv["Bindings"], "CONTENT_BUCKET">,
  refs: string[],
): Promise<void> {
  await Promise.all(
    refs.map((ref) =>
      env.CONTENT_BUCKET.delete(ref).catch((error: unknown) => {
        console.warn("relayfile.github_clone.tar_import.part_delete_failed", {
          ref,
          error: sanitizeImportError(error),
        });
      }),
    ),
  );
}

function githubBaseImportChunkEntries(env: AppEnv["Bindings"]): number {
  const raw = env.RELAYFILE_GITHUB_BASE_IMPORT_CHUNK_ENTRIES;
  if (!raw) {
    return GITHUB_BASE_IMPORT_CHUNK_ENTRIES_DEFAULT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return GITHUB_BASE_IMPORT_CHUNK_ENTRIES_DEFAULT;
  }
  return Math.min(parsed, GITHUB_BASE_IMPORT_CHUNK_ENTRIES_MAX);
}

function githubBaseImportBlobPutConcurrency(env: AppEnv["Bindings"]): number {
  const raw = env.RELAYFILE_GITHUB_BASE_IMPORT_BLOB_PUT_CONCURRENCY;
  if (!raw) {
    return GITHUB_BASE_IMPORT_BLOB_PUT_CONCURRENCY_DEFAULT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return GITHUB_BASE_IMPORT_BLOB_PUT_CONCURRENCY_DEFAULT;
  }
  return Math.min(parsed, GITHUB_BASE_IMPORT_BLOB_PUT_CONCURRENCY_MAX);
}

async function registerImportedFilesWithWorkspaceDO(input: {
  env: AppEnv["Bindings"];
  workspaceId: string;
  files: ImportedFile[];
  jobId?: string;
  requestUrl: string;
  authHeader?: string;
  authWorkspaceId?: string;
  correlationId?: string;
  internalAgent?: "github-clone-worker";
  stub: DurableObjectStub;
}): Promise<Response> {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("X-Workspace-Id", input.workspaceId);
  if (input.authHeader) headers.set("Authorization", input.authHeader);
  if (input.correlationId) headers.set("X-Correlation-Id", input.correlationId);
  if (input.authWorkspaceId) {
    headers.set("X-Auth-Workspace-Id", input.authWorkspaceId);
  }
  if (input.internalAgent) {
    headers.set("X-Relayfile-Internal-Agent", input.internalAgent);
  }

  const url = new URL(input.requestUrl);
  url.pathname = "/internal/register-imported-content";
  url.search = "";
  const body = JSON.stringify({
    workspaceId: input.workspaceId,
    jobId: input.jobId,
    files: input.files,
  });
  if (input.internalAgent) {
    const timestamp = new Date().toISOString();
    headers.set("X-Relay-Timestamp", timestamp);
    headers.set(
      "X-Relay-Signature",
      await signInternalRequest(
        timestamp,
        body,
        input.env.INTERNAL_HMAC_SECRET,
      ),
    );
  }

  return fetchWorkspaceDOWithBackpressure(
    input.stub,
    new Request(url.toString(), {
      method: "POST",
      headers,
      body,
    }),
    {
      reason: "durable_object_overloaded",
      retryAfterSeconds: input.env.RELAYFILE_DO_RETRY_AFTER_SECONDS
        ? Number.parseInt(input.env.RELAYFILE_DO_RETRY_AFTER_SECONDS, 10)
        : undefined,
    },
  );
}

export async function handleGithubTarImportQueue(
  batch: MessageBatch,
  env: AppEnv["Bindings"],
): Promise<void> {
  for (const msg of batch.messages) {
    const body = msg.body as GithubTarImportQueueMessage;
    try {
      if (body.type === "fetch") {
        await handleGithubTarImportFetchMessage(env, body);
      } else if (body.type === "process") {
        await handleGithubTarImportProcessMessage(env, body);
      } else {
        throw new Error("unknown GitHub tar import queue message");
      }
      msg.ack();
    } catch (error) {
      const jobId = isRecord(body) ? readNonEmptyString(body.jobId) : null;
      const workspaceId = isRecord(body)
        ? readNonEmptyString(body.workspaceId)
        : null;
      if (jobId && workspaceId && msg.attempts >= 3) {
        await markGithubTarImportJobFailed(
          env,
          workspaceId,
          jobId,
          sanitizeImportError(error),
        ).catch(() => undefined);
        msg.ack();
      } else {
        if (jobId && workspaceId) {
          await recordGithubTarImportTransientError(
            env,
            workspaceId,
            jobId,
            sanitizeImportError(error),
          ).catch(() => undefined);
        }
        msg.retry();
      }
    }
  }
}

async function handleGithubTarImportFetchMessage(
  env: AppEnv["Bindings"],
  msg: Extract<GithubTarImportQueueMessage, { type: "fetch" }>,
): Promise<void> {
  await updateGithubTarImportJobStatus(env, msg.workspaceId, msg.jobId, {
    status: "fetching",
    lastError: null,
  });

  const response = await fetch(msg.tarballUrl, {
    method: "GET",
    headers: {
      Authorization: `token ${msg.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "relayfile-github-tar-import-worker",
    },
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    const bodyText = await response.text().catch(() => "");
    throw new Error(
      `GitHub tarball fetch failed (${response.status} ${response.statusText})${bodyText ? `: ${bodyText.slice(0, 300)}` : ""}`,
    );
  }

  const archiveRef = githubTarImportArchiveRef(msg.workspaceId, msg.jobId);
  await putGithubTarImportArchive(env, archiveRef, response, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      workspaceId: msg.workspaceId,
      owner: msg.owner,
      repo: msg.repo,
      headSha: msg.headSha,
      source: "github-tarball-fetch-import",
    },
  });

  await updateGithubTarImportJobArchive(env, {
    workspaceId: msg.workspaceId,
    jobId: msg.jobId,
    archiveRef,
  });
  await enqueueGithubTarImportProcess(env, {
    jobId: msg.jobId,
    workspaceId: msg.workspaceId,
    correlationId: msg.correlationId,
  });
}

async function putGithubTarImportArchive(
  env: AppEnv["Bindings"],
  archiveRef: string,
  response: Response,
  options: R2PutOptions,
): Promise<void> {
  if (!response.body) {
    throw new Error("GitHub tarball fetch returned no body");
  }

  const contentLength = parseGithubTarImportContentLength(
    response.headers.get("content-length"),
  );
  const FixedLengthStreamCtor = (
    globalThis as typeof globalThis & {
      FixedLengthStream?: FixedLengthStreamConstructor;
    }
  ).FixedLengthStream;

  if (contentLength !== null && FixedLengthStreamCtor) {
    const fixed = new FixedLengthStreamCtor(contentLength);
    const pipe = response.body.pipeTo(fixed.writable);
    const put = env.CONTENT_BUCKET.put(archiveRef, fixed.readable, options);
    await Promise.all([pipe, put]);
    return;
  }

  const archive = await readBoundedGithubTarImportArchive(
    response.body,
    GITHUB_TAR_IMPORT_MAX_ARCHIVE_BYTES,
  );
  await env.CONTENT_BUCKET.put(archiveRef, archive, options);
}

function parseGithubTarImportContentLength(raw: string | null): number | null {
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  if (parsed > GITHUB_TAR_IMPORT_MAX_ARCHIVE_BYTES) {
    throw new Error(
      `GitHub tarball archive exceeds ${GITHUB_TAR_IMPORT_MAX_ARCHIVE_BYTES} bytes`,
    );
  }
  return parsed;
}

async function readBoundedGithubTarImportArchive(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`GitHub tarball archive exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

async function handleGithubTarImportProcessMessage(
  env: AppEnv["Bindings"],
  msg: Extract<GithubTarImportQueueMessage, { type: "process" }>,
): Promise<void> {
  const job = await readGithubTarImportJob(env, msg.workspaceId, msg.jobId);
  if (!job) {
    throw new Error(`GitHub tar import job ${msg.jobId} not found`);
  }
  if (job.status === "completed" || job.status === "failed") {
    if (job.archive_ref) {
      await deleteGithubTarImportArchive(env, job.archive_ref);
    }
    return;
  }
  if (!job.archive_ref) {
    throw new Error(`GitHub tar import job ${msg.jobId} has no archive`);
  }

  await updateGithubTarImportJobStatus(env, msg.workspaceId, msg.jobId, {
    status: "importing",
    lastError: null,
  });

  const archive = await env.CONTENT_BUCKET.get(job.archive_ref);
  if (!archive?.body) {
    throw new Error(`GitHub tar import archive ${job.archive_ref} not found`);
  }

  const useBaseSnapshot = githubBaseSnapshotsEnabled(env, job.workspace_id);
  let written = 0;
  let errorCount = 0;
  let errors: Array<{ path: string; code: string; message: string }> = [];
  let bytesWritten = 0;
  let nextEntryIndex = job.next_entry_index;
  let skipped: SkippedFile[] = [];
  let completedBaseImportPartRefs: string[] = [];

  if (useBaseSnapshot) {
    const messageStartEntryIndex =
      typeof msg.startEntryIndex === "number"
        ? Math.max(0, msg.startEntryIndex)
        : null;
    if (
      messageStartEntryIndex !== null &&
      messageStartEntryIndex < job.next_entry_index
    ) {
      await enqueueGithubTarImportProcess(env, {
        jobId: job.job_id,
        workspaceId: job.workspace_id,
        startEntryIndex: job.next_entry_index,
        correlationId: msg.correlationId,
      });
      return;
    }
    if (
      messageStartEntryIndex !== null &&
      messageStartEntryIndex > job.next_entry_index
    ) {
      throw new Error(
        `GitHub tar import continuation ${messageStartEntryIndex} is ahead of checkpoint ${job.next_entry_index}`,
      );
    }

    const startEntryIndex = job.next_entry_index;
    const imported = await importGithubTarballBaseSnapshotChunk(
      { env },
      {
        workspaceId: job.workspace_id,
        owner: job.owner,
        repo: job.repo,
        headSha: job.head_sha,
        archive: archive.body,
        startEntryIndex,
        maxEntries: githubBaseImportChunkEntries(env),
      },
    );
    await putGithubBaseImportPart(env, {
      workspaceId: job.workspace_id,
      jobId: job.job_id,
      startEntryIndex,
      entries: imported.entries,
    });
    written = imported.fileCount;
    bytesWritten = imported.bytesWritten;
    nextEntryIndex = imported.nextEntryIndex;
    skipped = imported.skipped;
    if (!imported.done) {
      await recordGithubTarImportProgress(env, {
        workspaceId: job.workspace_id,
        jobId: job.job_id,
        nextEntryIndex,
        imported: written,
        errorCount: 0,
        errors: [],
        skipped,
        bytesWritten,
        status: "importing",
        lastError: null,
      });
      await enqueueGithubTarImportProcess(env, {
        jobId: job.job_id,
        workspaceId: job.workspace_id,
        startEntryIndex: nextEntryIndex,
        correlationId: msg.correlationId,
      });
      return;
    }

    const parts = await readGithubBaseImportParts(env, {
      workspaceId: job.workspace_id,
      jobId: job.job_id,
    });
    const entries = parts.entries.sort(compareGithubBaseManifestEntriesByPath);
    const manifestRef = githubBaseManifestRef({
      workspaceId: job.workspace_id,
      owner: job.owner,
      repo: job.repo,
      headSha: job.head_sha,
    });
    await putGithubBaseManifest(env, manifestRef, entries);
    const totalBytesWritten = entries.reduce(
      (sum, entry) => sum + entry.size,
      0,
    );
    await upsertGithubBaseSnapshot(env, {
      workspaceId: job.workspace_id,
      owner: job.owner,
      repo: job.repo,
      headSha: job.head_sha,
      manifestRef,
      fileCount: entries.length,
      bytes: totalBytesWritten,
    });
    await registerGithubBaseSentinelFromQueue({
      env,
      workspaceId: job.workspace_id,
      owner: job.owner,
      repo: job.repo,
      headSha: job.head_sha,
      jobId: job.job_id,
      correlationId: msg.correlationId,
    });
    completedBaseImportPartRefs = parts.refs;
    written = Math.max(0, entries.length - job.imported);
    bytesWritten = Math.max(0, totalBytesWritten - job.bytes_written);
  } else {
    const imported = await importGithubTarballChunk(
      { env },
      {
        workspaceId: job.workspace_id,
        owner: job.owner,
        repo: job.repo,
        headSha: job.head_sha,
        archive: archive.body,
        startEntryIndex: 0,
        maxEntries: Number.POSITIVE_INFINITY,
      },
    );
    nextEntryIndex = imported.nextEntryIndex;
    skipped = imported.skipped;
    if (imported.files.length > 0) {
      const response = await registerImportedFilesFromQueue({
        env,
        workspaceId: job.workspace_id,
        files: imported.files,
        jobId: job.job_id,
        correlationId: msg.correlationId,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `WorkspaceDO import registration failed (${response.status})${text ? `: ${text.slice(0, 300)}` : ""}`,
        );
      }
      const parsed = text
        ? (JSON.parse(text) as {
            written?: number;
            errorCount?: number;
            errors?: Array<{ path: string; code: string; message: string }>;
            bytesWritten?: number;
          })
        : {};
      written = Number.isFinite(parsed.written) ? Number(parsed.written) : 0;
      errorCount = Number.isFinite(parsed.errorCount)
        ? Number(parsed.errorCount)
        : 0;
      errors = Array.isArray(parsed.errors) ? parsed.errors : [];
      bytesWritten = Number.isFinite(parsed.bytesWritten)
        ? Number(parsed.bytesWritten)
        : 0;
    }
  }

  const nextStatus: GithubTarImportJobStatus =
    errorCount > 0 ? "failed" : "completed";
  await recordGithubTarImportProgress(env, {
    workspaceId: job.workspace_id,
    jobId: job.job_id,
    nextEntryIndex,
    imported: written,
    errorCount,
    errors,
    skipped,
    bytesWritten,
    status: nextStatus,
    lastError:
      errorCount > 0
        ? (errors[0]?.message ?? "WorkspaceDO import registration failed")
        : null,
  });

  if (errorCount > 0) {
    await deleteGithubTarImportArchive(env, job.archive_ref);
    return;
  }
  await deleteGithubTarImportArchive(env, job.archive_ref);
  if (completedBaseImportPartRefs.length > 0) {
    await deleteGithubBaseImportParts(env, completedBaseImportPartRefs);
  }
}

async function enqueueGithubTarImportProcess(
  env: AppEnv["Bindings"],
  input: {
    jobId: string;
    workspaceId: string;
    startEntryIndex?: number;
    correlationId?: string;
  },
): Promise<void> {
  if (!env.GITHUB_TAR_IMPORT_QUEUE) {
    throw new Error("GITHUB_TAR_IMPORT_QUEUE is not configured");
  }
  await env.GITHUB_TAR_IMPORT_QUEUE.send({
    type: "process",
    jobId: input.jobId,
    workspaceId: input.workspaceId,
    ...(typeof input.startEntryIndex === "number"
      ? { startEntryIndex: input.startEntryIndex }
      : {}),
    correlationId: input.correlationId,
  } satisfies GithubTarImportQueueMessage);
}

function githubTarImportArchiveRef(workspaceId: string, jobId: string): string {
  return `${workspaceId}/imports/github-clone-archives/${jobId}.tar.gz`;
}

async function upsertGithubTarImportJob(
  env: AppEnv["Bindings"],
  input: {
    jobId: string;
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
    headSha: string;
    tarballUrl: string;
    status: GithubTarImportJobStatus;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      INSERT INTO github_tar_import_jobs (
        job_id, workspace_id, owner, repo, ref, head_sha, tarball_url,
        status, next_entry_index, imported, error_count, errors_json,
        skipped_json, bytes_written, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, '[]', '[]', 0, ?, ?)
      ON CONFLICT(job_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        owner = excluded.owner,
        repo = excluded.repo,
        ref = excluded.ref,
        head_sha = excluded.head_sha,
        tarball_url = excluded.tarball_url,
        status = CASE
          WHEN github_tar_import_jobs.status IN ('completed', 'failed')
            THEN github_tar_import_jobs.status
          ELSE excluded.status
        END,
        updated_at = excluded.updated_at
    `,
  )
    .bind(
      input.jobId,
      input.workspaceId,
      input.owner,
      input.repo,
      input.ref,
      input.headSha,
      input.tarballUrl,
      input.status,
      now,
      now,
    )
    .run();
}

async function insertQueuedGithubTarImportJob(
  env: AppEnv["Bindings"],
  input: {
    jobId: string;
    workspaceId: string;
    owner: string;
    repo: string;
    ref: string;
    headSha: string;
    tarballUrl: string;
  },
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    `
      INSERT OR IGNORE INTO github_tar_import_jobs (
        job_id, workspace_id, owner, repo, ref, head_sha, tarball_url,
        status, next_entry_index, imported, error_count, errors_json,
        skipped_json, bytes_written, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, 0, 0, '[]', '[]', 0, ?, ?)
    `,
  )
    .bind(
      input.jobId,
      input.workspaceId,
      input.owner,
      input.repo,
      input.ref,
      input.headSha,
      input.tarballUrl,
      now,
      now,
    )
    .run();
  const changes = (result as { meta?: { changes?: number } }).meta?.changes;
  return changes === undefined ? true : changes > 0;
}

async function readGithubTarImportJob(
  env: AppEnv["Bindings"],
  workspaceId: string,
  jobId: string,
): Promise<GithubTarImportJobRow | null> {
  return env.DB.prepare(
    `
      SELECT *
      FROM github_tar_import_jobs
      WHERE workspace_id = ? AND job_id = ?
      LIMIT 1
    `,
  )
    .bind(workspaceId, jobId)
    .first<GithubTarImportJobRow>();
}

async function readActiveGithubTarImportJobBySnapshotKey(
  env: AppEnv["Bindings"],
  input: {
    workspaceId: string;
    owner: string;
    repo: string;
    headSha: string;
  },
): Promise<GithubTarImportJobRow | null> {
  return env.DB.prepare(
    `
      SELECT *
      FROM github_tar_import_jobs
      WHERE workspace_id = ?
        AND owner = ?
        AND repo = ?
        AND head_sha = ?
        AND status IN ('queued', 'fetching', 'importing')
      ORDER BY created_at ASC
      LIMIT 1
    `,
  )
    .bind(input.workspaceId, input.owner, input.repo, input.headSha)
    .first<GithubTarImportJobRow>();
}

async function updateGithubTarImportJobStatus(
  env: AppEnv["Bindings"],
  workspaceId: string,
  jobId: string,
  input: {
    status: GithubTarImportJobStatus;
    lastError?: string | null;
  },
): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE github_tar_import_jobs
      SET status = ?,
          last_error = ?,
          updated_at = ?,
          completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END
      WHERE workspace_id = ? AND job_id = ?
    `,
  )
    .bind(
      input.status,
      input.lastError ?? null,
      new Date().toISOString(),
      input.status,
      new Date().toISOString(),
      workspaceId,
      jobId,
    )
    .run();
}

async function updateGithubTarImportJobArchive(
  env: AppEnv["Bindings"],
  input: { workspaceId: string; jobId: string; archiveRef: string },
): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE github_tar_import_jobs
      SET archive_ref = ?,
          status = 'importing',
          updated_at = ?
      WHERE workspace_id = ? AND job_id = ?
    `,
  )
    .bind(
      input.archiveRef,
      new Date().toISOString(),
      input.workspaceId,
      input.jobId,
    )
    .run();
}

async function recordGithubTarImportProgress(
  env: AppEnv["Bindings"],
  input: {
    workspaceId: string;
    jobId: string;
    nextEntryIndex: number;
    imported: number;
    errorCount: number;
    errors: Array<{ path: string; code: string; message: string }>;
    skipped: SkippedFile[];
    bytesWritten: number;
    status: GithubTarImportJobStatus;
    lastError?: string | null;
  },
): Promise<void> {
  const job = await readGithubTarImportJob(env, input.workspaceId, input.jobId);
  const errors = appendJsonArray(job?.errors_json, input.errors).slice(
    -GITHUB_TAR_IMPORT_MAX_ERRORS,
  );
  const skipped = appendJsonArray(job?.skipped_json, input.skipped).slice(
    -GITHUB_TAR_IMPORT_MAX_ERRORS,
  );
  const now = new Date().toISOString();
  await env.DB.prepare(
    `
      UPDATE github_tar_import_jobs
      SET status = ?,
          next_entry_index = ?,
          imported = imported + ?,
          error_count = error_count + ?,
          errors_json = ?,
          skipped_json = ?,
          bytes_written = bytes_written + ?,
          last_error = ?,
          updated_at = ?,
          completed_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE completed_at END
      WHERE workspace_id = ? AND job_id = ?
    `,
  )
    .bind(
      input.status,
      input.nextEntryIndex,
      input.imported,
      input.errorCount,
      JSON.stringify(errors),
      JSON.stringify(skipped),
      input.bytesWritten,
      input.lastError ?? null,
      now,
      input.status,
      now,
      input.workspaceId,
      input.jobId,
    )
    .run();
}

async function recordGithubTarImportTransientError(
  env: AppEnv["Bindings"],
  workspaceId: string,
  jobId: string,
  error: string,
): Promise<void> {
  await env.DB.prepare(
    `
      UPDATE github_tar_import_jobs
      SET last_error = ?,
          updated_at = ?
      WHERE workspace_id = ? AND job_id = ?
    `,
  )
    .bind(error, new Date().toISOString(), workspaceId, jobId)
    .run();
}

async function markGithubTarImportJobFailed(
  env: AppEnv["Bindings"],
  workspaceId: string,
  jobId: string,
  error: string,
): Promise<void> {
  const job = await readGithubTarImportJob(env, workspaceId, jobId);
  await updateGithubTarImportJobStatus(env, workspaceId, jobId, {
    status: "failed",
    lastError: error,
  });
  if (job?.archive_ref) {
    await deleteGithubTarImportArchive(env, job.archive_ref);
  }
  await deleteGithubBaseImportParts(
    env,
    await listGithubBaseImportPartRefs(env, { workspaceId, jobId }),
  );
}

async function deleteGithubTarImportArchive(
  env: AppEnv["Bindings"],
  archiveRef: string,
): Promise<void> {
  await env.CONTENT_BUCKET.delete(archiveRef).catch((error: unknown) => {
    console.warn("relayfile.github_clone.tar_import.archive_delete_failed", {
      archiveRef,
      error: sanitizeImportError(error),
    });
  });
}

function githubTarImportJobSummary(
  row: GithubTarImportJobRow,
): GithubTarImportJobSummary {
  return {
    jobId: row.job_id,
    workspaceId: row.workspace_id,
    owner: row.owner,
    repo: row.repo,
    ref: row.ref,
    headSha: row.head_sha,
    status: row.status,
    imported: row.imported,
    errorCount: row.error_count,
    errors: appendJsonArray(row.errors_json, []),
    skipped: appendJsonArray(row.skipped_json, []),
    bytesWritten: row.bytes_written,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
  };
}

function githubTarImportJobResponseStatus(
  status: GithubTarImportJobStatus,
): 200 | 202 {
  return status === "queued" || status === "fetching" || status === "importing"
    ? 202
    : 200;
}

function appendJsonArray<T>(raw: string | null | undefined, next: T[]): T[] {
  const parsed = raw ? (JSON.parse(raw) as unknown) : [];
  return [...(Array.isArray(parsed) ? (parsed as T[]) : []), ...next];
}

function isExpectedGithubTarballUrl(
  value: string,
  owner: string,
  repo: string,
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "api.github.com") {
      return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      segments[0] === "repos" &&
      segments[1]?.toLowerCase() === owner.toLowerCase() &&
      segments[2]?.toLowerCase() === repo.toLowerCase() &&
      segments[3] === "tarball" &&
      Boolean(segments[4])
    );
  } catch {
    return false;
  }
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function sanitizeImportError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/authorization\s*:\s*bearer\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(/bearer\s+[A-Za-z0-9._~\-+/=]+/gi, "Bearer [REDACTED]")
    .replace(/token\s+[A-Za-z0-9._~\-+/=]+/gi, "token [REDACTED]")
    .replace(/X-GitHub-Token[^\s,;]*/gi, "X-GitHub-Token=[REDACTED]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function signInternalRequest(
  timestamp: string,
  body: string,
  secret: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestamp}\n${body}`),
  );
  return Array.from(new Uint8Array(signed), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function* iterateTarGzip(
  archive: ReadableStream<Uint8Array>,
): AsyncGenerator<TarEntry> {
  const stream = archive.pipeThrough(
    new DecompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  const reader = new BufferedReader(stream.getReader());

  for (;;) {
    const header = await reader.readExact(TAR_BLOCK_BYTES);
    if (header === null || isZeroBlock(header)) {
      return;
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const type = readTarString(header, 156, 1) || "0";
    const mode = readTarOctal(header, 100, 8);
    const size = readTarOctal(header, 124, 12);
    if (!path || !Number.isFinite(size) || size < 0) {
      throw new InvalidTarArchiveError("invalid tar archive");
    }

    const content = await reader.readExact(size);
    if (content === null) {
      throw new InvalidTarArchiveError("truncated tar archive");
    }
    const padding =
      (TAR_BLOCK_BYTES - (size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    if (padding > 0 && (await reader.readExact(padding)) === null) {
      throw new InvalidTarArchiveError("truncated tar archive");
    }

    yield { path, type, size, mode, content };
  }
}

class BufferedReader {
  private chunks: Uint8Array[] = [];
  private available = 0;
  private done = false;

  constructor(
    private readonly reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {}

  async readExact(length: number): Promise<Uint8Array | null> {
    while (this.available < length && !this.done) {
      const next = await this.reader.read();
      if (next.done) {
        this.done = true;
        break;
      }
      if (next.value?.byteLength) {
        this.chunks.push(next.value);
        this.available += next.value.byteLength;
      }
    }
    if (this.available < length) {
      return null;
    }

    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const head = this.chunks[0]!;
      const take = Math.min(head.byteLength, length - offset);
      out.set(head.subarray(0, take), offset);
      offset += take;
      this.available -= take;
      if (take === head.byteLength) {
        this.chunks.shift();
      } else {
        this.chunks[0] = head.subarray(take);
      }
    }
    return out;
  }
}

function isZeroBlock(block: Uint8Array): boolean {
  return block.every((byte) => byte === 0);
}

function readTarString(
  block: Uint8Array,
  offset: number,
  length: number,
): string {
  const bytes = block.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  const slice = nul >= 0 ? bytes.subarray(0, nul) : bytes;
  return new TextDecoder().decode(slice).trim();
}

function readTarOctal(
  block: Uint8Array,
  offset: number,
  length: number,
): number {
  const raw = readTarString(block, offset, length).replace(/\0/g, "").trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

function isRegularFileType(type: string): boolean {
  return type === "0" || type === "\0" || type === "";
}

function normalizeGithubTarEntryPath(entryPath: string): string | null {
  if (!entryPath || entryPath.includes("\0") || /^[A-Za-z]:/.test(entryPath)) {
    return null;
  }
  const parts = entryPath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^(\.\/)+/, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2 || parts.some((part) => part === "." || part === "..")) {
    return null;
  }
  return parts.slice(1).join("/");
}

function isIgnoredPath(repoPath: string): boolean {
  const lowerParts = repoPath.split("/").map((part) => part.toLowerCase());
  if (lowerParts.some((part) => GITHUB_CLONE_IGNORE_DIRS.has(part))) {
    return true;
  }
  const basename = lowerParts.at(-1);
  if (basename && GITHUB_CLONE_IGNORE_FILES.has(basename)) {
    return true;
  }
  const lowerPath = repoPath.toLowerCase();
  return GITHUB_CLONE_IGNORE_EXTS.some((extension) =>
    lowerPath.endsWith(extension),
  );
}

function isBinary(repoPath: string, content: Uint8Array): boolean {
  const lowerPath = repoPath.toLowerCase();
  if (
    GITHUB_CLONE_BINARY_EXTS.some((extension) => lowerPath.endsWith(extension))
  ) {
    return true;
  }
  if (content.subarray(0, Math.min(content.byteLength, 8 * 1024)).includes(0)) {
    return true;
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return false;
  } catch {
    return true;
  }
}

function githubContentPath(input: {
  owner: string;
  repo: string;
  headSha: string;
  repoPath: string;
}): string {
  return `/github/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeEntryPath(input.repoPath)}@${encodeURIComponent(input.headSha)}.json`;
}

function encodeEntryPath(entryPath: string): string {
  return entryPath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function getContentType(repoPath: string, isBinaryContent: boolean): string {
  if (isBinaryContent) {
    return "application/octet-stream";
  }
  if (repoPath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (repoPath.endsWith(".md")) {
    return "text/markdown; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
