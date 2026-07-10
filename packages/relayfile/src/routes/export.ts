/**
 * Parent-Worker export handler.
 *
 * Hardening item 1: `fs/export` is no longer served by the WorkspaceDO.
 * Instead the parent Worker (which holds the R2 binding) pages through a
 * metadata-only manifest from the DO and streams the per-file body bytes
 * straight from R2. This makes export STRUCTURALLY OOM-proof: the DO heap
 * never holds a file body during export, regardless of workspace size.
 *
 * Wire contract is unchanged versus the P0 streaming export — same
 * Content-Type, same on-wire shape (JSON array of FileReadResponse, or
 * tar.gz, or unified-diff patch).
 */

import type { Context } from "hono";
import type { FileReadResponse, ExportFormat } from "@relayfile/sdk";
import { parseSemantics as coreParseSemantics } from "@relayfile/core";
import type { AppEnv } from "../env.js";
import { getWorkspaceStub, jsonError } from "../middleware/auth.js";
import { fetchWorkspaceDOWithBackpressure } from "../workspace-do-backpressure.js";
import {
  EXPORT_FILE_PAGE_SIZE,
  type ExportManifestEntry,
} from "../durable-objects/adapter.js";
import { emitMetric } from "../durable-objects/metrics.js";
import { runtimeContentForRef } from "../durable-objects/runtime-files.js";
import {
  resolveVfsPlaneRoute,
  vfsPlaneLogLabels,
} from "../durable-objects/vfs-plane.js";
import {
  githubBaseEntryToExportManifestEntry,
  githubBaseSnapshotsEnabled,
  loadGithubBaseManifest,
  parseGithubContentRoot,
  readGithubBaseSnapshot,
  type GithubBaseManifestEntry,
} from "./github-base-snapshot.js";

type ManifestPageResponse = {
  fileCount: number;
  entries: ExportManifestEntry[];
  nextCursor: string | null;
};

export type WorkerFileReadMetadata = Omit<
  FileReadResponse,
  "content" | "encoding"
> & {
  contentRef: string;
  encoding: "utf-8" | "base64";
  contentHash?: string;
};

export function metadataToFileReadResponse(
  metadata: WorkerFileReadMetadata,
  content: string,
): FileReadResponse & { contentHash?: string } {
  return {
    path: metadata.path,
    revision: metadata.revision,
    contentType: metadata.contentType,
    content,
    encoding: metadata.encoding,
    provider: metadata.provider,
    providerObjectId: metadata.providerObjectId,
    lastEditedAt: metadata.lastEditedAt,
    semantics: metadata.semantics,
    ...(metadata.contentHash ? { contentHash: metadata.contentHash } : {}),
  };
}

type GithubWorkingTreeDecode = {
  mode: "github-working-tree";
  pathPrefix: string;
  headSha: string;
  suffix: string;
};

