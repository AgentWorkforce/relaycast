import {
  getRecentEvents as coreGetRecentEvents,
  listEvents as coreListEvents,
  listTree as coreListTree,
  normalizeSemantics as coreNormalizeSemantics,
  parseSemantics as coreParseSemantics,
  queryFiles as coreQueryFiles,
  type PermissionEvaluationOptions,
} from "@relayfile/core";
import type {
  BulkWriteResponse,
  EventFeedResponse,
  ExportFormat,
  FileQueryResponse,
  FileReadResponse,
  FileSemantics,
  FilesystemEvent,
  TreeResponse,
  WriteQueuedResponse,
} from "@relayfile/sdk";
import {
  isGithubCloneWriter,
  isProviderSyncWriter,
  scopeMatchesPath,
  verifyInternalHmac,
  type TokenClaims,
} from "../../middleware/auth.js";
import type {
  BulkWriteFile,
  WorkspaceEvent,
  WorkspaceFile,
} from "../../types.js";
import {
  countExportableWorkspaceFiles,
  createCoreStorageAdapter,
  EXPORT_FILE_PAGE_SIZE,
  iterateWorkspaceFilesForExport,
  listWorkspaceExportManifestPage,
  MAX_LIST_ROWS,
  summarizeExportableWorkspaceFiles,
  toCoreFileRow,
  type ExportFileChunk,
  type ExportManifestEntry,
  type Row,
  type WorkspaceAdapterContext,
} from "../adapter.js";
import {
  base64DecodedSize,
  hashContent,
  validateBase64Content,
} from "../content-hash.js";
// Digest regeneration is no longer awaited inline on the write path; the DO
// schedules a debounced alarm via `context.scheduleDigestRefresh` and runs
// `refreshWorkspaceDigests` from its `alarm()` handler. See cloud#846 and
// `WorkspaceFsContext.scheduleDigestRefresh` below.
import {
  StreamByteLimitError,
  streamToR2WithHash,
} from "../streaming-sha256.js";
import { decideAdmission, resolveDoMemoryBudgetBytes } from "../admission.js";
import { emitMetric } from "../metrics.js";
import {
  ACTIVITY_SUMMARY_PATH,
  activitySummaryReadResponse,
  activitySummaryWorkspaceFile,
  virtualActivitySummaryFile,
  getRuntimeFileByPath,
  getRuntimeFilesUnderBase,
  runtimeReadResponse,
  runtimeWorkspaceFile,
} from "../runtime-files.js";
import { resolveVfsPlaneRoute, vfsPlaneLogLabels } from "../vfs-plane.js";
import {
  WriteBodyOverflowError,
  effectiveWriteLimitFromConfig,
  maxWriteBytesFromConfig,
  readJsonWithLimit,
  rejectJsonWriteContentLength,
} from "../../write-body-size-guard.js";
import { getUnsupportedWritebackReason } from "../../writeback/path-eligibility.js";

const DEFAULT_CONTENT_TYPE = "text/markdown";
const DIRECTORY_PERMISSION_MARKER_FILE = ".relayfile.acl";
const ACL_ADMIN_SCOPE = "admin:acl";
const GLOB_PATTERN = /[*?\[]/;

export type ListTreeRequest = {
  workspaceId?: string;
  path?: string;
  depth?: number;
  cursor?: string | null;
};

export type ListTreePathRangeDiagnostic = {
  mode: "path-range";
  base: string;
  depth: number;
  cursor: string | null;
  range: {
    lower: string;
    upper: string;
  };
  directFile: {
    path: string;
    exists: boolean;
    revision?: string;
    provider?: string;
    providerObjectId?: string;
    size?: number;
    aclAllowed?: boolean;
    permissionCount?: number;
  } | null;
  prefix: {
    count: number;
    sampleLimit: number;
    sampleCount: number;
    firstPath: string | null;
    lastPath: string | null;
    sample: Array<{
      path: string;
      revision: string;
      provider?: string;
      providerObjectId?: string;
      aclAllowed: boolean;
      permissionCount: number;
    }>;
  };
  tree: {
    entryCount: number;
    nextCursor: string | null;
    sample: Array<{
      path: string;
      type: "file" | "dir";
      revision: string;
    }>;
  };
};

export type ReadFileRequest = {
  workspaceId?: string;
  path: string;
};

export type FileReadMetadataResponse = Omit<
  FileReadResponse,
  "content" | "encoding"
> & {
  contentRef: string;
  encoding: "utf-8" | "base64";
  contentHash?: string;
};

export type DeleteFileRequest = {
  workspaceId?: string;
  path: string;
  ifMatch: string;
  correlationId?: string;
};

export type ListEventsRequest = {
  workspaceId?: string;
  provider?: string;
  cursor?: string | null;
  limit?: number;
  direction?: EventFeedDirection;
};

export type EventFeedDirection = "asc" | "desc";

type ChangeEventResource = {
  path: string;
  kind: string;
  id: string;
  provider: string;
};

type ChangeEventSummary = {
  title?: string;
  status?: string;
  priority?: string;
  labels?: string[];
  actor?: { id: string; displayName?: string };
  fieldsChanged?: string[];
  tags?: string[];
};

type WireChangeEvent = {
  id: string;
  workspace: string;
  type: "relayfile.changed";
  occurredAt: string;
  resource: ChangeEventResource;
  summary: ChangeEventSummary;
  digest?: string;
};

type ChangeResourceAtEventResult = {
  path: string;
  data: unknown;
  digest: string;
};

export type QueryFilesRequest = {
  workspaceId?: string;
  path?: string;
  pathPrefix?: string;
  provider?: string;
  relation?: string;
  permission?: string;
  comment?: string;
  properties?: Record<string, string>;
  cursor?: string | null;
  limit?: number;
};

export type BulkWriteRequest = {
  workspaceId?: string;
  jobId?: string;
  files: BulkWriteFile[];
};

export type ImportedContentFile = {
  path: string;
  contentRef: string;
  contentType: string;
  size: number;
  encoding?: string;
  contentHash: string;
  semantics?: FileSemantics;
};

export type RegisterImportedContentRequest = {
  workspaceId?: string;
  jobId?: string;
  files: ImportedContentFile[];
};

export type ExportWorkspaceRequest = {
  workspaceId?: string;
  format?: ExportFormat;
  pathPrefix?: string | null;
};

export type WriteContentIdentity = {
  kind: string;
  key: string;
  ttlSeconds?: number;
};

export type WriteFileRequest = {
  workspaceId?: string;
  path: string;
  ifMatch: string;
  content: string;
  contentType?: string;
  encoding?: string;
  semantics?: FileSemantics;
  correlationId?: string;
  contentIdentity?: WriteContentIdentity;
};

export interface ErrorTemplate {
  status: number;
  code: string;
  message: string;
}

export interface FsHandlerErrors {
  invalidInput: ErrorTemplate;
  notFound: ErrorTemplate;
  preconditionFailed: ErrorTemplate;
  revisionConflict: ErrorTemplate;
  payloadTooLarge: ErrorTemplate;
  badRequest: ErrorTemplate;
}

export type WorkspaceStatsOverrides = Partial<{
  lastIngestedAt: string;
  lastEventAt: string;
  lastWritebackAt: string;
  lastActivity: string;
  fileCountDelta: number;
  bytesStoredDelta: number;
  // Provider-sync mutations do not create operation rows; pass 0 for those
  // origins and only delta this gauge for agent_write mutations.
  operationCountDelta: number;
}>;

export type MutationRecordInput = {
  path: string;
  revision: string;
  provider: string;
  correlationId: string;
  eventType: string;
  action: "file_upsert" | "file_delete";
  timestamp: string;
  /**
   * Origin of the write. Defaults to `"agent_write"` (caller is a
   * user/agent and the write should be propagated back to the provider).
   * `"provider_sync"` marks an ingest from an upstream sync worker — the
   * cloud must NOT enqueue a writeback for these, since the synced record
   * shape (e.g. Nango `fetch-pages` rows) is not a writeback payload.
   */
  origin?: "agent_write" | "provider_sync" | "system";
  /**
   * Server-side threading: the relay path of a parent writeback draft this write
   * depends on, lifted from a `parentRef` field in the draft body (e.g. a Slack
   * reply naming the header draft it threads under). `recordMutations` resolves
   * it to the parent op, holds dispatch until the parent delivers, then carries
   * the parent's delivered id. Absent for ordinary writes. See `extractParentRef`.
   */
  parentRef?: string;
};

/**
 * Server-side threading: pull a `parentRef` off a writeback draft body, if one
 * is present. The relay-helpers client writes `{ ...payload, parentRef }` for a
 * write that should be ordered after — and reference — a prior draft (a Slack
 * reply threading under a header; `parentRef` = that header draft's relay path).
 * Only small JSON draft bodies carry it; large, binary, or non-JSON content
 * returns undefined without a full parse.
 */
const PARENT_REF_MAX_DRAFT_BYTES = 64_000;
const PARENT_REF_UTF8_DECODER = new TextDecoder("utf-8");
function extractParentRef(
  content: string,
  encoding: string,
): string | undefined {
  if (!content || content.length > PARENT_REF_MAX_DRAFT_BYTES) return undefined;
  let text: string;
  try {
    if (encoding === "base64") {
      // Reuse one decoder and a plain loop: this runs per write, and in
      // bulkWrite per file in a batch, where `Uint8Array.from(..., mapFn)` and
      // a fresh TextDecoder each call are measurable overhead.
      const binary = atob(content);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
      }
      text = PARENT_REF_UTF8_DECODER.decode(bytes);
    } else {
      text = content;
    }
  } catch {
    return undefined;
  }
  if (!text.trimStart().startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(text) as { parentRef?: unknown };
    return typeof parsed.parentRef === "string" && parsed.parentRef.length > 0
      ? parsed.parentRef
      : undefined;
  } catch {
    return undefined;
  }
}

export type MutationRecordBatchResult = {
  responses: WriteQueuedResponse[];
  syncCount: number;
};

type BulkWriteResult = BulkWriteResponse & {
  bytesWritten: number;
  syncCount: number;
  dedupedFiles?: BulkWriteDedupedFile[];
  fileCountDelta: number;
  bytesStoredDelta: number;
  operationCountDelta: number;
};

type BulkWriteDedupedFile = {
  path: string;
  deduped: true;
  originalWriter: string;
  revision: null;
};

type BulkWritePendingCommit = {
  path: string;
  revision: string;
  action: "file_delete" | "file_upsert";
  contentRef: string | null;
  dedupReservation: DedupReservation | null;
  contentRefToDeleteAfterVisible: string | null;
  mutationInput: MutationRecordInput;
  bytesWrittenDelta: number;
  bytesStoredDelta: number;
  fileCountDelta: number;
};

export interface WorkspaceFsContext extends WorkspaceAdapterContext {
  errors: FsHandlerErrors;
  readJson<T>(request: Request): Promise<T>;
  resolveWorkspaceId(
    request: Request,
    body?: { workspaceId?: string },
  ): Promise<string | null>;
  getRequestClaims(request: Request): Promise<TokenClaims | null>;
  internalHmacSecret?: string;
  json(payload: unknown, status?: number, headers?: HeadersInit): Response;
  errorResponse(
    request: Request,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Response;
  correlationId(request: Request): string;
  dedupKv?: KVNamespace;
  putObject(
    contentRef: string,
    content: string,
    encoding: "utf-8" | "base64",
    contentType: string,
    workspaceId: string,
    path: string,
    revision: string,
  ): Promise<void>;
  /**
   * Streaming R2 put — body is consumed as a ReadableStream and never
   * materialized in the DO heap. Used by the streaming-writeback path
   * (hardening item 2). Optional so test fixtures that exercise only the
   * legacy JSON-base64 path don't have to supply it.
   */
  putObjectStream?(
    contentRef: string,
    body: ReadableStream<Uint8Array>,
    encoding: "utf-8" | "base64",
    contentType: string,
    workspaceId: string,
    path: string,
    revision: string,
  ): Promise<void>;
  deleteContent(contentRef: string): Promise<void>;
  contentRef(workspaceId: string, path: string, revision: string): string;
  recordMutation(input: MutationRecordInput): Promise<WriteQueuedResponse>;
  recordMutations?(
    inputs: MutationRecordInput[],
  ): Promise<MutationRecordBatchResult>;
  syncWorkspaceStats(
    workspaceId: string,
    overrides?: WorkspaceStatsOverrides,
  ): Promise<void>;
  touchWorkspaceWriteStats(
    workspaceId: string,
    overrides?: WorkspaceStatsOverrides,
  ): Promise<void>;
  touchWorkspaceActivity(workspaceId: string): Promise<void>;
  /**
   * Force pending DO SQL writes durable. Call BEFORE any non-transactional
   * side effect (R2 putObject, WS broadcast) so a later throw cannot rewind
   * the rev counter / files row out from under content the daemon already
   * received.
   */
  flushStorage?(): Promise<void>;
  /**
   * Schedule a debounced digest regeneration on the DO alarm instead of
   * running it synchronously on the write critical path. The actual digest
   * computation (multiple time windows × thousands of events × per-event R2
   * reads) is far too expensive to await before returning 202 — running it
   * inline blocked every write for >60s on busy workspaces and silently lost
   * provider-sync writes (cloud#846). The DO coalesces bursts and runs one
   * `refreshWorkspaceDigests` per debounce window inside `alarm()`.
   */
  scheduleDigestRefresh(options: {
    changedPaths: readonly string[];
    generatedAt: Date;
    correlationId: string;
  }): Promise<void>;
}

type DedupEntry = {
  productId: string;
  ts: number;
};

type DedupWriteResponse = {
  deduped: true;
  originalWriter: string;
};

function emitVfsPlaneResolvedMetric(
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

function emitVfsPlaneWriteCandidateMetric(
  workspaceId: string,
  path: unknown,
  operation: string,
): void {
  emitVfsPlaneWriteCandidateMetrics(workspaceId, [path], operation);
}

function emitVfsPlaneWriteCandidateMetrics(
  workspaceId: string,
  paths: Iterable<unknown>,
  operation: string,
): void {
  const counts = new Map<
    string,
    { route: ReturnType<typeof resolveVfsPlaneRoute>; count: number }
  >();
  for (const path of paths) {
    if (typeof path !== "string" || !path.trim()) {
      continue;
    }
    const route = resolveVfsPlaneRoute(workspaceId, path);
    const key = JSON.stringify(vfsPlaneLogLabels(route));
    const existing = counts.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      counts.set(key, { route, count: 1 });
    }
  }
  for (const { route, count } of counts.values()) {
    emitMetric("relayfile_vfs_plane_write_candidate_total", count, {
      workspace_id: workspaceId,
      operation,
      ...vfsPlaneLogLabels(route),
    });
  }
}

function cloudReadAclOptions(): PermissionEvaluationOptions {
  return {
    action: "read",
    scopeMatches: (scope, claims, context) => {
      const requiredAction =
        context.action === "read" || context.action === undefined
          ? "read"
          : context.action === "write"
            ? "write"
            : null;
      return requiredAction === null || !context.requestedPath
        ? false
        : scopeRuleMatches(
            scope,
            claims as TokenClaims | null,
            requiredAction,
            context.requestedPath,
          );
    },
  };
}

export async function handleListTree(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<ListTreeRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }
  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(workspaceId, body.path ?? "/", "tree");
  await context.touchWorkspaceActivity(workspaceId);
  return context.json(
    listTree(
      context,
      workspaceId,
      body.path ?? "/",
      body.depth ?? 2,
      body.cursor ?? null,
      claims,
    ),
  );
}