const JSON_EXPORT_BODY_LOAD_CONCURRENCY = 16;
const JSON_EXPORT_KEEPALIVE_MS = 2_000;
// Tar export reads R2 bodies with the same bounded, body-consuming concurrency
// as the JSON export, so a fat repo's thousands of bodies overlap instead of
// serializing — without unbounded subrequest fan-out (each prefetched body is
// consumed into the tar before the window refills).
const TAR_EXPORT_BODY_LOAD_CONCURRENCY = 16;
const DEFAULT_MAX_EXPORT_BODY_BYTES = 128 * 1024 * 1024;
// Streaming tar reads bodies one-at-a-time (bounded by the per-file write cap),
// so the 128 MiB AGGREGATE guard — meant to push BUFFERED exports toward
// paginated reads — has no memory basis for tar. Use a much higher runaway
// guard so repos at/over 128 MiB still bulk-materialize (the cloud repo is
// right at the edge and growing).
//
// SANITY CEILING, not a license to ignore scaling: this bounds BYTES, not
// subrequest count. The tar does one R2 GET per file, so SUBREQUEST scaling is
// bounded by RELAYFILE_MAX_EXPORT_FILES (default 50k), which itself exceeds the
// Cloudflare per-invocation subrequest cap (~10k). A repo with >~10k files will
// hit that cap mid-stream regardless of this byte ceiling — for those, segment
// the export by subtree (pathPrefix). The cloud repo (~2766 files) is well
// under the cap today. Duration is bounded by raw-tar (no gzip CPU) + the
// bounded body-consuming prefetch above.
const DEFAULT_MAX_EXPORT_TAR_BODY_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Fetch one page of the export manifest from the WorkspaceDO. Returns the
 * page on 200, throws an error-shape object on any non-2xx (so the caller
 * can forward the DO's error response unchanged).
 */
async function fetchManifestPage(
  c: Context<AppEnv>,
  workspaceId: string,
  afterPath: string | null,
  maxBodyBytes?: number,
  pathPrefix?: string | null,
  foreground = false,
): Promise<ManifestPageResponse | Response> {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("X-Workspace-Id", workspaceId);
  // Tag the clone-materialize manifest pages so the DO admission gives them the
  // reserved foreground lane, not the throttled background pool (cloud#1261).
  if (foreground) headers.set("X-Relayfile-Admission", "clone-foreground");
  const incomingAuth = c.req.raw.headers.get("Authorization");
  if (incomingAuth) headers.set("Authorization", incomingAuth);
  const correlationId = c.req.raw.headers.get("X-Correlation-Id");
  if (correlationId) headers.set("X-Correlation-Id", correlationId);
  const authClaims = c.get("authClaims");
  if (authClaims?.workspaceId) {
    headers.set("X-Auth-Workspace-Id", authClaims.workspaceId);
  }

  const url = new URL(c.req.url);
  url.pathname = "/internal/export-manifest";
  url.search = "";

  const stub = getWorkspaceStub(c, workspaceId);
  const res = await fetchWorkspaceDOWithBackpressure(
    stub,
    new Request(url.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId,
        afterPath,
        pageSize: EXPORT_FILE_PAGE_SIZE,
        ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
        ...(pathPrefix ? { pathPrefix } : {}),
      }),
    }),
    {
      reason: "durable_object_overloaded",
      retryAfterSeconds: c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS
        ? Number.parseInt(c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS, 10)
        : undefined,
    },
  );

  if (!res.ok) {
    // Forward the DO's error response unchanged (413, 401, etc.).
    return res;
  }
  return (await res.json()) as ManifestPageResponse;
}

/**
 * Async generator over every manifest entry across all pages. Yields
 * metadata-only rows; the caller is responsible for fetching bodies (from
 * R2). Cancels cleanly if the consumer stops pulling.
 */
async function* iterateManifest(
  c: Context<AppEnv>,
  workspaceId: string,
  firstPage?: ManifestPageResponse,
  pathPrefix?: string | null,
  foreground = false,
): AsyncGenerator<ExportManifestEntry, void, void> {
  let cursor: string | null = null;
  if (firstPage) {
    for (const entry of firstPage.entries) {
      yield entry;
    }
    if (firstPage.nextCursor == null) return;
    cursor = firstPage.nextCursor;
  }
  for (;;) {
    const page = (await fetchManifestPage(
      c,
      workspaceId,
      cursor,
      undefined,
      pathPrefix,
      foreground,
    )) as ManifestPageResponse | Response;
    if (page instanceof Response) {
      cancelResponseBody(page);
      throw new Error(
        `export manifest paging failed with status ${page.status}`,
      );
    }
    for (const entry of page.entries) {
      yield entry;
    }
    if (page.nextCursor == null) return;
    cursor = page.nextCursor;
  }
}

/**
 * Read one body from R2. Returns the encoded string and the encoding.
 * Encoding is preserved verbatim from the manifest row (so a
 * base64-stored file comes back base64-encoded).
 *
 * NOTE: this still allocates the file body once in the parent Worker
 * (which has a higher memory budget than the per-workspace DO). For
 * very-large files the worker would also want to stream, but the wire
 * shape (JSON FileReadResponse) requires the encoded body inline, so this
 * is bounded by the per-file write cap (`RELAYFILE_MAX_WRITE_BYTES`, 10
 * MiB default).
 */
const DEFAULT_BLOB_READ_TIMEOUT_MS = 8000;
const DEFAULT_BLOB_READ_ATTEMPTS = 3;
const BLOB_READ_RETRY_BACKOFF_MS = 100;

function readBlobReadTimeoutMs(c: Context<AppEnv>): number {
  const raw = c.env.RELAYFILE_EXPORT_BLOB_READ_TIMEOUT_MS;
  if (!raw) return DEFAULT_BLOB_READ_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_BLOB_READ_TIMEOUT_MS;
}

function readBlobReadAttempts(c: Context<AppEnv>): number {
  const raw = c.env.RELAYFILE_EXPORT_BLOB_READ_ATTEMPTS;
  if (!raw) return DEFAULT_BLOB_READ_ATTEMPTS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1
    ? Math.min(Math.floor(n), 10)
    : DEFAULT_BLOB_READ_ATTEMPTS;
}

class BlobReadTimeoutError extends Error {
  constructor(
    public readonly contentRef: string,
    public readonly timeoutMs: number,
  ) {
    super(`R2 blob read timed out after ${timeoutMs}ms: ${contentRef}`);
    this.name = "BlobReadTimeoutError";
  }
}

/**
 * Bounded per-blob R2 read with timeout + retry.
 *
 * A bare `await CONTENT_BUCKET.get(ref) + arrayBuffer()` can hang
 * indefinitely on a transient R2 read hiccup — the ordered tar yield then
 * blocks on the next-in-order entry and the whole export stream wedges
 * (see #1300: died at entry 28/2961, 313 KB, materializer stuck in
 * ep_poll). Tar wire format forbids injected keepalive bytes, so the
 * mechanism that keeps the stream alive is *bounding the max no-byte
 * gap* — i.e. a per-blob timeout shorter than any intermediary's
 * idle-close.
 *
 * On timeout we retry (default 3 attempts, 100 ms backoff). On
 * exhaustion we throw, which surfaces as a clean stream error to the
 * client (consumer retries the whole export — see
 * personas/cloud-small-issue-codex/agent.ts EXPORT_FETCH retries).
 * Silent infinite wedge is the failure mode we refuse.
 */
async function readBlobWithTimeoutRetry(
  c: Context<AppEnv>,
  contentRef: string,
): Promise<ArrayBuffer> {
  const timeoutMs = readBlobReadTimeoutMs(c);
  const attempts = readBlobReadAttempts(c);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BlobReadTimeoutError(contentRef, timeoutMs)),
        timeoutMs,
      );
    });
    try {
      const object = await Promise.race([
        c.env.CONTENT_BUCKET.get(contentRef),
        timeout,
      ]);
      if (!object) {
        throw new Error(`export content missing from R2: ${contentRef}`);
      }
      const buffer = await Promise.race([object.arrayBuffer(), timeout]);
      return buffer;
    } catch (error) {
      lastError = error;
      const isTimeout = error instanceof BlobReadTimeoutError;
      if (isTimeout) {
        emitMetric("relayfile_export_blob_read_timeout_total", 1, {
          attempt,
          timeout_ms: timeoutMs,
        });
      }
      // A "missing from R2" error is deterministic — don't retry it.
      if (
        !isTimeout &&
        error instanceof Error &&
        error.message.startsWith("export content missing from R2")
      ) {
        throw error;
      }
      if (attempt < attempts) {
        emitMetric("relayfile_export_blob_read_retry_total", 1, { attempt });
        await new Promise((resolve) =>
          setTimeout(resolve, BLOB_READ_RETRY_BACKOFF_MS),
        );
      }
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }
  emitMetric("relayfile_export_blob_read_exhausted_total", 1, {
    attempts,
    timeout_ms: timeoutMs,
  });
  throw lastError instanceof Error
    ? lastError
    : new Error(
        `R2 blob read failed after ${attempts} attempts: ${contentRef}`,
      );
}