export async function handleListTreeGet(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.resolveWorkspaceId(request);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const url = new URL(request.url);
  const claims = await context.getRequestClaims(request);
  const path = url.searchParams.get("path") ?? "/";
  const depth = clampInt(url.searchParams.get("depth"), 2, 1, 10);
  const cursor = url.searchParams.get("cursor");
  emitVfsPlaneResolvedMetric(workspaceId, path, "tree");
  await context.touchWorkspaceActivity(workspaceId);
  const tree = listTree(context, workspaceId, path, depth, cursor, claims);
  if (url.searchParams.get("diag") === "path-range") {
    return context.json({
      ...tree,
      _diag: diagnoseListTreePathRange(
        context,
        workspaceId,
        path,
        depth,
        cursor,
        claims,
        tree,
        url.searchParams.get("diagFilePath"),
      ),
    });
  }
  return context.json(tree);
}

export async function handleReadFile(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<ReadFileRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }
  if (!body.path?.trim()) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing path",
    );
  }

  const file = await readFile(context, body.path);
  if (!file) {
    return context.errorResponse(
      request,
      context.errors.notFound.status,
      context.errors.notFound.code,
      context.errors.notFound.message,
    );
  }

  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(workspaceId, body.path, "file_read");
  if (
    !filePermissionAllows(
      resolveFilePermissions(context, file.path, true),
      workspaceId,
      claims,
      "read",
      file.path,
    )
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "file access denied by permission policy",
    );
  }

  await context.touchWorkspaceActivity(workspaceId);
  return context.json(file, 200, { ETag: file.revision });
}

export async function handleReadFileGet(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.resolveWorkspaceId(request);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const path = new URL(request.url).searchParams.get("path") ?? "";
  if (!path.trim()) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing path",
    );
  }

  const file = await readFile(context, path);
  if (!file) {
    return context.errorResponse(
      request,
      context.errors.notFound.status,
      context.errors.notFound.code,
      context.errors.notFound.message,
    );
  }

  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(workspaceId, path, "file_read");
  if (
    !filePermissionAllows(
      resolveFilePermissions(context, file.path, true),
      workspaceId,
      claims,
      "read",
      file.path,
    )
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "file access denied by permission policy",
    );
  }

  await context.touchWorkspaceActivity(workspaceId);
  return context.json(file, 200, { ETag: file.revision });
}

export async function handleReadFileMetadata(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<ReadFileRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }
  if (!body.path?.trim()) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing path",
    );
  }

  const path = normalizePath(body.path);
  const runtimeFileMeta = getRuntimeFileByPath(path);
  const row = runtimeFileMeta
    ? runtimeWorkspaceFile(runtimeFileMeta)
    : context.getFileRow(path);
  if (!row) {
    return context.errorResponse(
      request,
      context.errors.notFound.status,
      context.errors.notFound.code,
      context.errors.notFound.message,
    );
  }

  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(workspaceId, path, "file_metadata");
  if (
    !filePermissionAllows(
      resolveFilePermissions(context, row.path, true),
      workspaceId,
      claims,
      "read",
      row.path,
    )
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "file access denied by permission policy",
    );
  }

  await context.touchWorkspaceActivity(workspaceId);
  return context.json(fileReadMetadataFromRow(row), 200, {
    ETag: row.revision,
  });
}

/**
 * Maximum write-file payload size, in bytes. Defaults to 10 MiB and is
 * configurable per-deployment via the `RELAYFILE_MAX_WRITE_BYTES` env var.
 * The previous implementation only enforced this AFTER `await request.json()`
 * fully buffered the body into the DO isolate, so an attacker (or a buggy
 * client) could OOM the DO by streaming a multi-hundred-megabyte JSON body
 * with a 10MB-encoded `content` field — the buffered string itself was the
 * problem, not the field inside it. We now reject by Content-Length at the
 * top of the handler before reading the body.
 */
function configuredMaxWriteBytes(context: WorkspaceFsContext): number {
  const raw = (context as { bindings?: { RELAYFILE_MAX_WRITE_BYTES?: string } })
    .bindings?.RELAYFILE_MAX_WRITE_BYTES;
  return maxWriteBytesFromConfig(raw);
}

function effectiveWriteLimit(context: WorkspaceFsContext): number {
  const raw = (context as { bindings?: { RELAYFILE_MAX_WRITE_BYTES?: string } })
    .bindings?.RELAYFILE_MAX_WRITE_BYTES;
  return effectiveWriteLimitFromConfig(raw);
}

/**
 * Validate the `Content-Length` header for a JSON write path.
 *
 * The two JSON write paths (`handleWriteFile`, `handleBulkWrite`) both call
 * `await request.json()` which buffers the entire body into the DO isolate.
 * Without a strict Content-Length requirement a client can bypass the cap by:
 *   1. Using `Transfer-Encoding: chunked` (no Content-Length at all).
 *   2. Omitting the header entirely.
 *   3. Sending an invalid / non-numeric / non-positive Content-Length.
 *
 * Per RFC 7230 §3.3.2, servers MAY require Content-Length on requests with a
 * body. We do — and respond with **411 Length Required** when it's missing
 * or unusable. Combined with `readJsonWithLimit` (defense in depth) this
 * closes the OOM vector even if an upstream proxy strips the header.
 */
function rejectIfContentLengthOverLimit(
  context: WorkspaceFsContext,
  request: Request,
): Response | null {
  const rejection = rejectJsonWriteContentLength(
    request,
    effectiveWriteLimit(context),
  );
  if (rejection) {
    return context.errorResponse(
      request,
      rejection.status,
      rejection.code,
      rejection.message,
    );
  }
  return null;
}

/**
 * Defense-in-depth body reader for the JSON write paths.
 *
 * Even after the Content-Length guard accepts a request, we want to enforce
 * the cap on the wire so a misconfigured upstream proxy that drops or
 * rewrites `Content-Length` cannot punch through. We stream the body
 * through a byte counter, abort once it exceeds the cap, and only then
 * parse it as JSON.
 *
 * On overflow the function throws a thin shape `{ __overflow: true,
 * consumed, limit }` so callers can distinguish it from "invalid JSON".
 */
/**
 * Apply the Content-Length guard, then return a JSON-decoded body that is
 * also size-capped on the wire (defense in depth against proxies that strip
 * the header). On size overflow the response is HTTP 413.
 */
async function readSizeCappedJson<T>(
  context: WorkspaceFsContext,
  request: Request,
): Promise<{ body: T } | { response: Response }> {
  const oversize = rejectIfContentLengthOverLimit(context, request);
  if (oversize) {
    return { response: oversize };
  }
  try {
    const body = await readJsonWithLimit<T>(
      request,
      effectiveWriteLimit(context),
      (fallbackRequest) => context.readJson<T>(fallbackRequest),
    );
    return { body };
  } catch (err) {
    if (err instanceof WriteBodyOverflowError) {
      return {
        response: context.errorResponse(
          request,
          context.errors.payloadTooLarge.status,
          context.errors.payloadTooLarge.code,
          err.message,
        ),
      };
    }
    return {
      response: context.errorResponse(
        request,
        context.errors.badRequest.status,
        context.errors.badRequest.code,
        "invalid json body",
      ),
    };
  }
}

/**
 * Streaming write-file handler (hardening item 2).
 *
 * Wire shape:
 *   PUT /v1/workspaces/{id}/fs/file?path=/notes/x.md
 *   Content-Type: application/octet-stream
 *   X-Relayfile-Encoding: utf-8 | base64
 *   X-Relayfile-Content-Type: text/markdown
 *   If-Match: <ifMatch>
 *   X-Relayfile-Correlation-Id: <corr>   (optional)
 *   <body bytes — raw, NOT base64-encoded>
 *
 * Why: the legacy JSON-base64 path calls `request.json()` followed by
 * `atob(body.content)` — that's TWO full materializations of the payload
 * in the isolate heap (the parsed JSON string + the decoded byte array)
 * for every write. On a 50MB write that's 100MB+ resident, well into the
 * one-DO-per-workspace memory cap. The streaming path:
 *   1) reads metadata from headers (cheap),
 *   2) pipes the request body through a counting/hash transform into
 *      R2.put(ReadableStream),
 *   3) never calls `atob` and never holds the full body in JS at once.
 *
 * The DO heap residency for a 50MB write on this path is bounded by the
 * stream highwater (tens of KB), not the file size.
 */