export async function loadBodyFromR2(
  c: Context<AppEnv>,
  entry: Pick<ExportManifestEntry, "contentRef" | "encoding">,
): Promise<string> {
  if (!entry.contentRef) return "";
  const runtimeContent = runtimeContentForRef(entry.contentRef);
  if (runtimeContent !== null) {
    return runtimeContent;
  }
  const arrayBuffer = await readBlobWithTimeoutRetry(c, entry.contentRef);
  if (entry.encoding === "base64") {
    return bytesToBase64Chunked(new Uint8Array(arrayBuffer));
  }
  return new TextDecoder().decode(arrayBuffer);
}

async function loadTarBytes(
  c: Context<AppEnv>,
  entry: ExportManifestEntry,
): Promise<Uint8Array> {
  if (!entry.contentRef) return new Uint8Array(0);
  const runtimeContent = runtimeContentForRef(entry.contentRef);
  if (runtimeContent !== null) {
    return new TextEncoder().encode(runtimeContent);
  }
  const arrayBuffer = await readBlobWithTimeoutRetry(c, entry.contentRef);
  return new Uint8Array(arrayBuffer);
}

/**
 * Chunked base64 encoder. Mirrors the bytesToBase64 fix in workspace.ts —
 * char-by-char `+=` is O(n²) in V8, so we slice in 32 KiB pages.
 */
const BTOA_CHUNK = 32 * 1024;
function bytesToBase64Chunked(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += BTOA_CHUNK) {
    const slice = bytes.subarray(offset, offset + BTOA_CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function entryToFileReadResponse(
  entry: ExportManifestEntry,
  content: string,
): FileReadResponse {
  return {
    path: entry.path,
    revision: entry.revision,
    contentType: entry.contentType,
    content,
    encoding: entry.encoding,
    provider: entry.provider || undefined,
    providerObjectId: entry.providerObjectId || undefined,
    lastEditedAt: entry.updatedAt,
    semantics: coreParseSemantics(entry.semanticsJson),
  } satisfies FileReadResponse;
}

/**
 * Parent-Worker handler for `GET /v1/workspaces/:workspaceId/fs/export`.
 *
 * Replaces the DO-side handler that previously served this route. The DO
 * is still kept (handleExportWorkspaceGet / handleExportWorkspace) for
 * back-compat with any internal callers that POST directly, but the
 * public route lands here.
 */
export async function handleExportFromWorker(
  c: Context<AppEnv>,
  workspaceId: string,
): Promise<Response> {
  const format = (c.req.query("format") ?? "json") as ExportFormat;
  if (format !== "json" && format !== "patch" && format !== "tar") {
    return jsonError(
      c,
      400,
      "bad_request",
      "unsupported export format",
      workspaceId,
    );
  }

  const decodeOrResponse = parseExportDecode(c, format, workspaceId);
  if (decodeOrResponse instanceof Response) {
    return decodeOrResponse;
  }
  const decode = decodeOrResponse;
  const pathPrefix =
    decode?.pathPrefix ??
    normalizeOptionalPathPrefix(
      c.req.query("pathPrefix") || c.req.query("path"),
    );
  emitWorkerVfsPlaneResolvedMetric(
    workspaceId,
    pathPrefix ?? "/",
    "export_worker",
  );

  // First page also validates the file-count ceiling in the DO. If the DO
  // returns a 4xx/5xx, forward it verbatim.
  // gzip=0 → raw tar (application/x-tar): removes the per-byte CompressionStream
  // CPU that can exceed the Worker CPU budget on a fat repo. Default keeps gzip.
  const gzip = c.req.query("gzip") !== "0";
  if (
    format === "tar" &&
    !gzip &&
    decode?.mode === "github-working-tree" &&
    githubBaseSnapshotsEnabled(c.env, workspaceId)
  ) {
    const baseSnapshotResponse = await maybeStreamGithubBaseSnapshotTarExport(
      c,
      workspaceId,
      decode,
      gzip,
    );
    if (baseSnapshotResponse) {
      return baseSnapshotResponse;
    }
  }
  // Only the RAW streaming tar gets the higher ceiling — streaming + no-gzip is
  // the memory- AND CPU-safe combination. A DEFAULT (gzipped) tar keeps the
  // 128MiB buffered limit, so a fat repo still 413s BEFORE it can be gzipped:
  // we never "raise the limit and then burn CompressionStream CPU on a 100MB+
  // tar" (which would just trade a 413 for an exceededCpu). Large tar exports
  // must therefore be requested raw (gzip=0).
  const bodyLimit =
    format === "tar" && !gzip
      ? maxExportTarBodyBytes(c)
      : maxExportBodyBytes(c);
  // The clone materialize (decode=github-working-tree) is the foreground op:
  // tag its manifest pages so the DO admission reserves a lane for them, so the
  // clone is never starved by the background burst it's surviving (cloud#1261).
  const foreground = decode != null;
  const firstPageOrResponse = await fetchManifestPage(
    c,
    workspaceId,
    null,
    bodyLimit,
    pathPrefix,
    foreground,
  );
  if (firstPageOrResponse instanceof Response) {
    return firstPageOrResponse;
  }
  const firstPage: ManifestPageResponse = firstPageOrResponse;
  const entries = iterateManifest(
    c,
    workspaceId,
    firstPage,
    pathPrefix,
    foreground,
  );

  if (format === "json") {
    return streamJsonExport(c, entries);
  }
  if (format === "patch") {
    return streamPatchExport(c, entries);
  }
  return streamTarExport(c, entries, decode, gzip);
}

function emitWorkerVfsPlaneResolvedMetric(
  workspaceId: string,
  path: unknown,
  operation: string,
): void {
  const route = resolveVfsPlaneRoute(workspaceId, path);
  emitMetric("relayfile_vfs_plane_resolved_total", 1, {
    workspace_id: workspaceId,
    operation,
    ...vfsPlaneLogLabels(route),
  });
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function maybeStreamGithubBaseSnapshotTarExport(
  c: Context<AppEnv>,
  workspaceId: string,
  decode: GithubWorkingTreeDecode,
  gzip: boolean,
): Promise<Response | null> {
  const repo = parseGithubContentRoot(decode.pathPrefix);
  if (!repo) {
    return null;
  }
  const snapshot = await readGithubBaseSnapshot(c.env, {
    workspaceId,
    owner: repo.owner,
    repo: repo.repo,
    headSha: decode.headSha,
  });
  if (!snapshot || snapshot.content_root !== decode.pathPrefix) {
    return null;
  }
  let baseEntries: GithubBaseManifestEntry[];
  try {
    baseEntries = await loadGithubBaseManifest(c.env, snapshot.manifest_ref);
  } catch (error) {
    console.warn("relayfile.github_base_snapshot.manifest_unavailable", {
      workspaceId,
      owner: repo.owner,
      repo: repo.repo,
      headSha: decode.headSha,
      manifestRef: snapshot.manifest_ref,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  async function* entries(): AsyncGenerator<ExportManifestEntry, void, void> {
    for (const entry of baseEntries) {
      yield githubBaseEntryToExportManifestEntry(entry);
    }
  }

  emitMetric(
    "relayfile_export_github_base_snapshot_files",
    baseEntries.length,
    {
      format: "tar",
    },
  );
  return streamTarExport(c, entries(), decode, gzip);
}

function parseExportDecode(
  c: Context<AppEnv>,
  format: ExportFormat,
  workspaceId: string,
): GithubWorkingTreeDecode | null | Response {
  const mode = c.req.query("decode")?.trim();
  if (!mode) {
    return null;
  }
  if (mode !== "github-working-tree") {
    return jsonError(
      c,
      400,
      "bad_request",
      "unsupported decode mode",
      workspaceId,
    );
  }
  if (format !== "tar") {
    return jsonError(
      c,
      400,
      "bad_request",
      "decode is only supported for tar export",
      workspaceId,
    );
  }

  const pathPrefix = normalizeOptionalPathPrefix(c.req.query("pathPrefix"));
  const headSha = c.req.query("headSha")?.trim() ?? "";
  if (!pathPrefix || !headSha) {
    return jsonError(
      c,
      400,
      "bad_request",
      "decode requires pathPrefix and headSha",
      workspaceId,
    );
  }
  if (!isGithubContentsPathPrefix(pathPrefix)) {
    return jsonError(
      c,
      400,
      "bad_request",
      "decode pathPrefix must match /github/repos/<owner>/<repo>/contents",
      workspaceId,
    );
  }

  return {
    mode,
    pathPrefix,
    headSha,
    suffix: `@${encodeURIComponent(headSha)}.json`,
  };
}

function normalizeOptionalPathPrefix(
  pathPrefix?: string | null,
): string | null {
  if (!pathPrefix?.trim()) {
    return null;
  }
  const trimmed = pathPrefix.trim();
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const normalized = prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : "/";
  return normalized === "/" ? null : normalized;
}

function isGithubContentsPathPrefix(pathPrefix: string): boolean {
  const parts = pathPrefix.split("/");
  return (
    parts.length === 6 &&
    parts[0] === "" &&
    parts[1] === "github" &&
    parts[2] === "repos" &&
    parts[3] !== "" &&
    parts[4] !== "" &&
    parts[5] === "contents"
  );
}

function maxExportBodyBytes(c: Context<AppEnv>): number {
  const raw = (c.env as { RELAYFILE_MAX_EXPORT_BODY_BYTES?: string })
    .RELAYFILE_MAX_EXPORT_BODY_BYTES;
  if (!raw?.trim()) {
    return DEFAULT_MAX_EXPORT_BODY_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_EXPORT_BODY_BYTES;
}

function maxExportTarBodyBytes(c: Context<AppEnv>): number {
  const raw = (c.env as { RELAYFILE_MAX_EXPORT_TAR_BODY_BYTES?: string })
    .RELAYFILE_MAX_EXPORT_TAR_BODY_BYTES;
  if (!raw?.trim()) {
    return DEFAULT_MAX_EXPORT_TAR_BODY_BYTES;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_EXPORT_TAR_BODY_BYTES;
}

function streamJsonExport(
  c: Context<AppEnv>,
  entries: AsyncIterable<ExportManifestEntry>,
): Response {
  const encoder = new TextEncoder();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let emitted = 0;
    let first = true;
    yield encoder.encode("[");
    const jsonResponses = orderedJsonResponses(c, entries);
    let next = jsonResponses.next();
    for (;;) {
      const result = await raceJsonResponse(next);
      if (result.type === "keepalive") {
        yield encoder.encode("\n");
        continue;
      }
      if (result.value.done) {
        break;
      }
      const json = result.value.value;
      yield encoder.encode(first ? json : `,${json}`);
      first = false;
      emitted += 1;
      next = jsonResponses.next();
    }
    yield encoder.encode("]");
    emitMetric("relayfile_export_files_emitted", emitted, { format: "json" });
  }
  return streamChunks(chunks(), "application/json; charset=utf-8");
}

async function raceJsonResponse(
  next: Promise<IteratorResult<string>>,
): Promise<
  { type: "response"; value: IteratorResult<string> } | { type: "keepalive" }
> {
  return Promise.race([
    next.then((value) => ({ type: "response" as const, value })),
    sleep(JSON_EXPORT_KEEPALIVE_MS).then(() => ({
      type: "keepalive" as const,
    })),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function* orderedJsonResponses(
  c: Context<AppEnv>,
  entries: AsyncIterable<ExportManifestEntry>,
): AsyncGenerator<string, void, void> {
  const iterator = entries[Symbol.asyncIterator]();
  const pending: Array<Promise<string>> = [];
  let done = false;
  const fill = async () => {
    while (!done && pending.length < JSON_EXPORT_BODY_LOAD_CONCURRENCY) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        return;
      }
      pending.push(
        loadBodyFromR2(c, next.value).then((body) =>
          JSON.stringify(entryToFileReadResponse(next.value, body)),
        ),
      );
    }
  };

  await fill();
  while (pending.length > 0) {
    const next = pending.shift()!;
    await fill();
    yield await next;
  }
}

function streamPatchExport(
  c: Context<AppEnv>,
  entries: AsyncIterable<ExportManifestEntry>,
): Response {
  const encoder = new TextEncoder();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let first = true;
    for await (const entry of entries) {
      const body = await loadBodyFromR2(c, entry);
      const lines = body.split("\n");
      const patch = [
        `--- ${safePatchPath(entry.path)}`,
        `+++ ${safePatchPath(entry.path)}`,
        "@@",
        ...lines.map((line) => `+${line}`),
      ].join("\n");
      yield encoder.encode(first ? patch : `\n${patch}`);
      first = false;
    }
  }
  return streamChunks(chunks(), "text/plain; charset=utf-8");
}

type TarEntry = { name: string; bytes: Uint8Array; updatedAt: string };

/**
 * Ordered, bounded-concurrency prefetch of tar entries. Mirrors
 * {@link orderedJsonResponses}: keeps up to {@link TAR_EXPORT_BODY_LOAD_CONCURRENCY}
 * R2 body reads in flight while yielding entries in manifest order (tar requires
 * ordered entries). Entries whose name resolves to null (outside the decode
 * prefix) are skipped WITHOUT fetching their bodies. Each in-flight body is
 * consumed (shifted + yielded) before the window refills, so this never
 * fans out subrequests faster than they're read.
 */
async function* orderedTarEntries(
  c: Context<AppEnv>,
  entries: AsyncIterable<ExportManifestEntry>,
  decode?: GithubWorkingTreeDecode | null,
): AsyncGenerator<TarEntry, void, void> {
  const iterator = entries[Symbol.asyncIterator]();
  const pending: Array<Promise<TarEntry>> = [];
  let done = false;
  const fill = async () => {
    while (!done && pending.length < TAR_EXPORT_BODY_LOAD_CONCURRENCY) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        return;
      }
      const entry = next.value;
      const name = tarEntryName(entry, decode);
      if (name === null) {
        continue;
      }
      pending.push(
        loadTarBytes(c, entry).then((bytes) => ({
          name,
          bytes,
          updatedAt: entry.updatedAt,
        })),
      );
    }
  };

  await fill();
  while (pending.length > 0) {
    const next = pending.shift()!;
    await fill();
    yield await next;
  }
}

function streamTarExport(
  c: Context<AppEnv>,
  entries: AsyncIterable<ExportManifestEntry>,
  decode?: GithubWorkingTreeDecode | null,
  gzip = true,
): Response {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const { name, bytes, updatedAt } of orderedTarEntries(
      c,
      entries,
      decode,
    )) {
      yield buildTarHeader(name, bytes.byteLength, updatedAt);
      yield bytes;
      const remainder = bytes.byteLength % 512;
      if (remainder > 0) {
        yield new Uint8Array(512 - remainder);
      }
    }
    yield new Uint8Array(1024);
  }
  const tarStream = streamChunks(chunks()).body!;
  if (!gzip) {
    return new Response(tarStream, {
      headers: { "Content-Type": "application/x-tar" },
    });
  }
  const gzipStream = tarStream.pipeThrough(
    new CompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  return new Response(gzipStream, {
    headers: { "Content-Type": "application/gzip" },
  });
}

function streamChunks(
  chunks: AsyncGenerator<Uint8Array>,
  contentType?: string,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await chunks.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(next.value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await chunks.return?.(undefined);
    },
  });
  return new Response(stream, {
    headers: contentType ? { "Content-Type": contentType } : undefined,
  });
}

function tarEntryName(
  entry: ExportManifestEntry,
  decode?: GithubWorkingTreeDecode | null,
): string | null {
  if (!decode) {
    return safeTarEntryName(entry.path);
  }
  return decodedGithubWorkingTreeTarEntryName(entry.path, decode);
}

function safeTarEntryName(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter((part) => part && part !== ".");
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part === ".." ||
        part.includes("\0") ||
        /[\x00-\x1f\x7f]/.test(part) ||
        /^[A-Za-z]:$/.test(part),
    )
  ) {
    throw new Error(`unsafe tar entry path: ${path}`);
  }
  return `workspace/${parts.join("/")}`;
}