export async function handleWriteFileStream(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  if (!context.putObjectStream) {
    return context.errorResponse(
      request,
      500,
      "internal_error",
      "streaming putObject not wired",
    );
  }

  const maxBytes = configuredMaxWriteBytes(context);
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null && contentLength.trim() !== "") {
    const parsed = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return context.errorResponse(
        request,
        411,
        "length_required",
        "Content-Length header must be a non-negative integer",
      );
    }
    if (parsed > maxBytes) {
      return context.errorResponse(
        request,
        context.errors.payloadTooLarge.status,
        context.errors.payloadTooLarge.code,
        `request body of ${parsed} bytes exceeds the limit of ${maxBytes} bytes`,
      );
    }
  }

  const url = new URL(request.url);
  const path = normalizePath(
    request.headers.get("X-Relayfile-Path") ??
      url.searchParams.get("path") ??
      "",
  );
  if (!path || path === "/") {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing path",
    );
  }

  const encodingHeader =
    request.headers.get("X-Relayfile-Encoding")?.toLowerCase() ?? "utf-8";
  const encoding = normalizeEncoding(encodingHeader);
  if (!encoding) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "invalid X-Relayfile-Encoding (must be utf-8 or base64)",
    );
  }

  const fileContentType =
    request.headers.get("X-Relayfile-Content-Type")?.trim() ||
    DEFAULT_CONTENT_TYPE;

  const ifMatch = normalizeIfMatchHeader(request.headers.get("If-Match") ?? "");
  if (!ifMatch) {
    return context.errorResponse(
      request,
      context.errors.preconditionFailed.status,
      context.errors.preconditionFailed.code,
      context.errors.preconditionFailed.message,
    );
  }

  const workspaceId = await context.resolveWorkspaceId(request, {
    workspaceId:
      request.headers.get("X-Workspace-Id") ??
      url.searchParams.get("workspaceId") ??
      undefined,
  });
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }
  emitVfsPlaneWriteCandidateMetric(workspaceId, path, "file_put_stream");

  const claims = await context.getRequestClaims(request);
  if (
    isDirectoryPermissionMarkerPath(path) &&
    !canMutatePermissionMarkers(claims)
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "ACL marker mutation requires admin:acl scope",
    );
  }

  const existing = context.getFileRow(path);
  if (existing) {
    if (
      !filePermissionAllows(
        resolveFilePermissions(context, path, true),
        workspaceId,
        claims,
        "write",
        path,
      )
    ) {
      return context.errorResponse(
        request,
        403,
        "forbidden",
        "file access denied by permission policy",
      );
    }
  } else if (
    !filePermissionAllows(
      resolveFilePermissions(context, path, false),
      workspaceId,
      claims,
      "write",
      path,
    )
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "file access denied by permission policy",
    );
  }

  if (!existing && ifMatch !== "0" && ifMatch !== "*") {
    return context.errorResponse(
      request,
      context.errors.notFound.status,
      context.errors.notFound.code,
      context.errors.notFound.message,
    );
  }
  if (existing && ifMatch !== "*" && ifMatch !== existing.revision) {
    return context.errorResponse(
      request,
      context.errors.revisionConflict.status,
      context.errors.revisionConflict.code,
      context.errors.revisionConflict.message,
      {
        expectedRevision: ifMatch,
        currentRevision: existing.revision,
      },
    );
  }

  const body = request.body;
  if (!body) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing request body",
    );
  }

  const revision = context.nextId("rev");
  const now = new Date().toISOString();
  const contentRef = context.contentRef(workspaceId, path, revision);
  const origin = isProviderSyncWriter(claims) ? "provider_sync" : "agent_write";
  const provider = resolveMutationProvider(
    path,
    existing?.provider,
    origin,
    "file_upsert",
  );
  const providerObjectId = existing?.providerObjectId ?? "";

  // Burn the rev counter durably BEFORE the side-effecting R2 put — same
  // ordering invariant as the JSON-base64 path (PR #460 review).
  if (context.flushStorage) {
    await context.flushStorage();
  }

  let hashHex = "";
  let byteLength = 0;
  try {
    const result = await streamToR2WithHash(
      body,
      (stream) =>
        context.putObjectStream!(
          contentRef,
          stream,
          encoding,
          fileContentType,
          workspaceId,
          path,
          revision,
        ),
      { maxBytes },
    );
    hashHex = result.hashHex;
    byteLength = result.byteLength;
    emitMetric("relayfile_writeback_body_bytes", byteLength, {
      workspace_id: workspaceId,
      encoding,
      provider,
    });
  } catch (err) {
    await tryDeleteContent(context, contentRef);
    if (err instanceof StreamByteLimitError) {
      return context.errorResponse(
        request,
        context.errors.payloadTooLarge.status,
        context.errors.payloadTooLarge.code,
        `streamed body of ${err.byteLength} bytes exceeds the limit of ${err.maxBytes} bytes`,
      );
    }
    return context.errorResponse(
      request,
      500,
      "internal_error",
      `streaming write failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  if (byteLength > maxBytes) {
    await tryDeleteContent(context, contentRef);
    return context.errorResponse(
      request,
      context.errors.payloadTooLarge.status,
      context.errors.payloadTooLarge.code,
      `streamed body of ${byteLength} bytes exceeds the limit of ${maxBytes} bytes`,
    );
  }

  // Use the empty semantics object — the streaming wire shape does not
  // carry semantics. Callers that need to write semantics must use the
  // legacy JSON path. (Semantics are a small JSON blob, never the OOM
  // vector — the body bytes are.)
  const semantics = coreNormalizeSemantics(undefined);

  const applied = upsertFileRowMonotonic(context, {
    path,
    revision,
    contentType: fileContentType,
    contentRef,
    size: byteLength,
    encoding,
    updatedAt: now,
    semanticsJson: JSON.stringify(semantics),
    provider,
    providerObjectId,
    contentHash: hashHex,
  });
  if (!applied) {
    await tryDeleteContent(context, contentRef);
    return context.errorResponse(
      request,
      context.errors.revisionConflict.status,
      context.errors.revisionConflict.code,
      context.errors.revisionConflict.message,
      {
        currentRevision: context.getFileRow(path)?.revision,
      },
    );
  }

  const correlationId =
    request.headers.get("X-Relayfile-Correlation-Id")?.trim() ||
    context.correlationId(request);

  const result = await context.recordMutation({
    path,
    revision,
    provider,
    correlationId,
    eventType: existing ? "file.updated" : "file.created",
    action: "file_upsert",
    timestamp: now,
    origin,
  });

  await maybeRefreshWorkspaceDigests(context, workspaceId, {
    changedPaths: [path],
    generatedAt: new Date(now),
    correlationId,
  });

  try {
    await context.touchWorkspaceWriteStats(workspaceId, {
      lastEventAt: now,
      lastActivity: now,
      fileCountDelta: existing ? 0 : 1,
      bytesStoredDelta: byteLength - (existing?.size ?? 0),
      operationCountDelta: origin === "provider_sync" ? 0 : 1,
    });
  } catch (err) {
    console.error(
      "handleWriteFileStream: touchWorkspaceWriteStats failed",
      err,
    );
  }

  return context.json(result, 202);
}

export async function handleWriteFile(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  // Hardening item 2: when the request is `application/octet-stream` (with
  // metadata in headers), stream the body straight to R2 and compute the
  // SHA-256 incrementally. The DO never materializes the full payload.
  // The streaming path has its own size enforcement (chunked read with a
  // running counter) — only the JSON path needs the Content-Length-required
  // guard, because that path calls `await request.json()` which buffers
  // the whole body unconditionally.
  const requestCT = request.headers.get("Content-Type")?.toLowerCase() ?? "";
  if (
    requestCT.startsWith("application/octet-stream") &&
    context.putObjectStream
  ) {
    return handleWriteFileStream(context, request);
  }

  // P0 (JSON path only): require Content-Length AND enforce the cap on the
  // wire. A missing or invalid header yields 411 Length Required; a body
  // that exceeds the cap on the wire (even with a lying / stripped header)
  // yields 413 Payload Too Large. Both responses are produced BEFORE the
  // body is parsed into the DO heap.
  const guarded = await readSizeCappedJson<Partial<WriteFileRequest>>(
    context,
    request,
  );
  if ("response" in guarded) {
    return guarded.response;
  }
  const body = guarded.body;
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const url = new URL(request.url);
  const path = normalizePath(body.path ?? url.searchParams.get("path") ?? "");
  if (!path || (path === "/" && !(body.path ?? url.searchParams.get("path")))) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing path",
    );
  }
  emitVfsPlaneWriteCandidateMetric(workspaceId, path, "file_put");

  const ifMatch = normalizeIfMatchHeader(
    request.headers.get("If-Match") ??
      body.ifMatch ??
      url.searchParams.get("ifMatch") ??
      "",
  );
  if (!ifMatch) {
    return context.errorResponse(
      request,
      context.errors.preconditionFailed.status,
      context.errors.preconditionFailed.code,
      context.errors.preconditionFailed.message,
    );
  }
  if (typeof body.content !== "string") {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing content",
    );
  }

  const encoding = normalizeEncoding(body.encoding);
  if (!encoding || !validateEncodedContent(body.content, encoding)) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "invalid encoded content",
    );
  }

  const claims = await context.getRequestClaims(request);
  if (
    isDirectoryPermissionMarkerPath(path) &&
    !canMutatePermissionMarkers(claims)
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "ACL marker mutation requires admin:acl scope",
    );
  }

  const existing = context.getFileRow(path);
  if (existing) {
    if (
      !filePermissionAllows(
        resolveFilePermissions(context, path, true),
        workspaceId,
        claims,
        "write",
        path,
      )
    ) {
      return context.errorResponse(
        request,
        403,
        "forbidden",
        "file access denied by permission policy",
      );
    }
  } else if (
    !filePermissionAllows(
      resolveFilePermissions(context, path, false),
      workspaceId,
      claims,
      "write",
      path,
    )
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "file access denied by permission policy",
    );
  }

  if (!existing && ifMatch !== "0" && ifMatch !== "*") {
    return context.errorResponse(
      request,
      context.errors.notFound.status,
      context.errors.notFound.code,
      context.errors.notFound.message,
    );
  }
  if (existing && ifMatch !== "*" && ifMatch !== existing.revision) {
    return context.errorResponse(
      request,
      context.errors.revisionConflict.status,
      context.errors.revisionConflict.code,
      context.errors.revisionConflict.message,
      {
        expectedRevision: ifMatch,
        currentRevision: existing.revision,
        currentContentPreview: truncatePreview(
          await context.loadContent(existing.contentRef, existing.encoding),
        ),
      },
    );
  }

  const revision = context.nextId("rev");
  const now = new Date().toISOString();
  const contentType = body.contentType?.trim() || DEFAULT_CONTENT_TYPE;
  const contentRef = context.contentRef(workspaceId, path, revision);
  const origin = isProviderSyncWriter(claims) ? "provider_sync" : "agent_write";
  const provider = resolveMutationProvider(
    path,
    existing?.provider,
    origin,
    "file_upsert",
  );
  const providerObjectId = existing?.providerObjectId ?? "";
  const semantics = coreNormalizeSemantics(body.semantics);
  // SHA-256 hex of the raw bytes — must match what the daemon computes via
  // hashBytes in internal/mountsync/syncer.go. Persisted on the files row
  // so /fs/file, /fs/tree, and /fs/events responses can surface it,
  // activating the daemon's defensive cross-check from relayfile PR #90.
  const contentHash = await hashContent(body.content, encoding);

  if (encodedSize(body.content, encoding) > configuredMaxWriteBytes(context)) {
    return context.errorResponse(
      request,
      context.errors.payloadTooLarge.status,
      context.errors.payloadTooLarge.code,
      context.errors.payloadTooLarge.message,
    );
  }

  // productId is optional on the JWT (wave-1+ tokens) — fall back to
  // agentName so dedup records still carry an identifiable writer. Only if
  // both are missing (e.g., unauthenticated write, which shouldn't reach
  // here) do we record "unknown".
  const originalWriter = originalDedupWriter(claims);
  const dedupCheck = await checkDedupWrite(
    context,
    workspaceId,
    body.contentIdentity,
    originalWriter,
  );
  if (dedupCheck.kind === "deduped") {
    return context.json(dedupCheck.response, 200);
  }

  // Order is load-bearing — see PR description (rev_96 hash divergence) and
  // PR #460 review (Codex P1: don't commit files row before R2 succeeds).
  //
  //   1. Burn the rev counter durably via flushStorage so a later throw
  //      cannot rewind it and let a future write reuse rev_N with different
  //      bytes (the daemon's event would still reference the original).
  //   2. putObject to R2. If this throws, the rev counter is already burned
  //      (monotonic — fine) and the files row was never INSERTed.
  //   3. INSERT files row (with monotonic guard against a concurrent write
  //      that already wrote a NEWER rev) and recordMutation (which inserts
  //      the event row + writeback op via the core adapter, flushes them,
  //      then broadcasts and dispatches writeback).
  if (context.flushStorage) {
    await context.flushStorage();
  }

  await context.putObject(
    contentRef,
    body.content,
    encoding,
    contentType,
    workspaceId,
    path,
    revision,
  );

  // Monotonic guard: if a concurrent write on the same path already
  // committed a NEWER revision, drop this older write rather than letting
  // ON CONFLICT blindly take excluded.revision and clobber the newer row.
  // Compare the numeric suffix of the rev id, NOT the TEXT — `nextId`
  // emits unpadded ids like rev_9 / rev_10, so lexicographic comparison
  // (rev_10 > rev_9) evaluates false. SUBSTR(..., 5) skips the literal
  // `rev_` prefix; CAST AS INTEGER coerces the numeric suffix.
  const applied = upsertFileRowMonotonic(context, {
    path,
    revision,
    contentType,
    contentRef,
    size: encodedSize(body.content, encoding),
    encoding,
    updatedAt: now,
    semanticsJson: JSON.stringify(semantics),
    provider,
    providerObjectId,
    contentHash,
  });
  if (!applied) {
    await tryDeleteContent(context, contentRef);
    return context.errorResponse(
      request,
      context.errors.revisionConflict.status,
      context.errors.revisionConflict.code,
      context.errors.revisionConflict.message,
      {
        currentRevision: context.getFileRow(path)?.revision,
      },
    );
  }

  // Server-side threading: lift a parent reference off the draft body so the op
  // is ordered after — and threads onto — its parent. Agent writes only.
  const parentRef =
    origin === "provider_sync"
      ? undefined
      : extractParentRef(body.content, encoding);
  const result = await context.recordMutation({
    path,
    revision,
    provider,
    correlationId: body.correlationId ?? context.correlationId(request),
    eventType: existing ? "file.updated" : "file.created",
    action: "file_upsert",
    timestamp: now,
    origin,
    ...(parentRef ? { parentRef } : {}),
  });

  await maybeRefreshWorkspaceDigests(context, workspaceId, {
    changedPaths: [path],
    generatedAt: new Date(now),
    correlationId: body.correlationId ?? context.correlationId(request),
  });

  // Commit the dedup key only after the write has actually persisted
  // (sqlExec + putObject + recordMutation all completed). If any of those
  // threw above, we never reach here, so the dedup KV entry never gets
  // written and retries will be processed normally instead of falsely
  // returning {deduped: true}.
  if (dedupCheck.kind === "proceed" && dedupCheck.reservation) {
    await dedupCheck.reservation.commit();
  }

  // Keep prior revision content in R2. Digest rendering dereferences event
  // revisions, so deleting old content here can erase terminal-state wording
  // after a later same-day update.

  // Stats writes are observability — they hit other DOs and can throw
  // "Durable Object overloaded". They MUST NOT roll back the rev counter
  // or files row.
  try {
    await context.touchWorkspaceWriteStats(workspaceId, {
      lastEventAt: now,
      lastActivity: now,
      fileCountDelta: existing ? 0 : 1,
      bytesStoredDelta:
        encodedSize(body.content, encoding) - (existing?.size ?? 0),
      operationCountDelta: origin === "provider_sync" ? 0 : 1,
    });
  } catch (err) {
    console.error("handleWriteFile: touchWorkspaceWriteStats failed", err);
  }
  return context.json(result, 202);
}

export async function handleDeleteFile(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<DeleteFileRequest>(request);
  return handleDeleteFileWithBody(context, request, body);
}

export async function handleDeleteFileAny(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  let body: Partial<DeleteFileRequest> | undefined;
  try {
    body = request.headers.get("Content-Type")?.includes("application/json")
      ? ((await request.json()) as Partial<DeleteFileRequest>)
      : undefined;
  } catch {
    body = undefined;
  }

  const url = new URL(request.url);
  return handleDeleteFileWithBody(context, request, {
    workspaceId: body?.workspaceId,
    path: body?.path ?? url.searchParams.get("path") ?? "",
    ifMatch:
      body?.ifMatch ??
      request.headers.get("If-Match") ??
      url.searchParams.get("ifMatch") ??
      "",
    correlationId: body?.correlationId,
  });
}

export async function handleDeleteFileWithBody(
  context: WorkspaceFsContext,
  request: Request,
  body: DeleteFileRequest,
): Promise<Response> {
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const path = normalizePath(body.path);
  if (!path || (path === "/" && !body.path.trim())) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing path",
    );
  }
  emitVfsPlaneWriteCandidateMetric(workspaceId, path, "file_delete");

  const ifMatch = normalizeIfMatchHeader(body.ifMatch);
  if (!ifMatch) {
    return context.errorResponse(
      request,
      context.errors.preconditionFailed.status,
      context.errors.preconditionFailed.code,
      context.errors.preconditionFailed.message,
    );
  }

  const claims = await context.getRequestClaims(request);
  if (
    isDirectoryPermissionMarkerPath(path) &&
    !canMutatePermissionMarkers(claims)
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "ACL marker mutation requires admin:acl scope",
    );
  }

  const existing = context.getFileRow(path);
  if (!existing) {
    return context.errorResponse(
      request,
      context.errors.notFound.status,
      context.errors.notFound.code,
      context.errors.notFound.message,
    );
  }

  if (
    !filePermissionAllows(
      resolveFilePermissions(context, path, true),
      workspaceId,
      claims,
      "write",
      path,
    )
  ) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "file access denied by permission policy",
    );
  }
  if (ifMatch !== "*" && ifMatch !== existing.revision) {
    return context.errorResponse(
      request,
      context.errors.revisionConflict.status,
      context.errors.revisionConflict.code,
      context.errors.revisionConflict.message,
      {
        expectedRevision: ifMatch,
        currentRevision: existing.revision,
        currentContentPreview: truncatePreview(
          await context.loadContent(existing.contentRef, existing.encoding),
        ),
      },
    );
  }

  const revision = context.nextId("rev");
  const now = new Date().toISOString();
  context.sqlExec("DELETE FROM files WHERE path = ?", path);
  const origin = isProviderSyncWriter(claims) ? "provider_sync" : "agent_write";
  const provider = resolveMutationProvider(
    path,
    existing.provider,
    origin,
    "file_delete",
  );

  const result = await context.recordMutation({
    path,
    revision,
    provider,
    correlationId: body.correlationId ?? context.correlationId(request),
    eventType: "file.deleted",
    action: "file_delete",
    timestamp: now,
    origin,
  });

  await maybeRefreshWorkspaceDigests(context, workspaceId, {
    changedPaths: [path],
    generatedAt: new Date(now),
    correlationId: body.correlationId ?? context.correlationId(request),
  });

  if (existing.contentRef) {
    await tryDeleteContent(context, existing.contentRef);
  }

  try {
    await context.touchWorkspaceWriteStats(workspaceId, {
      lastEventAt: now,
      lastActivity: now,
      fileCountDelta: -1,
      bytesStoredDelta: -existing.size,
      operationCountDelta: origin === "provider_sync" ? 0 : 1,
    });
  } catch (err) {
    console.error("handleDeleteFile: touchWorkspaceWriteStats failed", err);
  }
  return context.json(result, 202);
}

export async function handleListEvents(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<ListEventsRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  emitVfsPlaneResolvedMetric(
    workspaceId,
    body.provider ? `/${body.provider}` : "/",
    "events",
  );
  return context.json(
    listEvents(
      context,
      workspaceId,
      body.provider,
      body.cursor ?? null,
      body.limit ?? 200,
      normalizeEventFeedDirection(body.direction),
    ),
  );
}

export async function handleListEventsGet(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.resolveWorkspaceId(request);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const url = new URL(request.url);
  const provider = url.searchParams.get("provider") ?? undefined;
  emitVfsPlaneResolvedMetric(
    workspaceId,
    provider ? `/${provider}` : "/",
    "events",
  );
  return context.json(
    listEvents(
      context,
      workspaceId,
      provider,
      url.searchParams.get("cursor"),
      clampInt(url.searchParams.get("limit"), 200, 1, 1000),
      normalizeEventFeedDirection(url.searchParams.get("direction")),
    ),
  );
}

export async function handleListChangesGet(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.resolveWorkspaceId(request);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const url = new URL(request.url);
  const lastParam = url.searchParams.get("last");
  const sinceParam = url.searchParams.get("since");
  const limit =
    lastParam !== null
      ? clampInt(lastParam, 100, 0, 1000)
      : clampInt(url.searchParams.get("limit"), 200, 1, 1000);

  emitVfsPlaneResolvedMetric(workspaceId, "/", "changes");
  return context.json({
    events: listChanges(context, workspaceId, {
      last: lastParam !== null,
      since: sinceParam,
      limit,
    }),
  });
}

export async function handleGetChangeResourceGet(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.resolveWorkspaceId(request);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const eventId = new URL(request.url).searchParams.get("eventId")?.trim();
  if (!eventId) {
    return context.errorResponse(
      request,
      context.errors.badRequest.status,
      context.errors.badRequest.code,
      "missing eventId",
    );
  }

  const event = getEventById(context, eventId);
  if (!event) {
    return context.errorResponse(
      request,
      context.errors.notFound.status,
      context.errors.notFound.code,
      "event not found",
    );
  }

  const claims = await context.getRequestClaims(request);
  if (!claims || !scopeMatchesPath(claims, "fs:read", event.path)) {
    return context.errorResponse(
      request,
      403,
      "forbidden",
      "missing required scope: fs:read",
    );
  }

  return context.json(await getChangeResourceAtEvent(context, event));
}

export async function handleQueryFiles(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<QueryFilesRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(
    workspaceId,
    body.path ?? body.pathPrefix ?? "/",
    "query",
  );
  await context.touchWorkspaceActivity(workspaceId);
  return context.json(queryFiles(context, workspaceId, body, claims));
}

export async function handleQueryFilesGet(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.resolveWorkspaceId(request);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const url = new URL(request.url);
  const properties: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (key.startsWith("property.")) {
      properties[key.slice("property.".length)] = value;
    }
  }

  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(
    workspaceId,
    url.searchParams.get("path") ?? url.searchParams.get("pathPrefix") ?? "/",
    "query",
  );
  await context.touchWorkspaceActivity(workspaceId);
  return context.json(
    queryFiles(
      context,
      workspaceId,
      {
        path:
          url.searchParams.get("path") ??
          url.searchParams.get("pathPrefix") ??
          undefined,
        pathPrefix: url.searchParams.get("pathPrefix") ?? undefined,
        provider: url.searchParams.get("provider") ?? undefined,
        relation: url.searchParams.get("relation") ?? undefined,
        permission: url.searchParams.get("permission") ?? undefined,
        comment: url.searchParams.get("comment") ?? undefined,
        properties,
        cursor: url.searchParams.get("cursor"),
        limit: clampInt(url.searchParams.get("limit"), 100, 1, 1000),
      },
      claims,
    ),
  );
}

export async function handleBulkWrite(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  // Same Content-Length-required guard plus on-the-wire cap as
  // handleWriteFile. Missing/invalid header → 411 Length Required;
  // body exceeds cap on the wire → 413 Payload Too Large.
  const guarded = await readSizeCappedJson<BulkWriteRequest>(context, request);
  if ("response" in guarded) {
    return guarded.response;
  }
  const body = guarded.body;
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "files must be a non-empty array",
    );
  }

  const claims = await context.getRequestClaims(request);
  const skipDigestRefresh = isGithubCloneWriter(claims);
  emitVfsPlaneWriteCandidateMetrics(
    workspaceId,
    body.files.map((file) => file.path),
    "bulk_write",
  );
  const committedPaths: string[] = [];
  const jobId =
    body.jobId ?? extractGithubCloneJobId(context.correlationId(request));
  const startedAt = Date.now();

  const result = await bulkWrite(
    context,
    workspaceId,
    body.files,
    context.correlationId(request),
    claims,
    {
      onCommittedPath: (path) => {
        committedPaths.push(path);
      },
    },
  );
  if (jobId) {
    console.info("relayfile.github_clone.bulk_write.completed", {
      jobId,
      workspaceId,
      files: result.written,
      bytes: result.bytesWritten,
      syncCount: result.syncCount,
      durationMs: Date.now() - startedAt,
      errorCount: result.errorCount,
      correlationId: result.correlationId,
    });
  }
  const now = new Date().toISOString();
  if (result.written > 0 && !skipDigestRefresh) {
    await maybeRefreshWorkspaceDigests(context, workspaceId, {
      changedPaths: committedPaths,
      generatedAt: new Date(now),
      correlationId: context.correlationId(request),
    });
  }
  try {
    await context.touchWorkspaceWriteStats(workspaceId, {
      lastEventAt: now,
      lastActivity: now,
      fileCountDelta: result.fileCountDelta,
      bytesStoredDelta: result.bytesStoredDelta,
      operationCountDelta: result.operationCountDelta,
    });
  } catch (err) {
    console.error("handleBulkWrite: touchWorkspaceWriteStats failed", err);
  }
  return context.json(result, 202);
}

export async function handleRegisterImportedContent(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const rawBody = await request.clone().arrayBuffer();
  const body = await context.readJson<RegisterImportedContentRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }
  if (!Array.isArray(body.files) || body.files.length === 0) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "files must be a non-empty array",
    );
  }

  const claims =
    (await internalGithubCloneWriterClaims(
      context,
      request,
      rawBody,
      workspaceId,
    )) ?? (await context.getRequestClaims(request));
  emitVfsPlaneWriteCandidateMetrics(
    workspaceId,
    body.files.map((file) => file.path),
    "register_imported_content",
  );
  const result = await registerImportedContent(
    context,
    workspaceId,
    body.files,
    context.correlationId(request),
    claims,
  );

  const now = new Date().toISOString();
  if (result.written > 0 && !isGithubCloneWriter(claims)) {
    await maybeRefreshWorkspaceDigests(context, workspaceId, {
      changedPaths: result.committedPaths,
      generatedAt: new Date(now),
      correlationId: context.correlationId(request),
    });
  }
  try {
    await context.touchWorkspaceWriteStats(workspaceId, {
      lastEventAt: now,
      lastActivity: now,
      fileCountDelta: result.fileCountDelta,
      bytesStoredDelta: result.bytesStoredDelta,
      operationCountDelta: result.operationCountDelta,
    });
  } catch (err) {
    console.error(
      "handleRegisterImportedContent: touchWorkspaceWriteStats failed",
      err,
    );
  }

  if (body.jobId) {
    console.info("relayfile.github_clone.tar_import.registered", {
      jobId: body.jobId,
      workspaceId,
      files: result.written,
      bytes: result.bytesWritten,
      syncCount: result.syncCount,
      durationMs: result.durationMs,
      errorCount: result.errorCount,
      correlationId: result.correlationId,
    });
  }

  return context.json(
    {
      written: result.written,
      errorCount: result.errorCount,
      errors: result.errors,
      correlationId: result.correlationId,
      bytesWritten: result.bytesWritten,
      syncCount: result.syncCount,
    },
    202,
  );
}

async function internalGithubCloneWriterClaims(
  context: WorkspaceFsContext,
  request: Request,
  rawBody: ArrayBuffer,
  workspaceId: string,
): Promise<TokenClaims | null> {
  if (
    request.headers.get("X-Relayfile-Internal-Agent")?.trim() !==
    "github-clone-worker"
  ) {
    return null;
  }
  await verifyInternalHmac(
    request.headers,
    rawBody,
    context.internalHmacSecret,
  );
  return {
    workspaceId,
    agentName: "github-clone-worker",
    scopes: new Set([
      "fs:read",
      "fs:write",
      "sync:read",
      "sync:trigger",
      "admin:acl",
    ]),
    exp: Math.floor(Date.now() / 1000) + 300,
  };
}

async function maybeRefreshWorkspaceDigests(
  context: WorkspaceFsContext,
  _workspaceId: string,
  options: {
    changedPaths: readonly string[];
    generatedAt: Date;
    correlationId: string;
  },
): Promise<void> {
  // Defer to the DO's debounced alarm-based refresh. The full
  // `refreshWorkspaceDigests` body (multi-window, per-event R2 content
  // loads) used to run inline here on the write path, which made every PUT
  // on a busy workspace time out at 60s (cloud#846). The DO short-circuits
  // digest-only/empty change sets internally; the workspaceId argument is
  // implicit on the DO (one instance per workspace) so we drop it here.
  try {
    await context.scheduleDigestRefresh(options);
  } catch (err) {
    console.error("maybeRefreshWorkspaceDigests: schedule failed", err);
  }
}

function extractGithubCloneJobId(correlationId: string): string | undefined {
  const match = /^github-clone-job:([^:]+):chunk:\d+$/.exec(correlationId);
  return match?.[1];
}

type FileRowUpsert = {
  path: string;
  revision: string;
  contentType: string;
  contentRef: string;
  size: number;
  encoding: "utf-8" | "base64";
  updatedAt: string;
  semanticsJson: string;
  provider: string;
  providerObjectId: string;
  contentHash: string;
};

function upsertFileRowMonotonic(
  context: WorkspaceFsContext,
  row: FileRowUpsert,
): boolean {
  context.sqlExec(
    `
      INSERT INTO files (
        path, revision, content_type, content_ref, size, encoding, updated_at,
        semantics_json, provider, provider_object_id, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        revision = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.revision ELSE files.revision END,
        content_type = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.content_type ELSE files.content_type END,
        content_ref = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.content_ref ELSE files.content_ref END,
        size = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.size ELSE files.size END,
        encoding = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.encoding ELSE files.encoding END,
        updated_at = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.updated_at ELSE files.updated_at END,
        semantics_json = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.semantics_json ELSE files.semantics_json END,
        provider = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.provider ELSE files.provider END,
        provider_object_id = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.provider_object_id ELSE files.provider_object_id END,
        content_hash = CASE WHEN CAST(SUBSTR(excluded.revision, 5) AS INTEGER)
            > CAST(SUBSTR(files.revision, 5) AS INTEGER)
          THEN excluded.content_hash ELSE files.content_hash END
    `,
    row.path,
    row.revision,
    row.contentType,
    row.contentRef,
    row.size,
    row.encoding,
    row.updatedAt,
    row.semanticsJson,
    row.provider,
    row.providerObjectId,
    row.contentHash,
  );

  const applied = context.getFileRow(row.path);
  return (
    applied?.revision === row.revision && applied.contentRef === row.contentRef
  );
}

export async function handleExportWorkspace(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<ExportWorkspaceRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(workspaceId, body.pathPrefix ?? "/", "export");
  await context.touchWorkspaceActivity(workspaceId);
  return exportWorkspaceResponse(
    context,
    workspaceId,
    body.format ?? "json",
    claims,
    body.pathPrefix ?? null,
  );
}

export async function handleExportWorkspaceGet(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.resolveWorkspaceId(request);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const format = (new URL(request.url).searchParams.get("format") ??
    "json") as ExportFormat;
  const pathPrefix = new URL(request.url).searchParams.get("pathPrefix");
  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(workspaceId, pathPrefix ?? "/", "export");
  await context.touchWorkspaceActivity(workspaceId);
  return exportWorkspaceResponse(
    context,
    workspaceId,
    format,
    claims,
    pathPrefix,
  );
}

/**
 * Internal DO endpoint that returns one keyset-paginated page of the
 * export manifest — METADATA ONLY, never a file body. The parent Worker
 * pages through this and streams R2 bodies directly, which is the
 * structural OOM guarantee for export (hardening item 1).
 *
 * Request body (POST /internal/export-manifest):
 *   { workspaceId: string, afterPath?: string | null, pageSize?: number }
 *
 * Response 200:
 *   {
 *     fileCount: number,           // ACL-visible count — for ceiling
 *     entries: ExportManifestEntry[],
 *     nextCursor: string | null,
 *   }
 */
export async function handleExportManifest(
  context: WorkspaceFsContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<{
    workspaceId?: string;
    afterPath?: string | null;
    pageSize?: number;
    maxBodyBytes?: number;
    pathPrefix?: string | null;
  }>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      context.errors.invalidInput.status,
      context.errors.invalidInput.code,
      "missing workspaceId",
    );
  }

  const claims = await context.getRequestClaims(request);
  emitVfsPlaneResolvedMetric(
    workspaceId,
    body.pathPrefix ?? "/",
    "export_manifest",
  );

  // Enforce the export-files ceiling on the FIRST page only so the parent
  // Worker can fail fast (413) without paging through the whole table.
  const isFirstPage = body.afterPath == null || body.afterPath === "";
  const claimsForAcl = claims as Parameters<
    typeof listWorkspaceExportManifestPage
  >[2];
  const exportLimit = maxExportFiles(context);
  const maxBodyBytes =
    typeof body.maxBodyBytes === "number" && body.maxBodyBytes > 0
      ? body.maxBodyBytes
      : Number.POSITIVE_INFINITY;
  const summary = isFirstPage
    ? summarizeExportableWorkspaceFiles(context, workspaceId, claimsForAcl, {
        stopAfterCount: exportLimit + 1,
        stopAfterBytes: maxBodyBytes,
        pathPrefix: body.pathPrefix ?? null,
        aclOptions: cloudReadAclOptions(),
      })
    : null;
  const fileCount = summary?.fileCount ?? -1;
  if (isFirstPage) {
    if (summary?.exceededFileLimit) {
      return context.errorResponse(
        request,
        context.errors.payloadTooLarge.status,
        context.errors.payloadTooLarge.code,
        `workspace has more than ${exportLimit} exportable files which exceeds the export limit of ${exportLimit}; ` +
          `use the paginated tree/read APIs (GET /fs/tree, GET /fs/file) instead`,
      );
    }
    if (summary?.exceededBodyLimit) {
      return context.errorResponse(
        request,
        context.errors.payloadTooLarge.status,
        context.errors.payloadTooLarge.code,
        `workspace export body is more than ${maxBodyBytes} bytes, which exceeds the export body limit of ${maxBodyBytes}; ` +
          `use the paginated tree/read APIs (GET /fs/tree, GET /fs/file) instead`,
        {
          bodyLimit: maxBodyBytes,
          estimatedBodyBytes: summary.totalSizeBytes,
        },
      );
    }

    // Hardening item 4: admission control — even within the file-count
    // ceiling, a heavy semantics_json per row can push the metadata
    // working set past the DO memory budget. Reject before we start
    // paging if the estimate exceeds the budget. The parent Worker uses
    // the typed error code to surface a clear paging instruction.
    const budget = resolveDoMemoryBudgetBytes(
      ((context as { bindings?: Record<string, string> }).bindings ?? {}) as {
        RELAYFILE_DO_MEMORY_BUDGET_BYTES?: string;
      },
    );
    const decision = decideAdmission(
      {
        fileCount,
        residentFileRows: Math.min(fileCount, EXPORT_FILE_PAGE_SIZE),
        residentMetadataBytes: estimateExportManifestPageBytes(
          context,
          EXPORT_FILE_PAGE_SIZE,
          body.pathPrefix ?? null,
        ),
      },
      budget,
    );
    if (!decision.admit) {
      emitMetric("relayfile_admission_rejected_total", 1, {
        workspace_id: workspaceId,
        reason: decision.reason,
        handler: "export_manifest",
      });
      return context.errorResponse(
        request,
        413,
        decision.reason,
        decision.message,
        { budget: decision.budget, estimate: decision.estimate },
      );
    }

    // Workspace-shape gauges — emitted once per first-page manifest call
    // so an operator dashboard can graph workspace size over time.
    emitMetric("relayfile_workspace_file_count", fileCount, {
      workspace_id: workspaceId,
    });
    emitMetric(
      "relayfile_workspace_memory_high_water",
      decision.estimate.estimatedBytes,
      { workspace_id: workspaceId },
    );
  }

  const pageSize =
    typeof body.pageSize === "number" && body.pageSize > 0
      ? Math.min(body.pageSize, EXPORT_FILE_PAGE_SIZE)
      : EXPORT_FILE_PAGE_SIZE;
  const page = listWorkspaceExportManifestPage(
    context,
    workspaceId,
    claimsForAcl,
    body.afterPath ?? null,
    pageSize,
    body.pathPrefix ?? null,
    cloudReadAclOptions(),
  );

  return context.json({
    fileCount,
    entries: page.entries,
    nextCursor: page.nextCursor,
  });
}

export function listTree(
  context: WorkspaceFsContext,
  workspaceId: string,
  path: string,
  depth: number,
  cursor: string | null,
  claims: TokenClaims | null,
): TreeResponse {
  const base = normalizePath(path);
  let rows: WorkspaceFile[] = [];
  let scanCursor = cursor ? normalizePath(cursor) : null;
  let pageWasFull = false;
  let entries: TreeResponse["entries"] = [];
  let fileByPath = new Map<string, WorkspaceFile>();
  let resultPath = base;
  const normalizedCursor = cursor ? normalizePath(cursor) : null;

  // Keep scanning capped SQL pages until this tree page has something visible.
  // This avoids empty continuation pages when many raw descendants collapse to
  // an already-emitted shallow directory, while only materializing one capped
  // row page at a time.
  for (;;) {
    const page = scanWorkspaceFileRows(
      context,
      base,
      scanCursor,
      MAX_LIST_ROWS,
    );
    const virtualRuntimeFiles =
      getRuntimeFilesUnderBase(base).map(runtimeWorkspaceFile);
    if (page.rows.length === 0) {
      pageWasFull = false;
      rows = virtualRuntimeFiles;
      if (rows.length === 0) {
        break;
      }
    } else {
      rows = [...page.rows, ...virtualRuntimeFiles];
      scanCursor = page.rows[page.rows.length - 1]?.path ?? scanCursor;
      pageWasFull = page.rows.length >= MAX_LIST_ROWS;
    }

    fileByPath = new Map(rows.map((row) => [row.path, row]));
    const adapter = {
      ...createCoreStorageAdapter(context, workspaceId),
      listFiles: () => rows.map((row) => toCoreFileRow(row)),
    };
    const result = coreListTree(
      adapter,
      {
        path: base,
        depth,
      },
      claims,
      cloudReadAclOptions(),
    );
    resultPath = result.path;

    entries = result.entries
      .filter((entry) => !normalizedCursor || entry.path > normalizedCursor)
      .slice(0, MAX_LIST_ROWS)
      .map((entry) => {
        if (entry.type !== "file") {
          return {
            path: entry.path,
            type: "dir" as const,
            revision: "dir",
          };
        }

        const file = fileByPath.get(entry.path);
        const semantics = file
          ? coreParseSemantics(file.semanticsJson)
          : undefined;
        return {
          path: entry.path,
          type: "file" as const,
          revision: entry.revision ?? "",
          provider: file?.provider || undefined,
          providerObjectId: file?.providerObjectId || undefined,
          size: file?.size ?? entry.size,
          updatedAt: file?.updatedAt ?? entry.updatedAt,
          propertyCount: entry.propertyCount,
          relationCount: entry.relationCount,
          permissionCount: semantics?.permissions?.length ?? 0,
          commentCount: semantics?.comments?.length ?? entry.commentCount,
          // Wire extension over the SDK's TreeEntry — see types.ts and the
          // daemon defensive cross-check in relayfile PR #90.
          ...(file?.contentHash ? { contentHash: file.contentHash } : {}),
        };
      });

    if (entries.length > 0 || !pageWasFull) {
      break;
    }
  }

  const lastEmittedRealPath =
    [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.type === "file" &&
          !getRuntimeFileByPath(entry.path) &&
          fileByPath.has(entry.path),
      )?.path ?? null;
  const cursorPath =
    pageWasFull && lastEmittedRealPath ? lastEmittedRealPath : scanCursor;

  return {
    path: resultPath,
    entries,
    nextCursor: pageWasFull ? (cursorPath ?? null) : null,
  };
}

export function diagnoseListTreePathRange(
  context: WorkspaceFsContext,
  workspaceId: string,
  path: string,
  depth: number,
  cursor: string | null,
  claims: TokenClaims | null,
  tree: TreeResponse,
  diagFilePath?: string | null,
): ListTreePathRangeDiagnostic {
  const base = normalizePath(path);
  const normalizedCursor = cursor ? normalizePath(cursor) : null;
  const [lower, upper] = descendantPathRange(base);
  const sampleLimit = 20;
  const countRow = context.allRows<Row & { count?: unknown }>(
    `
      SELECT COUNT(*) AS count
      FROM files
      WHERE (path = ? OR (path >= ? AND path < ?))
    `,
    base,
    lower,
    upper,
  )[0];
  const count = Number(countRow?.count ?? 0);
  const sampleRows = scanWorkspaceFileRows(
    context,
    base,
    normalizedCursor,
    sampleLimit,
  ).rows;
  const summarizeFile = (file: WorkspaceFile) => {
    const permissions = resolveFilePermissions(context, file.path, true);
    const aclAllowed = filePermissionAllows(
      permissions,
      workspaceId,
      claims,
      "read",
      file.path,
    );
    return {
      path: file.path,
      revision: file.revision,
      ...(file.provider ? { provider: file.provider } : {}),
      ...(file.providerObjectId
        ? { providerObjectId: file.providerObjectId }
        : {}),
      aclAllowed,
      permissionCount: permissions.length,
    };
  };
  const sample = sampleRows.map(summarizeFile).filter((row) => row.aclAllowed);
  const directFile =
    diagFilePath?.trim() != null && diagFilePath.trim() !== ""
      ? (() => {
          const normalizedPath = normalizePath(diagFilePath);
          const file = context.getFileRow(normalizedPath);
          if (!file) {
            return { path: normalizedPath, exists: false };
          }
          const permissions = resolveFilePermissions(context, file.path, true);
          return {
            path: file.path,
            exists: true,
            revision: file.revision,
            ...(file.provider ? { provider: file.provider } : {}),
            ...(file.providerObjectId
              ? { providerObjectId: file.providerObjectId }
              : {}),
            size: file.size,
            aclAllowed: filePermissionAllows(
              permissions,
              workspaceId,
              claims,
              "read",
              file.path,
            ),
            permissionCount: permissions.length,
          };
        })()
      : null;

  return {
    mode: "path-range",
    base,
    depth,
    cursor: normalizedCursor,
    range: { lower, upper },
    directFile,
    prefix: {
      count: Number.isFinite(count) ? count : 0,
      sampleLimit,
      sampleCount: sample.length,
      firstPath: sample[0]?.path ?? null,
      lastPath: sample[sample.length - 1]?.path ?? null,
      sample,
    },
    tree: {
      entryCount: tree.entries.length,
      nextCursor: tree.nextCursor,
      sample: tree.entries.slice(0, sampleLimit).map((entry) => ({
        path: entry.path,
        type: entry.type,
        revision: entry.revision,
      })),
    },
  };
}

export async function readFile(
  context: Pick<WorkspaceFsContext, "getFileRow" | "loadContent">,
  path: string,
): Promise<FileReadResponse | null> {
  const normalized = normalizePath(path);
  const runtimeFile = getRuntimeFileByPath(normalized);
  if (runtimeFile) {
    return runtimeReadResponse(runtimeFile);
  }

  const row = context.getFileRow(normalized);
  if (!row) {
    return null;
  }

  return {
    path: row.path,
    revision: row.revision,
    contentType: row.contentType,
    content: await context.loadContent(row.contentRef, row.encoding),
    encoding: row.encoding,
    provider: row.provider || undefined,
    providerObjectId: row.providerObjectId || undefined,
    lastEditedAt: row.updatedAt,
    semantics: coreParseSemantics(row.semanticsJson),
    // Wire extension over the SDK's FileReadResponse — surfaces the
    // SHA-256 hex of the file content so the daemon can compare against
    // its locally-tracked hash (relayfile PR #90 defensive cross-check).
    ...(row.contentHash ? { contentHash: row.contentHash } : {}),
  } as FileReadResponse & { contentHash?: string };
}

function fileReadMetadataFromRow(row: WorkspaceFile): FileReadMetadataResponse {
  return {
    path: row.path,
    revision: row.revision,
    contentType: row.contentType,
    contentRef: row.contentRef,
    encoding: row.encoding,
    provider: row.provider || undefined,
    providerObjectId: row.providerObjectId || undefined,
    lastEditedAt: row.updatedAt,
    semantics: coreParseSemantics(row.semanticsJson),
    ...(row.contentHash ? { contentHash: row.contentHash } : {}),
  };
}

// Numeric suffix of an `evt_<n>` id, for keyset seeking that matches creation
// order (the counter is unpadded, so lexical order is wrong — see listEvents).
function eventIdSeq(eventId: string): number {
  return Number.parseInt(eventId.slice(4), 10);
}

export function listEvents(
  context: WorkspaceFsContext,
  workspaceId: string,
  provider?: string,
  cursor?: string | null,
  limit = 200,
  direction: EventFeedDirection = "asc",
): EventFeedResponse {
  // We bypass coreListEvents here so the wire response can carry the
  // `contentHash` field for file events. coreListEvents drops it on the
  // CoreEventRow shape, and the daemon needs it on every file.* event to
  // run the cross-check from relayfile PR #90.
  const _ = workspaceId;
  void _;
  const cappedLimit = Math.max(1, Math.min(limit, MAX_LIST_ROWS));
  const normalizedProvider = provider?.trim().toLowerCase() ?? "";
  const isDescending = direction === "desc";

  // Forward keyset pagination: the feed is ordered (timestamp ASC,
  // event_id ASC) and the cursor is the last (newest) event_id of the
  // previous page. The daemon treats the cursor as a forward watermark and
  // expects each page to return events *newer* than it, oldest-first, so it
  // can replay change events in chronological order and advance the cursor
  // toward the tip. (A DESC/"events older than cursor" feed silently froze
  // the mirror: resolveLatestEventCursor seeded the oldest event and every
  // probe then asked for events before it -> always empty.) We resolve the
  // cursor's (timestamp, event_id) and ask SQL for only the next
  // `cappedLimit + 1` rows strictly after it, instead of pulling the whole
  // `events` table into the DO isolate (a prior OOM contributor).
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (normalizedProvider) {
    conditions.push("provider = ?");
    bindings.push(normalizedProvider);
  }

  if (cursor) {
    const cursorBindings: unknown[] = [cursor];
    const cursorProvider = normalizedProvider ? "AND provider = ?" : "";
    if (normalizedProvider) cursorBindings.push(normalizedProvider);
    const cursorRow = context.allRows<Row>(
      `SELECT timestamp, event_id FROM events WHERE event_id = ? ${cursorProvider} LIMIT 1`,
      ...cursorBindings,
    )[0];
    if (cursorRow) {
      // event_id is `evt_<n>` with an UNPADDED counter (workspace.ts nextId), so a
      // lexical compare diverges from creation order at every digit boundary
      // (`evt_100` < `evt_99`). On a same-millisecond tie that flips the keyset
      // seek the wrong way: an event whose lexical id sorts before the cursor is
      // never returned again and the cursor never moves back — e.g. a Slack
      // writeback receipt is silently lost forever, so post() never recovers the
      // ts and the reply can't thread. Seek/sort on the numeric suffix instead
      // (mirrors the files-row revision guards that CAST(SUBSTR(revision,5))).
      conditions.push(
        isDescending
          ? "(timestamp < ? OR (timestamp = ? AND CAST(SUBSTR(event_id, 5) AS INTEGER) < ?))"
          : "(timestamp > ? OR (timestamp = ? AND CAST(SUBSTR(event_id, 5) AS INTEGER) > ?))",
      );
      bindings.push(
        cursorRow.timestamp,
        cursorRow.timestamp,
        eventIdSeq(String(cursorRow.event_id)),
      );
    }
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = context
    .allRows<Row>(
      `
        SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp, content_hash
        FROM events
        ${whereClause}
        ORDER BY timestamp ${isDescending ? "DESC" : "ASC"}, CAST(SUBSTR(event_id, 5) AS INTEGER) ${isDescending ? "DESC" : "ASC"}
        LIMIT ?
      `,
      ...bindings,
      cappedLimit + 1,
    )
    .map((row) => context.toEvent(row));

  const hasMore = rows.length > cappedLimit;
  const slice = rows.slice(0, cappedLimit);
  return {
    events: slice.map(workspaceEventToFilesystemEvent),
    nextCursor: hasMore ? (slice[slice.length - 1]?.eventId ?? null) : null,
  };
}

export function listChanges(
  context: WorkspaceFsContext,
  workspaceId: string,
  options: { last?: boolean; since?: string | null; limit?: number } = {},
): WireChangeEvent[] {
  const limit = Math.max(0, Math.min(options.limit ?? 200, 1000));
  if (limit === 0) {
    return [];
  }

  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (options.since) {
    conditions.push("timestamp >= ?");
    bindings.push(options.since);
  }
  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = context
    .allRows<Row>(
      `
        SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp, content_hash
        FROM events
        ${whereClause}
        ORDER BY timestamp ${options.last ? "DESC" : "ASC"}, CAST(SUBSTR(event_id, 5) AS INTEGER) ${options.last ? "DESC" : "ASC"}
        LIMIT ?
      `,
      ...bindings,
      limit,
    )
    .map((row) => context.toEvent(row));

  const events = options.last ? rows.reverse() : rows;
  return events.map((event) =>
    workspaceEventToWireChangeEvent(workspaceId, event),
  );
}

async function getChangeResourceAtEvent(
  context: WorkspaceFsContext,
  event: WorkspaceEvent,
): Promise<ChangeResourceAtEventResult> {
  if (event.type === "file.deleted") {
    return {
      path: event.path,
      data: { path: event.path, deleted: true },
      digest: changeDigest(event),
    };
  }

  const row = context.getFileRow(event.path);
  if (!row) {
    return {
      path: event.path,
      data: { path: event.path, deleted: false },
      digest: changeDigest(event),
    };
  }

  const content = await context.loadContent(row.contentRef, row.encoding);
  return {
    path: row.path,
    data: decodeChangeFilePayload(
      row.path,
      row.contentType,
      row.encoding,
      content,
    ),
    digest: row.contentHash ? `sha256:${row.contentHash}` : changeDigest(event),
  };
}

function getEventById(
  context: WorkspaceFsContext,
  eventId: string,
): WorkspaceEvent | null {
  const row = context.allRows<Row>(
    `
      SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp, content_hash
      FROM events
      WHERE event_id = ?
      LIMIT 1
    `,
    eventId,
  )[0];
  return row ? context.toEvent(row) : null;
}

function workspaceEventToWireChangeEvent(
  workspaceId: string,
  event: WorkspaceEvent,
): WireChangeEvent {
  return {
    id: event.eventId || changeEventFallbackId(workspaceId, event),
    workspace: workspaceId,
    type: "relayfile.changed",
    occurredAt: event.timestamp || new Date().toISOString(),
    resource: inferChangeResource(event.path, event.provider),
    summary: buildPathOnlyChangeSummary(event),
    digest: changeDigest(event),
  };
}

function changeEventFallbackId(
  workspaceId: string,
  event: WorkspaceEvent,
): string {
  return [
    "relayfile",
    workspaceId,
    event.type,
    event.path,
    event.revision,
    event.timestamp,
  ].join(":");
}

function inferChangeResource(
  path: string,
  eventProvider?: string,
): ChangeEventResource {
  const segments = normalizePath(path).split("/").filter(Boolean);
  const provider = eventProvider?.trim() || segments[0] || "relayfile";
  const resourceSegment = segments[1] || "resource";
  const leaf = segments[segments.length - 1] || path;
  return {
    path,
    kind: `${provider}.${singularize(resourceSegment)}`,
    id: stripExtension(leaf),
    provider,
  };
}

function buildPathOnlyChangeSummary(event: WorkspaceEvent): ChangeEventSummary {
  return {
    title: stripExtension(basename(event.path)),
    fieldsChanged: [event.type],
  };
}

function decodeChangeFilePayload(
  path: string,
  contentType: string,
  encoding: string,
  content: string,
): unknown {
  if (encoding === "base64") {
    return { contentBase64: content, contentType, encoding: "base64" };
  }
  if (contentType.includes("json") || path.endsWith(".json")) {
    try {
      return JSON.parse(content);
    } catch {
      return content;
    }
  }
  return content;
}

function changeDigest(event: WorkspaceEvent): string {
  return event.contentHash
    ? `sha256:${event.contentHash}`
    : event.revision
      ? `revision:${event.revision}`
      : `event:${event.eventId}`;
}

function basename(path: string): string {
  const segments = normalizePath(path).split("/").filter(Boolean);
  return segments[segments.length - 1] || path;
}

function stripExtension(value: string): string {
  return value.replace(/\.[^/.]+$/u, "");
}

function singularize(value: string): string {
  return value.endsWith("s") && value.length > 1 ? value.slice(0, -1) : value;
}

function normalizeEventFeedDirection(
  value: string | null | undefined,
): EventFeedDirection {
  return value === "desc" ? "desc" : "asc";
}

/**
 * Convert an internal WorkspaceEvent to the wire FilesystemEvent shape,
 * carrying through `contentHash` (an extension over @relayfile/sdk's
 * FilesystemEvent — see types.ts for the local extension and the daemon
 * cross-check in relayfile PR #90).
 */
function workspaceEventToFilesystemEvent(
  event: WorkspaceEvent,
): FilesystemEvent {
  return {
    eventId: event.eventId,
    type: event.type,
    path: event.path,
    revision: event.revision,
    origin: event.origin,
    provider: event.provider || undefined,
    correlationId: event.correlationId,
    timestamp: event.timestamp,
    // contentHash is not part of the SDK FilesystemEvent — we include it as
    // an extra property for the wire (JSON.stringify carries it through).
    ...(event.contentHash ? { contentHash: event.contentHash } : {}),
  } as FilesystemEvent & { contentHash?: string };
}

export function getRecentEvents(
  context: WorkspaceFsContext,
  workspaceId: string,
  limit: number,
): WorkspaceEvent[] {
  return coreGetRecentEvents(
    createCoreStorageAdapter(context, workspaceId),
    limit,
  ).map((event) => ({
    eventId: event.eventId,
    type: event.type as WorkspaceEvent["type"],
    path: event.path,
    revision: event.revision,
    origin: event.origin as WorkspaceEvent["origin"],
    provider: event.provider,
    correlationId: event.correlationId,
    timestamp: event.timestamp,
  }));
}

export function resolveFilePermissions(
  context: Pick<WorkspaceFsContext, "getFileRow">,
  path: string,
  includeTarget: boolean,
): string[] {
  const target = normalizePath(path);
  const permissions: string[] = [];

  for (const dir of ancestorDirectories(target)) {
    const markerPath = joinPath(dir, DIRECTORY_PERMISSION_MARKER_FILE);
    if (markerPath === target) {
      continue;
    }
    const marker = context.getFileRow(markerPath);
    if (!marker) {
      continue;
    }
    const semantics = coreParseSemantics(marker.semanticsJson);
    if ((semantics.permissions?.length ?? 0) === 0) {
      continue;
    }
    permissions.push(...(semantics.permissions ?? []));
  }

  if (includeTarget) {
    const file = context.getFileRow(target);
    if (file) {
      const semantics = coreParseSemantics(file.semanticsJson);
      if ((semantics.permissions?.length ?? 0) > 0) {
        permissions.push(...(semantics.permissions ?? []));
      }
    }
  }

  return permissions;
}

export function queryFiles(
  context: WorkspaceFsContext,
  workspaceId: string,
  req: QueryFilesRequest,
  claims: TokenClaims | null,
): FileQueryResponse {
  const base = normalizePath(req.path ?? req.pathPrefix ?? "/");
  const limit = Math.max(1, Math.min(req.limit ?? 100, MAX_LIST_ROWS));
  let scanCursor = req.cursor ? normalizePath(req.cursor) : null;
  const matchedRows: WorkspaceFile[] = [];
  const matchedItems: ReturnType<typeof coreQueryFiles>["items"] = [];
  let pagesScanned = 0;
  const maxPagesPerRequest = 2;
  // Runtime files queued for insertion (those not yet past the scan cursor)
  let runtimeQueue = getRuntimeFilesUnderBase(base)
    .map(runtimeWorkspaceFile)
    .filter((f) => !scanCursor || f.path > scanCursor);

  for (; pagesScanned < maxPagesPerRequest; pagesScanned += 1) {
    const page = scanWorkspaceFileRows(
      context,
      base,
      scanCursor,
      MAX_LIST_ROWS,
    );
    const pageRows = [...page.rows, ...runtimeQueue];
    runtimeQueue = [];
    if (pageRows.length === 0) {
      break;
    }
    const result = coreQueryFiles(
      {
        ...createCoreStorageAdapter(context, workspaceId),
        listFiles: () => pageRows.map((row) => toCoreFileRow(row)),
      },
      {
        path: req.path ?? req.pathPrefix ?? "/",
        provider: req.provider,
        properties: req.properties,
        relation: req.relation,
        permission: req.permission,
        comment: req.comment,
        limit: MAX_LIST_ROWS,
      },
      claims,
      cloudReadAclOptions(),
    );
    const pageByPath = new Map(pageRows.map((row) => [row.path, row]));
    const pageItems = [...result.items].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    for (const item of pageItems) {
      if (matchedItems.length >= limit) break;
      matchedItems.push(item);
      const row = pageByPath.get(item.path);
      if (row) matchedRows.push(row);
    }
    scanCursor = page.rows[page.rows.length - 1]?.path ?? scanCursor;
    if (matchedItems.length >= limit || page.rows.length < MAX_LIST_ROWS) {
      break;
    }
  }

  const fileByPath = new Map(matchedRows.map((row) => [row.path, row]));

  return {
    items: matchedItems.map((item) => {
      const file = fileByPath.get(item.path);
      const semantics = file
        ? coreParseSemantics(file.semanticsJson)
        : undefined;
      return {
        path: item.path,
        revision: item.revision,
        contentType: item.contentType,
        provider: file?.provider || undefined,
        providerObjectId: file?.providerObjectId || undefined,
        lastEditedAt: file?.updatedAt ?? item.lastEditedAt,
        size: file?.size ?? item.size,
        properties: semantics?.properties,
        relations: semantics?.relations,
        permissions: semantics?.permissions,
        comments: semantics?.comments,
      };
    }),
    nextCursor:
      matchedItems.length >= limit
        ? (matchedItems[matchedItems.length - 1]?.path ?? null)
        : pagesScanned >= maxPagesPerRequest
          ? scanCursor
          : null,
  };
}

function estimateExportManifestPageBytes(
  context: WorkspaceFsContext,
  pageSize: number,
  pathPrefix?: string | null,
): number {
  const normalizedPrefix = normalizeExportPathPrefixForEstimate(pathPrefix);
  const limit = Math.max(1, Math.min(pageSize, MAX_LIST_ROWS));
  if (normalizedPrefix) {
    const [lower, upper] = exportPathPrefixRange(normalizedPrefix);
    const rows = context.allRows<Row>(
      `
        SELECT path, revision, content_type, content_ref, size, encoding, updated_at, semantics_json,
               provider, provider_object_id, content_hash
        FROM files
        WHERE path >= ? AND path < ?
        ORDER BY path ASC
        LIMIT ?
      `,
      lower,
      upper,
      limit,
    );
    return rows.reduce((total, row) => total + estimateRowBytes(row), 0);
  }

  const rows = context.allRows<Row>(
    `
      SELECT path, revision, content_type, content_ref, size, encoding, updated_at, semantics_json,
             provider, provider_object_id, content_hash
      FROM files
      ORDER BY path ASC
      LIMIT ?
    `,
    limit,
  );
  return rows.reduce((total, row) => total + estimateRowBytes(row), 0);
}

function normalizeExportPathPrefixForEstimate(
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

function exportPathPrefixRange(pathPrefix: string): [string, string] {
  return [`${pathPrefix}/`, `${pathPrefix}0`];
}

function estimateRowBytes(row: Row): number {
  let bytes = 256;
  for (const value of Object.values(row)) {
    if (typeof value === "string") {
      bytes += new TextEncoder().encode(value).byteLength;
    } else if (typeof value === "number" || typeof value === "boolean") {
      bytes += 16;
    } else if (value !== null && value !== undefined) {
      bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
    }
  }
  return bytes;
}

function scanWorkspaceFileRows(
  context: WorkspaceFsContext,
  base: string,
  cursor: string | null,
  limit: number,
): { rows: WorkspaceFile[] } {
  const [lower, upper] = descendantPathRange(base);
  const cursorClause = cursor ? "AND path > ?" : "";
  const bindings =
    cursor !== null
      ? [base, lower, upper, cursor, limit]
      : [base, lower, upper, limit];
  const rows = context
    .allRows<Row>(
      `
        SELECT path, revision, content_type, content_ref, size, encoding, updated_at, semantics_json,
               provider, provider_object_id, content_hash
        FROM files
        WHERE (path = ? OR (path >= ? AND path < ?))
          ${cursorClause}
        ORDER BY path ASC
        LIMIT ?
      `,
      ...bindings,
    )
    .map((row) => context.toWorkspaceFile(row));
  return { rows };
}

export async function bulkWrite(
  context: WorkspaceFsContext,
  workspaceId: string,
  files: BulkWriteFile[],
  correlationId: string,
  claims: TokenClaims | null,
  options: {
    onCommittedPath?: (path: string) => void;
  } = {},
): Promise<BulkWriteResult> {
  let written = 0;
  const errors: BulkWriteResponse["errors"] = [];
  const failedPaths = new Set<string>();
  const pushError = (path: string, code: string, message: string): void => {
    errors.push({ path, code, message });
    if (path.trim()) {
      failedPaths.add(normalizePath(path));
    }
  };
  const dedupedFiles: BulkWriteDedupedFile[] = [];
  let bytesWritten = 0;
  let bytesStoredDelta = 0;
  let fileCountDelta = 0;
  let syncCount = 0;
  const pendingCommits: BulkWritePendingCommit[] = [];
  const origin = isProviderSyncWriter(claims) ? "provider_sync" : "agent_write";
  const originalWriter = originalDedupWriter(claims);
  const isVisibleAfterCommit = (
    commit: BulkWritePendingCommit,
    row: WorkspaceFile | null,
  ): boolean => {
    if (commit.action === "file_delete") {
      return row === null;
    }
    return (
      row?.revision === commit.revision && row.contentRef === commit.contentRef
    );
  };

  for (const file of files) {
    if (!file.path?.trim()) {
      pushError(file.path ?? "", "invalid_path", "missing path");
      continue;
    }

    const path = normalizePath(file.path);
    const op = file.op ?? "upsert";
    if (op !== "upsert" && op !== "delete") {
      pushError(path, "invalid_operation", "invalid bulk file operation");
      continue;
    }
    const failedDependency = normalizeBulkWriteDependencies(
      file.dependsOn,
    ).find((dependency) => failedPaths.has(dependency));
    if (failedDependency) {
      pushError(
        path,
        "dependency_failed",
        `dependent bulk write skipped because ${failedDependency} failed`,
      );
      continue;
    }
    if (
      isDirectoryPermissionMarkerPath(path) &&
      !canMutatePermissionMarkers(claims)
    ) {
      pushError(
        path,
        "forbidden",
        "ACL marker mutation requires admin:acl scope",
      );
      continue;
    }

    if (file.op === "delete") {
      const existing = context.getFileRow(path);
      if (!existing) {
        pushError(path, "not_found", "file not found");
        continue;
      }
      if (
        !filePermissionAllows(
          resolveFilePermissions(context, path, true),
          workspaceId,
          claims,
          "write",
          path,
        )
      ) {
        pushError(path, "forbidden", "file access denied by permission policy");
        continue;
      }
      const baseRevision = file.baseRevision?.trim();
      if (!baseRevision) {
        pushError(path, "precondition_failed", "missing baseRevision");
        continue;
      }
      if (baseRevision !== "*" && baseRevision !== existing.revision) {
        pushError(path, "revision_conflict", "revision conflict");
        continue;
      }

      const revision = context.nextId("rev");
      const now = new Date().toISOString();
      context.sqlExec("DELETE FROM files WHERE path = ?", path);
      const provider = resolveMutationProvider(
        path,
        existing.provider,
        origin,
        "file_delete",
      );
      const mutationInput: MutationRecordInput = {
        path,
        revision,
        provider,
        correlationId,
        eventType: "file.deleted",
        action: "file_delete",
        timestamp: now,
        origin,
      };
      pendingCommits.push({
        path,
        revision,
        action: "file_delete",
        contentRef: null,
        dedupReservation: null,
        contentRefToDeleteAfterVisible: existing.contentRef || null,
        mutationInput,
        bytesWrittenDelta: 0,
        bytesStoredDelta: -existing.size,
        fileCountDelta: -1,
      });
      continue;
    }

    const upsertFile = file;
    const encoding = normalizeEncoding(upsertFile.encoding);
    if (!encoding) {
      pushError(path, "invalid_encoding", "invalid encoding");
      continue;
    }
    if (!validateEncodedContent(upsertFile.content, encoding)) {
      pushError(path, "invalid_content", "invalid content encoding");
      continue;
    }

    const content = upsertFile.content;
    const existing = context.getFileRow(path);
    const permissions = resolveFilePermissions(
      context,
      path,
      Boolean(existing),
    );
    if (
      !filePermissionAllows(permissions, workspaceId, claims, "write", path)
    ) {
      pushError(path, "forbidden", "file access denied by permission policy");
      continue;
    }

    const revision = context.nextId("rev");
    const now = new Date().toISOString();
    const contentType = upsertFile.contentType?.trim() || DEFAULT_CONTENT_TYPE;
    const contentRef = context.contentRef(workspaceId, path, revision);
    const provider = resolveMutationProvider(
      path,
      existing?.provider,
      origin,
      "file_upsert",
    );
    const providerObjectId = existing?.providerObjectId ?? "";
    const size = encodedSize(content, encoding);
    const contentHash = await hashContent(content, encoding);
    const dedupCheck = await checkDedupWrite(
      context,
      workspaceId,
      upsertFile.contentIdentity,
      originalWriter,
    );
    if (dedupCheck.kind === "deduped") {
      dedupedFiles.push({
        path,
        deduped: true,
        originalWriter: dedupCheck.response.originalWriter,
        revision: null,
      });
      upsertFile.content = "";
      continue;
    }

    // Bulk-write chunks stage their SQL rows and events first, then commit
    // them with a single sync after the chunk. That deliberately differs
    // from the single-file #1166 pre-R2 flush: clone materialization only
    // begins after the clone worker writes its post-chunk sentinel, and bulk
    // broadcasts are delayed until the chunk-end sync below.
    await context.putObject(
      contentRef,
      content,
      encoding,
      contentType,
      workspaceId,
      path,
      revision,
    );

    const applied = upsertFileRowMonotonic(context, {
      path,
      revision,
      contentType,
      contentRef,
      size,
      encoding,
      updatedAt: now,
      semanticsJson: JSON.stringify(
        coreNormalizeSemantics(upsertFile.semantics),
      ),
      provider,
      providerObjectId,
      contentHash,
    });
    upsertFile.content = "";
    if (!applied) {
      await tryDeleteContent(context, contentRef);
      pushError(path, "revision_conflict", "newer revision already exists");
      continue;
    }
    // Server-side threading: lift a parent reference off the draft body (this is
    // the mount-sync path agents' draft writes take). Agent writes only.
    const parentRef =
      origin === "provider_sync"
        ? undefined
        : extractParentRef(content, encoding);
    const mutationInput: MutationRecordInput = {
      path,
      revision,
      provider,
      correlationId,
      eventType: existing ? "file.updated" : "file.created",
      action: "file_upsert",
      timestamp: now,
      origin,
      ...(parentRef ? { parentRef } : {}),
    };

    // Keep prior revision content in R2 for digest/event history. See the
    // single-file write path above for the retention rationale.
    pendingCommits.push({
      path,
      revision,
      action: "file_upsert",
      contentRef,
      dedupReservation: dedupCheck.reservation,
      contentRefToDeleteAfterVisible: null,
      mutationInput,
      bytesWrittenDelta: size,
      bytesStoredDelta: size - (existing?.size ?? 0),
      fileCountDelta: existing ? 0 : 1,
    });
  }

  if (pendingCommits.length > 0 && context.flushStorage) {
    await context.flushStorage();
    syncCount += 1;
  }
  const visibleCommits: BulkWritePendingCommit[] = [];
  for (const commit of pendingCommits) {
    const row = context.getFileRow(commit.path);
    if (!isVisibleAfterCommit(commit, row)) {
      if (commit.contentRef) {
        await tryDeleteContent(context, commit.contentRef);
      }
      pushError(
        commit.path,
        "commit_not_visible",
        "bulk write was not readable after commit",
      );
      continue;
    }
    visibleCommits.push(commit);
  }
  if (visibleCommits.length > 0) {
    const mutationInputs = visibleCommits.map((commit) => commit.mutationInput);
    if (context.recordMutations) {
      const batch = await context.recordMutations(mutationInputs);
      syncCount += batch.syncCount;
    } else {
      for (const input of mutationInputs) {
        await context.recordMutation(input);
      }
      if (context.flushStorage) {
        await context.flushStorage();
        syncCount += 1;
      }
    }
  }
  for (const commit of visibleCommits) {
    written += 1;
    bytesWritten += commit.bytesWrittenDelta;
    bytesStoredDelta += commit.bytesStoredDelta;
    fileCountDelta += commit.fileCountDelta;
    await commit.dedupReservation?.commit();
    if (commit.contentRefToDeleteAfterVisible) {
      await tryDeleteContent(context, commit.contentRefToDeleteAfterVisible);
    }
    options.onCommittedPath?.(commit.path);
  }

  return {
    written,
    errorCount: errors.length,
    errors,
    correlationId,
    ...(dedupedFiles.length > 0 ? { dedupedFiles } : {}),
    bytesWritten,
    syncCount,
    fileCountDelta,
    bytesStoredDelta,
    operationCountDelta: origin === "agent_write" ? written : 0,
  };
}

async function registerImportedContent(
  context: WorkspaceFsContext,
  workspaceId: string,
  files: ImportedContentFile[],
  correlationId: string,
  claims: TokenClaims | null,
): Promise<BulkWriteResult & { committedPaths: string[]; durationMs: number }> {
  const startedAt = Date.now();
  let written = 0;
  let bytesWritten = 0;
  let bytesStoredDelta = 0;
  let fileCountDelta = 0;
  let syncCount = 0;
  const errors: BulkWriteResponse["errors"] = [];
  const committedPaths: string[] = [];
  const mutationInputs: MutationRecordInput[] = [];
  const origin = isProviderSyncWriter(claims) ? "provider_sync" : "agent_write";

  for (const file of files) {
    if (!file.path?.trim()) {
      errors.push({
        path: file.path ?? "",
        code: "invalid_path",
        message: "missing path",
      });
      continue;
    }

    const path = normalizePath(file.path);
    if (
      isDirectoryPermissionMarkerPath(path) &&
      !canMutatePermissionMarkers(claims)
    ) {
      errors.push({
        path,
        code: "forbidden",
        message: "ACL marker mutation requires admin:acl scope",
      });
      continue;
    }

    const encoding = normalizeEncoding(file.encoding);
    if (!encoding) {
      errors.push({
        path,
        code: "invalid_encoding",
        message: "invalid encoding",
      });
      continue;
    }

    if (!file.contentRef?.trim()) {
      errors.push({
        path,
        code: "invalid_content_ref",
        message: "missing contentRef",
      });
      continue;
    }

    const size = Number(file.size);
    if (!Number.isFinite(size) || size < 0) {
      errors.push({
        path,
        code: "invalid_size",
        message: "invalid size",
      });
      continue;
    }

    if (!/^[a-f0-9]{64}$/i.test(file.contentHash ?? "")) {
      errors.push({
        path,
        code: "invalid_content_hash",
        message: "invalid content hash",
      });
      continue;
    }

    const existing = context.getFileRow(path);
    const permissions = resolveFilePermissions(
      context,
      path,
      Boolean(existing),
    );
    if (
      !filePermissionAllows(permissions, workspaceId, claims, "write", path)
    ) {
      errors.push({
        path,
        code: "forbidden",
        message: "file access denied by permission policy",
      });
      continue;
    }

    const revision = context.nextId("rev");
    const now = new Date().toISOString();
    const provider = resolveMutationProvider(
      path,
      existing?.provider,
      origin,
      "file_upsert",
    );
    const providerObjectId = existing?.providerObjectId ?? "";
    const applied = upsertFileRowMonotonic(context, {
      path,
      revision,
      contentType: file.contentType?.trim() || DEFAULT_CONTENT_TYPE,
      contentRef: file.contentRef,
      size,
      encoding,
      updatedAt: now,
      semanticsJson: JSON.stringify(coreNormalizeSemantics(file.semantics)),
      provider,
      providerObjectId,
      contentHash: file.contentHash.toLowerCase(),
    });

    if (!applied) {
      errors.push({
        path,
        code: "revision_conflict",
        message: "newer revision already exists",
      });
      continue;
    }

    mutationInputs.push({
      path,
      revision,
      provider,
      correlationId,
      eventType: existing ? "file.updated" : "file.created",
      action: "file_upsert",
      timestamp: now,
      origin,
    });

    written += 1;
    bytesWritten += size;
    bytesStoredDelta += size - (existing?.size ?? 0);
    if (!existing) {
      fileCountDelta += 1;
    }
    committedPaths.push(path);
  }

  if (mutationInputs.length > 0) {
    if (context.recordMutations) {
      const batch = await context.recordMutations(mutationInputs);
      syncCount += batch.syncCount;
    } else {
      for (const input of mutationInputs) {
        await context.recordMutation(input);
      }
    }
  }

  return {
    written,
    errorCount: errors.length,
    errors,
    correlationId,
    bytesWritten,
    syncCount,
    fileCountDelta,
    bytesStoredDelta,
    operationCountDelta: origin === "agent_write" ? mutationInputs.length : 0,
    committedPaths,
    durationMs: Date.now() - startedAt,
  };
}

async function tryDeleteContent(
  context: Pick<WorkspaceFsContext, "deleteContent">,
  contentRef: string,
): Promise<void> {
  try {
    await context.deleteContent(contentRef);
  } catch (err) {
    console.error("fs: deleteContent cleanup failed", err);
  }
}

/**
 * Hard ceiling on file count for a single full-workspace export request.
 *
 * Even though export is now streamed (the DO never holds the whole artifact
 * or every body at once — see {@link iterateWorkspaceFilesForExport}), an
 * export of an enormous workspace still walks every R2 object and can run
 * long enough to hit the request wall-clock. We refuse it with a clear,
 * actionable error rather than letting the DO thrash. Configurable via the
 * `RELAYFILE_MAX_EXPORT_FILES` env var (falls back to a generous default
 * well above {@link MAX_LIST_ROWS}).
 */
const DEFAULT_MAX_EXPORT_FILES = 50_000;

function maxExportFiles(context: WorkspaceFsContext): number {
  const raw = (
    context as { bindings?: { RELAYFILE_MAX_EXPORT_FILES?: string } }
  ).bindings?.RELAYFILE_MAX_EXPORT_FILES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_EXPORT_FILES;
}

function exportFileToFileReadResponse(
  chunk: ExportFileChunk,
): FileReadResponse {
  const { file, content } = chunk;
  return {
    path: file.path,
    revision: file.revision,
    contentType: file.contentType,
    content,
    encoding: normalizeEncoding(file.encoding) ?? "utf-8",
    provider: file.provider || undefined,
    providerObjectId: file.providerObjectId || undefined,
    lastEditedAt: file.updatedAt,
    semantics: coreParseSemantics(file.semanticsJson),
  } satisfies FileReadResponse;
}

/**
 * Streaming workspace export.
 *
 * Replaces the previous implementation, which called
 * `buildCoreExportContext` (materialized every file body into one map) and
 * then `coreExportWorkspaceJson` / `coreExportWorkspaceTarGzip` (built the
 * whole artifact array, then `JSON.stringify`'d or tar-concatenated it) —
 * two full copies of the entire workspace resident in the DO isolate at
 * once, the dominant OOM vector.
 *
 * Every format now streams: the response body is a `ReadableStream` fed by
 * a keyset-paginated async iterator that loads exactly one file body from
 * R2 at a time and releases it before the next.
 */
export async function exportWorkspaceResponse(
  context: WorkspaceFsContext,
  workspaceId: string,
  format: ExportFormat,
  claims: TokenClaims | null,
  pathPrefix?: string | null,
): Promise<Response> {
  if (format !== "json" && format !== "patch" && format !== "tar") {
    return context.errorResponse(
      new Request("https://do/error"),
      context.errors.badRequest.status,
      context.errors.badRequest.code,
      "unsupported export format",
    );
  }

  const claimsForAcl = claims as Parameters<
    typeof iterateWorkspaceFilesForExport
  >[2];
  const fileCount = countExportableWorkspaceFiles(
    context,
    workspaceId,
    claimsForAcl,
    undefined,
    maxExportFiles(context) + 1,
    pathPrefix ?? null,
    cloudReadAclOptions(),
  );
  const limit = maxExportFiles(context);
  if (fileCount > limit) {
    return context.errorResponse(
      new Request("https://do/error"),
      context.errors.payloadTooLarge.status,
      context.errors.payloadTooLarge.code,
      `workspace has more than ${limit} exportable files which exceeds the export limit of ${limit}; ` +
        `use the paginated tree/read APIs (GET /fs/tree, GET /fs/file) instead`,
    );
  }

  const files = () =>
    iterateWorkspaceFilesForExport(
      context,
      workspaceId,
      claimsForAcl,
      undefined,
      pathPrefix ?? null,
      cloudReadAclOptions(),
    );

  if (format === "json") {
    return streamJsonExport(files());
  }
  if (format === "patch") {
    return streamPatchExport(files());
  }
  return streamTarGzipExport(files());
}

function streamJsonExport(files: AsyncGenerator<ExportFileChunk>): Response {
  const encoder = new TextEncoder();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    // Emit a JSON array incrementally so the wire shape stays identical
    // to the old `context.json(files)` (FileReadResponse[]) without ever
    // holding the whole array in the isolate.
    let first = true;
    yield encoder.encode("[");
    for await (const chunk of files) {
      const json = JSON.stringify(exportFileToFileReadResponse(chunk));
      yield encoder.encode(first ? json : `,${json}`);
      first = false;
    }
    yield encoder.encode("]");
  }
  return streamChunks(chunks(), "application/json; charset=utf-8");
}

function streamPatchExport(files: AsyncGenerator<ExportFileChunk>): Response {
  const encoder = new TextEncoder();
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let first = true;
    for await (const chunk of files) {
      const { file, content } = chunk;
      const lines = content.split("\n");
      const patch = [
        `--- ${safePatchPath(file.path)}`,
        `+++ ${safePatchPath(file.path)}`,
        "@@",
        ...lines.map((line) => `+${line}`),
      ].join("\n");
      yield encoder.encode(first ? patch : `\n${patch}`);
      first = false;
    }
  }
  return streamChunks(chunks(), "text/plain; charset=utf-8");
}

function streamTarGzipExport(files: AsyncGenerator<ExportFileChunk>): Response {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for await (const chunk of files) {
      const { file, content } = chunk;
      const bytes =
        file.encoding === "base64"
          ? Uint8Array.from(atob(content), (c) => c.charCodeAt(0))
          : new TextEncoder().encode(content);
      yield buildTarHeader(
        safeTarEntryName(file.path),
        bytes.byteLength,
        file.updatedAt,
      );
      yield bytes;
      const remainder = bytes.byteLength % 512;
      if (remainder > 0) {
        yield new Uint8Array(512 - remainder);
      }
    }
    // Two zero-filled 512-byte records terminate a tar archive.
    yield new Uint8Array(1024);
  }
  const tarStream = streamChunks(chunks()).body!;
  // CompressionStream is typed slightly differently across runtimes (the
  // workerd lib types declare a `BufferSource` writable, while our
  // tarStream emits `Uint8Array<ArrayBuffer>`). The runtime accepts
  // Uint8Array chunks just fine; cast through `unknown` for the type.
  const gzip = tarStream.pipeThrough(
    new CompressionStream("gzip") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  return new Response(gzip, {
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

function safePatchPath(path: string): string {
  return JSON.stringify(path);
}

// --- Minimal ustar header writer (mirrors @relayfile/core buildTarHeader,
// reimplemented here so tar export can be streamed per-file instead of the
// core helper which concatenates the whole archive in memory). ---

function buildTarHeader(
  name: string,
  size: number,
  updatedAt: string | undefined,
): Uint8Array {
  const { prefix, filename } = splitUstarPath(name);
  const header = new Uint8Array(512);
  writeTarString(header, 0, 100, filename);
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
  if (prefix) {
    writeTarString(header, 345, 155, prefix);
  }
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarChecksum(header, checksum);
  return header;
}

function splitUstarPath(name: string): { prefix: string; filename: string } {
  if (new TextEncoder().encode(name).byteLength <= 100) {
    return { prefix: "", filename: name };
  }

  const slashIndexes: number[] = [];
  for (let index = 0; index < name.length; index += 1) {
    if (name[index] === "/") slashIndexes.push(index);
  }

  for (let index = slashIndexes.length - 1; index >= 0; index -= 1) {
    const slash = slashIndexes[index];
    const prefix = name.slice(0, slash);
    const filename = name.slice(slash + 1);
    const prefixBytes = new TextEncoder().encode(prefix).byteLength;
    const filenameBytes = new TextEncoder().encode(filename).byteLength;
    if (prefixBytes <= 155 && filenameBytes <= 100) {
      return { prefix, filename };
    }
  }

  throw new Error(`tar export path is too long for ustar header: ${name}`);
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

type ParsedPermissionRule = {
  effect: "allow" | "deny";
  kind: "public" | "scope" | "agent" | "workspace";
  value: string;
};

function joinPath(base: string, child: string): string {
  const normalizedBase = normalizePath(base);
  return normalizedBase === "/"
    ? normalizePath(`/${child}`)
    : normalizePath(`${normalizedBase}/${child}`);
}

function ancestorDirectories(path: string): string[] {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  const dirs = ["/"];
  let current = "";
  for (let index = 0; index < Math.max(0, parts.length - 1); index += 1) {
    current = joinPath(current || "/", parts[index]);
    dirs.push(current);
  }
  return dirs;
}

function inferProviderFromPath(path: string): string {
  const normalized = normalizePath(path).slice(1);
  const [provider = ""] = normalized.split("/", 1);
  return provider.trim().toLowerCase();
}

function resolveMutationProvider(
  path: string,
  storedProvider: string | null | undefined,
  origin: MutationRecordInput["origin"],
  action: MutationRecordInput["action"],
): string {
  const normalizedStoredProvider = storedProvider?.trim().toLowerCase() ?? "";
  const pathProvider = inferProviderFromPath(path);

  if (
    origin === "agent_write" &&
    pathProvider &&
    !getUnsupportedWritebackReason(pathProvider, path, action)
  ) {
    if (normalizedStoredProvider && normalizedStoredProvider !== pathProvider) {
      console.warn("relayfile.writeback.provider_path_override", {
        path,
        action,
        storedProvider: normalizedStoredProvider,
        pathProvider,
      });
    }
    return pathProvider;
  }

  return normalizedStoredProvider || pathProvider;
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : "/";
}

function normalizeBulkWriteDependencies(dependsOn: unknown): string[] {
  if (!Array.isArray(dependsOn)) {
    return [];
  }
  const normalized = new Set<string>();
  for (const dependency of dependsOn) {
    if (typeof dependency !== "string" || !dependency.trim()) {
      continue;
    }
    normalized.add(normalizePath(dependency));
  }
  return [...normalized];
}

function isDirectoryPermissionMarkerPath(path: string): boolean {
  const normalized = normalizePath(path);
  return (
    normalized.split("/").pop()?.toLowerCase() ===
    DIRECTORY_PERMISSION_MARKER_FILE
  );
}

function canMutatePermissionMarkers(claims: TokenClaims | null): boolean {
  return Boolean(
    claims?.scopes.has(ACL_ADMIN_SCOPE) ||
    claims?.scopes.has("admin:manage") ||
    claims?.scopes.has("relayfile:admin:acl:*") ||
    claims?.scopes.has("relayfile:admin:manage:*"),
  );
}

function normalizeEncoding(encoding?: string): "utf-8" | "base64" | null {
  const value = encoding?.trim().toLowerCase() ?? "";
  if (!value || value === "utf-8" || value === "utf8") {
    return "utf-8";
  }
  if (value === "base64") {
    return "base64";
  }
  return null;
}

function normalizeIfMatchHeader(value?: string | null): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  if (trimmed === "*" || trimmed === "0") {
    return trimmed;
  }
  const weak = trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
  if (weak.startsWith('"') && weak.endsWith('"') && weak.length >= 2) {
    return weak.slice(1, -1);
  }
  return weak;
}

function validateEncodedContent(
  content: string,
  encoding: "utf-8" | "base64",
): boolean {
  if (encoding !== "base64") {
    return true;
  }
  return validateBase64Content(content);
}

function encodedSize(content: string, encoding: "utf-8" | "base64"): number {
  if (encoding === "base64") {
    return base64DecodedSize(content);
  }
  return new TextEncoder().encode(content).byteLength;
}

function parsePermissionRule(raw: string): ParsedPermissionRule | null {
  let rule = raw.trim();
  if (!rule) {
    return null;
  }

  let effect: ParsedPermissionRule["effect"] = "allow";
  const lower = rule.toLowerCase();
  if (lower.startsWith("allow:")) {
    rule = rule.slice("allow:".length).trim();
  } else if (lower.startsWith("deny:")) {
    effect = "deny";
    rule = rule.slice("deny:".length).trim();
  }

  const normalized = rule.toLowerCase();
  if (normalized === "public" || normalized === "any" || normalized === "*") {
    return { effect, kind: "public", value: "*" };
  }

  const [kindRaw, ...rest] = rule.split(":");
  const kind = kindRaw?.trim().toLowerCase();
  const value = rest.join(":").trim();
  if (!kind || !value) {
    return null;
  }
  if (kind !== "scope" && kind !== "agent" && kind !== "workspace") {
    return null;
  }

  return { effect, kind, value };
}

function filePermissionAllows(
  permissions: string[] | undefined,
  workspaceId: string,
  claims: TokenClaims | null,
  requiredAction: "read" | "write",
  requestedPath: string,
): boolean {
  if (!permissions || permissions.length === 0) {
    return true;
  }

  let enforceableRuleSeen = false;
  let allowMatch = false;
  for (const raw of permissions) {
    const rule = parsePermissionRule(raw);
    if (!rule) {
      continue;
    }
    enforceableRuleSeen = true;

    let match = false;
    switch (rule.kind) {
      case "public":
        match = true;
        break;
      case "scope":
        match = scopeRuleMatches(
          rule.value,
          claims,
          requiredAction,
          requestedPath,
        );
        break;
      case "agent":
        match = claims?.agentName === rule.value;
        break;
      case "workspace":
        match = workspaceId === rule.value;
        break;
    }

    if (!match) {
      continue;
    }
    if (rule.effect === "deny") {
      return false;
    }
    allowMatch = true;
  }

  if (allowMatch) {
    return true;
  }
  return !enforceableRuleSeen;
}

export function scopeRuleMatches(
  scope: string,
  claims: TokenClaims | null,
  requiredAction: "read" | "write",
  requestedPath: string,
): boolean {
  if (!claims) {
    return false;
  }

  if (bareScopeAllows(scope, requiredAction)) {
    for (const claimScope of claims.scopes) {
      if (bareScopeAllows(claimScope, requiredAction)) {
        return true;
      }
      const parsedClaim = parsePermissionScope(claimScope);
      if (
        !parsedClaim ||
        !scopeActionAllows(parsedClaim.action, requiredAction)
      ) {
        continue;
      }
      if (scopePathMatchesPath(parsedClaim.path, requestedPath)) {
        return true;
      }
    }
    return false;
  }

  const parsed = parsePermissionScope(scope);
  if (!parsed) {
    return claims.scopes.has(scope);
  }

  if (!scopeActionAllows(parsed.action, requiredAction)) {
    return false;
  }

  if (!scopePathMatchesPath(parsed.path, requestedPath)) {
    return false;
  }

  if (claims.scopes.has(scope)) {
    return true;
  }

  for (const claimScope of claims.scopes) {
    if (bareScopeAllows(claimScope, requiredAction)) {
      return true;
    }
    const parsedClaim = parsePermissionScope(claimScope);
    if (
      !parsedClaim ||
      !scopeActionAllows(parsedClaim.action, requiredAction)
    ) {
      continue;
    }
    if (scopePathMatchesPath(parsedClaim.path, requestedPath)) {
      return true;
    }
  }

  return false;
}

type PermissionScopeAction = "read" | "write" | "manage" | "*";

function parsePermissionScope(
  scope: string,
): { action: PermissionScopeAction; path: string } | null {
  const parts = scope.split(":");
  if (parts.length < 3 || parts.length > 4) {
    return null;
  }

  const action = parts[2]?.trim().toLowerCase();
  if (
    action !== "read" &&
    action !== "write" &&
    action !== "manage" &&
    action !== "*"
  ) {
    return null;
  }

  const path = normalizePermissionScopePath(parts[3] ?? "*");
  return { action, path };
}

function bareScopeAllows(
  scope: string,
  requiredAction: "read" | "write",
): boolean {
  const parts = scope.split(":");
  if (parts.length !== 2) {
    return false;
  }
  const resource = parts[0]?.trim().toLowerCase();
  const action = parts[1]?.trim().toLowerCase();
  return (
    resource === "fs" &&
    (action === requiredAction || action === "manage" || action === "*")
  );
}

function scopeActionAllows(
  grantedAction: PermissionScopeAction,
  requiredAction: "read" | "write",
): boolean {
  return (
    grantedAction === requiredAction ||
    grantedAction === "manage" ||
    grantedAction === "*"
  );
}

function normalizePermissionScopePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed === "*") {
    return "*";
  }

  if (trimmed.endsWith("/**")) {
    const base = normalizePath(trimmed.slice(0, -3));
    return base === "/" ? "*" : `${base}/*`;
  }

  if (trimmed.endsWith("/*")) {
    const base = normalizePath(trimmed.slice(0, -2));
    return base === "/" ? "*" : `${base}/*`;
  }

  if (GLOB_PATTERN.test(trimmed)) {
    const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
    return withLeadingSlash.replace(/\/+/g, "/");
  }

  return normalizePath(trimmed);
}

/**
 * Reservation returned by `checkDedupWrite` when the caller should proceed
 * with the actual write. `commit()` is called after the write operations
 * succeed to persist the dedup key — NEVER call it before R2 + SQL writes
 * complete, or a failed downstream write can orphan the key and cause
 * subsequent retries to silently return {deduped: true} without ever
 * persisting the data (data-loss window until KV TTL expires).
 */
type DedupReservation = {
  commit: () => Promise<void>;
};

function originalDedupWriter(claims: TokenClaims | null): string {
  return claims?.productId ?? claims?.agentName ?? "unknown";
}

async function checkDedupWrite(
  context: Pick<WorkspaceFsContext, "dedupKv">,
  workspaceId: string,
  contentIdentity: WriteContentIdentity | undefined,
  productId: string,
): Promise<
  | { kind: "deduped"; response: DedupWriteResponse }
  | { kind: "proceed"; reservation: DedupReservation | null }
> {
  const normalizedIdentity = normalizeContentIdentity(contentIdentity);
  if (!normalizedIdentity || !context.dedupKv) {
    return { kind: "proceed", reservation: null };
  }

  const hash = await computeDedupHash(
    workspaceId,
    normalizedIdentity.kind,
    normalizedIdentity.key,
  );
  const dedupKv = context.dedupKv;
  const existing = await dedupKv.get(hash);
  if (existing) {
    return {
      kind: "deduped",
      response: {
        deduped: true,
        originalWriter: parseDedupEntry(existing).productId,
      },
    };
  }

  return {
    kind: "proceed",
    reservation: {
      commit: async () => {
        await dedupKv.put(
          hash,
          JSON.stringify({
            productId,
            ts: Date.now(),
          } satisfies DedupEntry),
          {
            expirationTtl: normalizedIdentity.ttlSeconds ?? 600,
          },
        );
      },
    },
  };
}

function normalizeContentIdentity(
  contentIdentity: WriteContentIdentity | undefined,
): WriteContentIdentity | null {
  if (!contentIdentity) {
    return null;
  }

  const kind = contentIdentity.kind?.trim();
  const key = contentIdentity.key?.trim();
  if (!kind || !key) {
    return null;
  }

  return {
    kind,
    key,
    ttlSeconds: normalizeDedupTtl(contentIdentity.ttlSeconds),
  };
}

function parseDedupEntry(raw: string): DedupEntry {
  try {
    const parsed = JSON.parse(raw) as Partial<DedupEntry>;
    return {
      productId:
        typeof parsed.productId === "string" && parsed.productId.trim()
          ? parsed.productId
          : "unknown",
      ts: typeof parsed.ts === "number" ? parsed.ts : 0,
    };
  } catch {
    return {
      productId: "unknown",
      ts: 0,
    };
  }
}

async function computeDedupHash(
  workspaceId: string,
  kind: string,
  key: string,
): Promise<string> {
  const payload = new TextEncoder().encode(`${workspaceId}\0${kind}\0${key}`);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

// Cloudflare KV requires expirationTtl >= 60s; shorter values make `put()`
// throw at runtime. Clamp up rather than reject so the write still dedups.
const MIN_DEDUP_TTL_SECONDS = 60;

function normalizeDedupTtl(ttlSeconds: unknown): number | undefined {
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds)) {
    return undefined;
  }

  const normalized = Math.floor(ttlSeconds);
  if (normalized <= 0) {
    return undefined;
  }
  return Math.max(normalized, MIN_DEDUP_TTL_SECONDS);
}

function descendantPathRange(base: string): [string, string] {
  if (base === "/") {
    return ["/", "0"];
  }

  // The range covers only slash-delimited descendants of base and avoids
  // SQLite LIKE/GLOB pattern limits on provider paths with many segments.
  return [`${base}/`, `${base}0`];
}

export function scopePathMatchesPath(
  scopePath: string,
  requestedPath: string,
): boolean {
  if (scopePath === "*") {
    return true;
  }

  const normalizedPath = normalizePath(requestedPath);
  if (scopePath.endsWith("/*")) {
    return normalizedPath.startsWith(`${scopePath.slice(0, -1)}`);
  }

  if (GLOB_PATTERN.test(scopePath)) {
    return globPatternToRegExp(scopePath).test(normalizedPath);
  }

  return normalizedPath === scopePath;
}

function globPatternToRegExp(pattern: string): RegExp {
  let regex = "^";

  for (let index = 0; index < pattern.length; ) {
    if (pattern.startsWith("**/", index)) {
      regex += "(?:.*/)?";
      index += 3;
      continue;
    }
    if (pattern.startsWith("**", index)) {
      regex += ".*";
      index += 2;
      continue;
    }

    const char = pattern[index] ?? "";
    if (char === "*") {
      regex += "[^/]*";
      index += 1;
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      index += 1;
      continue;
    }

    regex += escapeRegExp(char);
    index += 1;
  }

  regex += "$";
  return new RegExp(regex);
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function truncatePreview(content: string): string {
  return content.length <= 4000 ? content : content.slice(0, 4000);
}

function clampInt(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!value?.trim()) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}