function decodedGithubWorkingTreeTarEntryName(
  path: string,
  decode: GithubWorkingTreeDecode,
): string | null {
  const prefix = `${decode.pathPrefix}/`;
  if (!path.startsWith(prefix) || !path.endsWith(decode.suffix)) {
    return null;
  }

  const encodedRepoPath = path.slice(prefix.length, -decode.suffix.length);
  if (!encodedRepoPath) {
    return null;
  }

  let decodedParts: string[];
  try {
    decodedParts = encodedRepoPath
      .split("/")
      .filter((part) => part.length > 0)
      .map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }

  const relativePath = decodedParts.join("/");
  return safeWorkingTreeTarEntryName(relativePath);
}

function safeWorkingTreeTarEntryName(path: string): string | null {
  if (path.startsWith("/") || path.startsWith("\\")) {
    return null;
  }
  const normalized = path.replace(/\\/g, "/");
  const parts = normalized.split("/");
  if (
    parts.length === 0 ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        part.includes("\0") ||
        /[\x00-\x1f\x7f]/.test(part) ||
        /^[A-Za-z]:$/.test(part),
    )
  ) {
    return null;
  }
  return parts.join("/");
}

function safePatchPath(path: string): string {
  return JSON.stringify(path);
}

// --- ustar header writer (mirrors the DO-side helper byte-for-byte so
// tar output is identical to the pre-hardening implementation). ---

function buildTarHeader(
  name: string,
  size: number,
  updatedAt: string | undefined,
): Uint8Array {
  const header = new Uint8Array(512);
  const splitName = splitUstarPath(name);
  writeTarString(header, 0, 100, splitName.name);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, tarMtimeSeconds(updatedAt));
  for (let index = 148; index < 156; index += 1) {
    header[index] = 0x20;
  }
  header[156] = "0".charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  if (splitName.prefix) {
    writeTarString(header, 345, 155, splitName.prefix);
  }
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarChecksum(header, checksum);
  return header;
}

function splitUstarPath(path: string): { name: string; prefix: string } {
  if (tarByteLength(path) <= 100) {
    return { name: path, prefix: "" };
  }

  for (
    let index = path.lastIndexOf("/");
    index > 0;
    index = path.lastIndexOf("/", index - 1)
  ) {
    const prefix = path.slice(0, index);
    const name = path.slice(index + 1);
    if (tarByteLength(prefix) <= 155 && tarByteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`tar entry path is too long for ustar: ${path}`);
}

function tarByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function writeTarString(
  buffer: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  buffer.set(bytes.slice(0, length), offset);
}

function writeTarOctal(
  buffer: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const normalized = Number.isFinite(value) && value >= 0 ? value : 0;
  const octal = Math.floor(normalized)
    .toString(8)
    .padStart(length - 1, "0");
  writeTarString(buffer, offset, length - 1, octal.slice(-length + 1));
  buffer[offset + length - 1] = 0;
}

function tarMtimeSeconds(updatedAt: string | undefined): number {
  if (!updatedAt) {
    return Math.floor(Date.now() / 1000);
  }
  const parsed = Date.parse(updatedAt);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function writeTarChecksum(buffer: Uint8Array, checksum: number): void {
  const octal = checksum.toString(8).padStart(6, "0");
  writeTarString(buffer, 148, 6, octal);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

/**
 * Exported only for tests — the streaming generator over manifest pages.
 * Kept named so a test can assert "zero DO body fetches" by counting how
 * many times the stub's `loadContent` is invoked.
 */
export const _testing = {
  iterateManifest,
  bytesToBase64Chunked,
  safeTarEntryName,
  decodedGithubWorkingTreeTarEntryName,
};
