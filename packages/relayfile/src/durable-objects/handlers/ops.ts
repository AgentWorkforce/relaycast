import {
  acknowledgeWriteback as coreAcknowledgeWriteback,
  createEvent as coreCreateEvent,
  createOperation as coreCreateOperation,
  dispatchWriteback as coreDispatchWriteback,
  getPendingWritebacks as coreGetPendingWritebacks,
  listOperations as coreListOperations,
  replayOperation as coreReplayOperation,
  type StorageAdapter as CoreStorageAdapter,
} from "@relayfile/core";
import type {
  FilesystemEvent,
  OperationFeedResponse,
  OperationStatusResponse,
  QueuedResponse,
  WriteQueuedResponse,
} from "@relayfile/sdk";
import type { Bindings } from "../../env.js";
import type {
  WorkspaceOperation,
  WritebackDeadLetterError,
  WritebackDeadLetterErrorCode,
  WritebackExecutionContextResponse,
  WritebackItem,
  WritebackListResponse,
  WritebackListState,
} from "../../types.js";
import { getUnsupportedWritebackReason } from "../../writeback/path-eligibility.js";
import { readFile } from "./fs.js";

type Row = Record<string, unknown>;
type WorkspaceOperationUpsert = OperationStatusResponse &
  Pick<WorkspaceOperation, "updatedAt" | "completedAt">;
type CoreEventRow = Parameters<CoreStorageAdapter["appendEvent"]>[0];
type DispatchWritebackResult =
  | { kind: "queued" }
  | { kind: "already_dispatched" }
  | { kind: "retry_scheduled" }
  | { kind: "retry_alarm_failed" }
  | { kind: "dead_lettered" }
  | { kind: "not_found" };

type DispatchWritebackResponseStatus = Exclude<
  DispatchWritebackResult["kind"],
  "not_found"
>;
type DispatchQueuedResponse = QueuedResponse & {
  dispatchStatus: DispatchWritebackResponseStatus;
};

type WritebackMessage = {
  opId: string;
  workspaceId: string;
  path: string;
  revision: string;
  correlationId?: string;
  // Parent-dependency writebacks: the parent op's delivered provider object id,
  // resolved by the DO when it releases a child op (ack-driven, so the parent
  // has acked and its id is known). Carried to the consumer for the provider to
  // use however it references a parent — e.g. Slack injects it as the
  // `thread_ts` so a reply threads onto its parent message, with no agent-side
  // receipt round-trip. Absent for ordinary (parent-less) writebacks.
  parentExternalId?: string;
};

type WritebackAckRequest = {
  success: boolean;
  error?: string;
  providerResult?: Record<string, unknown>;
};

type WorkspaceIdBody = {
  workspaceId?: string;
};

type DispatchWritebackRequest = WorkspaceIdBody & {
  opId: string;
};

type WritebackContextRequest = WorkspaceIdBody & {
  opId: string;
  path?: string;
  revision?: string;
};

type StatsSyncOverrides = {
  lastIngestedAt?: string | null;
  lastEventAt?: string | null;
  lastWritebackAt?: string | null;
  lastActivity?: string | null;
};

export type MutationRecordInput = {
  path: string;
  revision: string;
  provider: string;
  correlationId: string;
  eventType: string;
  action: "file_upsert" | "file_delete";
  timestamp: string;
  /**
   * Origin of the write. Defaults to `"agent_write"`. When set to
   * `"provider_sync"`, the write is an ingest from an upstream sync
   * worker (e.g. Nango sync) and we MUST NOT create a writeback op or
   * dispatch to the writeback queue — the synced record shape is not a
   * writeback payload and the queue consumer would fail it permanently.
   */
  origin?: "agent_write" | "provider_sync" | "system";
  /**
   * Parent-dependency writebacks: the relay path of the PARENT draft this write
   * depends on (e.g. a Slack reply naming the header's `…/messages/<draft>.json`,
   * or a comment naming the issue it belongs to). When set, the created op records
   * `parent_op_id` (resolved from this path) and is NOT dispatched eagerly — it
   * waits for the parent op's ack, then dispatches carrying the parent's delivered
   * provider object id (which the provider uses as it sees fit — Slack as
   * `thread_ts`). The fs write handler extracts this from the draft body; absent
   * for ordinary writes.
   */
  parentRef?: string;
};

export type MutationRecordBatchResult = {
  responses: WriteQueuedResponse[];
  syncCount: number;
};

type SqlStorageLike = {
  exec(query: string, ...bindings: unknown[]): unknown;
};

type AlarmStorageLike = {
  setAlarm(when: number): Promise<void>;
  deleteAlarm(): Promise<void>;
  // Optional so legacy test mocks that only stub setAlarm/deleteAlarm keep
  // typechecking. On a real DurableObjectState this is always present and is
  // how `ensureNextAlarm` learns about a pending debounced digest refresh.
  get?<T = unknown>(key: string): Promise<T | undefined>;
};

/**
 * DO storage key holding the epoch-ms timestamp at which a debounced digest
 * regeneration is due. Set by `WorkspaceDO.scheduleDigestRefresh` when a
 * non-digest write lands; consumed by the DO `alarm()` handler. The single DO
 * alarm is shared with writeback-op retries, so `ensureNextAlarm` must factor
 * this in or the next op reconcile would clobber a pending digest alarm.
 * See cloud#846 (writes blocked by an inline, unbounded digest refresh).
 */
export const DIGEST_REFRESH_DUE_STORAGE_KEY = "digest:refresh-due-at";

function dispatchWritebackResponse(
  result: { kind: DispatchWritebackResponseStatus },
  opId: string,
  request: Request,
  context: Pick<OpsHandlerContext, "correlationId">,
): DispatchQueuedResponse {
  return {
    status: "queued",
    dispatchStatus: result.kind,
    id: opId,
    correlationId: context.correlationId(request),
  };
}

type WorkspaceStateLike = {
  storage: AlarmStorageLike;
};

const ERRORS = {
  invalidInput: {
    status: 400,
    code: "invalid_input",
    message: "invalid input",
  },
  notFound: { status: 404, code: "not_found", message: "not found" },
  invalidState: {
    status: 409,
    code: "invalid_state",
    message: "invalid resource state",
  },
} as const;

export interface OpsHandlerContext {
  workspaceId?: string | null;
  // CONTENT_BUCKET is required so handleGetWritebackContentStream can stream
  // file bodies straight from R2 without ever buffering them into the DO
  // isolate as a single string. Optional in the type so existing tests that
  // don't exercise the new endpoint don't need to wire it.
  bindings: Pick<Bindings, "WRITEBACK_QUEUE"> & {
    CONTENT_BUCKET?: Bindings["CONTENT_BUCKET"];
  };
  state: WorkspaceStateLike;
  sql: SqlStorageLike;
  getFileRow(path: string): {
    path: string;
    revision: string;
    contentType: string;
    contentRef: string;
    size: number;
    encoding: "utf-8" | "base64";
    provider: string;
    providerObjectId: string;
    updatedAt: string;
    semanticsJson: string;
    contentHash: string;
  } | null;
  loadContent(
    contentRef: string,
    encoding: "utf-8" | "base64",
  ): Promise<string>;
  // Materialize a writeback receipt onto the draft file at `path` via a
  // system-origin write (emits a file event for the mount, creates no new
  // writeback op). This is what lets a waiting `slackClient().post()` read the
  // delivered provider object id (e.g. the Slack chat.postMessage ts) back off
  // the file via `waitForReceipt` and thread a reply — the writeback otherwise
  // only persists the id to the operations row, which the sandbox never sees.
  // Best-effort; optional so existing tests need not wire it.
  writeReceiptFile?(input: {
    workspaceId: string;
    path: string;
    receipt: Record<string, unknown>;
    provider: string;
    correlationId: string;
  }): Promise<void>;
  readJson<T>(request: Request): Promise<T>;
  resolveWorkspaceId(
    request: Request,
    body?: WorkspaceIdBody,
  ): Promise<string | null>;
  requireWorkspaceId(request: Request): Promise<string>;
  getWorkspaceId(): Promise<string | null>;
  correlationId(request: Request): string;
  json(payload: unknown, status?: number, headers?: HeadersInit): Response;
  errorResponse(
    request: Request,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Response;
  coreStorageAdapter(
    workspaceId: string,
    eventOptions?: { broadcast?: boolean },
  ): CoreStorageAdapter;
  broadcastEvent?(event: FilesystemEvent): void;
  flushStorage?(): Promise<void>;
  upsertWorkspaceOperation(
    workspaceId: string,
    operation: WorkspaceOperationUpsert,
    createdAt: string,
  ): Promise<void>;
  syncWorkspaceStats(
    workspaceId: string,
    overrides?: StatsSyncOverrides,
  ): Promise<void>;
}

export async function handleDispatchWriteback(
  context: OpsHandlerContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<DispatchWritebackRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing workspaceId",
    );
  }
  if (!body.opId?.trim()) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing opId",
    );
  }

  const result = await dispatchWriteback(context, body.opId);
  if (result.kind === "not_found") {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  return context.json(
    dispatchWritebackResponse(result, body.opId, request, context),
    202,
  );
}

/**
 * Maximum file body size that may be returned inline in the writeback
 * execution context response. Above this, the body is elided
 * (`file.content === null`, `contentInline: false`) and the executor MUST
 * hydrate it via `POST /internal/writeback-content` which streams from R2.
 *
 * The previous implementation always inlined the entire body, which was a
 * primary OOM vector on the WorkspaceDO: a 50MB file caused the DO to
 * materialize the body as a JS string twice (once via `loadContent`, once
 * via `JSON.stringify`) before flushing to the wire.
 *
 * Defaults to 2 MiB and is configurable per-deployment via the
 * `RELAYFILE_WRITEBACK_INLINE_MAX_BYTES` env var.
 */
const DEFAULT_WRITEBACK_INLINE_MAX_BYTES = 2 * 1024 * 1024;

function writebackInlineMaxBytes(context: OpsHandlerContext): number {
  const raw = (
    context as {
      bindings?: { RELAYFILE_WRITEBACK_INLINE_MAX_BYTES?: string };
    }
  ).bindings?.RELAYFILE_WRITEBACK_INLINE_MAX_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_WRITEBACK_INLINE_MAX_BYTES;
}

export async function handleGetWritebackContext(
  context: OpsHandlerContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<WritebackContextRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing workspaceId",
    );
  }
  if (!body.opId?.trim()) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing opId",
    );
  }

  const op = getOperation(context, body.opId);
  if (!op) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  const skipFile =
    isTerminalOperationStatus(op.status) || op.action === "file_delete";

  if (skipFile) {
    return context.json({
      workspaceId,
      operation: {
        opId: op.opId,
        path: op.path,
        revision: op.revision,
        action: op.action,
        provider: op.provider,
        status: op.status,
        correlationId: op.correlationId,
      },
      file: null,
    } satisfies WritebackExecutionContextResponse);
  }

  // Look up the file row first so we can decide inline-vs-elided based on
  // the stored `size` column WITHOUT pulling the body from R2 in the
  // elided case.
  const row = context.getFileRow(op.path);
  if (!row || row.revision !== op.revision) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  const inlineLimit = writebackInlineMaxBytes(context);
  const actualSize = await resolveStoredObjectSize(context, row);
  const fitsInline = actualSize <= inlineLimit;

  if (fitsInline) {
    const file = await readFile(context, op.path);
    if (!file || file.revision !== op.revision) {
      return context.errorResponse(
        request,
        ERRORS.notFound.status,
        ERRORS.notFound.code,
        ERRORS.notFound.message,
      );
    }
    return context.json({
      workspaceId,
      operation: {
        opId: op.opId,
        path: op.path,
        revision: op.revision,
        action: op.action,
        provider: op.provider,
        status: op.status,
        correlationId: op.correlationId,
      },
      file,
      contentInline: true,
      contentSize: actualSize,
    } satisfies WritebackExecutionContextResponse);
  }

  // Oversized: return metadata only. The executor will fetch the body
  // out-of-band via /internal/writeback-content.
  //
  // BACK-COMPAT NOTE (May 2026 hardening):
  // The previous shape set `file.content = ""` and `contentInline = false`.
  // Older daemons that don't know to check `contentInline` would happily
  // destructure `file.content` and write an EMPTY file back to the provider
  // — silent data corruption. We now set `file.content = null` so older
  // daemons that expect a string fail loudly (TypeError on string ops, or a
  // schema-validation error) instead of silently writing nothing. The
  // streaming hydrator in `provider-executor.ts#fetchWritebackContext`
  // detects `content === null` and pulls the body from
  // `/internal/writeback-content` before use.
  return context.json({
    workspaceId,
    operation: {
      opId: op.opId,
      path: op.path,
      revision: op.revision,
      action: op.action,
      provider: op.provider,
      status: op.status,
      correlationId: op.correlationId,
    },
    file: {
      path: row.path,
      revision: row.revision,
      contentType: row.contentType,
      content: null,
      encoding: row.encoding,
      provider: row.provider || undefined,
      providerObjectId: row.providerObjectId || undefined,
      lastEditedAt: row.updatedAt,
      semantics: parseJsonRecord(row.semanticsJson) ?? {},
      ...(row.contentHash ? { contentHash: row.contentHash } : {}),
    } as WritebackExecutionContextResponse["file"],
    contentInline: false,
    contentSize: actualSize,
  } satisfies WritebackExecutionContextResponse);
}

async function resolveStoredObjectSize(
  context: OpsHandlerContext,
  row: NonNullable<ReturnType<OpsHandlerContext["getFileRow"]>>,
): Promise<number> {
  const bucket = context.bindings.CONTENT_BUCKET;
  if (!bucket || !row.contentRef) {
    return Math.max(0, row.size ?? 0);
  }
  const head = await bucket.head(row.contentRef);
  return Math.max(0, head?.size ?? row.size ?? 0);
}

/**
 * Stream the file body for a given writeback operation straight from R2,
 * so the executor can hydrate `file.content` for oversized writebacks
 * without the WorkspaceDO ever holding the body as a JS string.
 *
 * The response is the raw R2 object body. The `X-Relayfile-Encoding`
 * header tells the executor whether to base64-encode the bytes before use
 * (preserving the stored encoding semantics).
 */
export async function handleGetWritebackContentStream(
  context: OpsHandlerContext,
  request: Request,
): Promise<Response> {
  // Internal binding-only endpoint used by the trusted writeback executor
  // after dispatch authorization has selected the operation to replay.
  const body = await context.readJson<WritebackContextRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing workspaceId",
    );
  }
  if (!body.opId?.trim()) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing opId",
    );
  }

  const op = getOperation(context, body.opId);
  if (!op) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  const row = context.getFileRow(op.path);
  if (!row || row.revision !== op.revision) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  const bucket = context.bindings.CONTENT_BUCKET;
  if (!bucket) {
    return context.errorResponse(
      request,
      500,
      "internal_error",
      "CONTENT_BUCKET binding is not configured",
    );
  }

  const object = await bucket.get(row.contentRef);
  if (!object) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      "writeback content missing from R2",
    );
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": row.contentType || "application/octet-stream",
      "X-Relayfile-Encoding": row.encoding,
      "X-Relayfile-Revision": row.revision,
      "X-Relayfile-Content-Hash": row.contentHash || "",
    },
  });
}

export async function handleGetOperation(
  context: OpsHandlerContext,
  request: Request,
  opId: string,
): Promise<Response> {
  const op = getOperation(context, opId);
  if (!op) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }
  return context.json(
    toOperationStatusResponse(
      op,
      parseJsonRecord(op.providerResultJson ?? undefined) ?? undefined,
    ),
  );
}

export async function handleListOperationsGet(
  context: OpsHandlerContext,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const result = coreListOperations(
    context.coreStorageAdapter(context.workspaceId ?? ""),
    {
      status: url.searchParams.get("status") ?? undefined,
      action: url.searchParams.get("action") ?? undefined,
      provider: url.searchParams.get("provider") ?? undefined,
      cursor: url.searchParams.get("cursor") ?? undefined,
      limit: clampInt(url.searchParams.get("limit"), 100, 1, 1000),
    },
  );

  return context.json({
    items: result.items.map((op) => ({
      opId: op.opId,
      path: op.path || undefined,
      revision: op.revision || undefined,
      action: op.action as OperationStatusResponse["action"],
      provider: op.provider || undefined,
      status: publicOperationStatus(op.status),
      attemptCount: op.attemptCount,
      nextAttemptAt: op.nextAttemptAt,
      lastError: op.lastError,
      correlationId: op.correlationId || undefined,
    })),
    nextCursor: result.nextCursor,
  } satisfies OperationFeedResponse);
}

export async function handleReplayOperation(
  context: OpsHandlerContext,
  request: Request,
  opId: string,
): Promise<Response> {
  const op = getOperation(context, opId);
  if (!op) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }
  if (!isReplayableOperationStatus(op.status)) {
    return context.errorResponse(
      request,
      ERRORS.invalidState.status,
      ERRORS.invalidState.code,
      "operation is not replayable",
    );
  }

  const replayed = coreReplayOperation(
    context.coreStorageAdapter(await context.requireWorkspaceId(request)),
    opId,
  );
  if (!replayed) {
    return context.errorResponse(
      request,
      ERRORS.invalidState.status,
      ERRORS.invalidState.code,
      "operation is not replayable",
    );
  }

  const workspaceId = await context.requireWorkspaceId(request);
  const now = new Date().toISOString();
  if (context.flushStorage) {
    await context.flushStorage();
  }
  await tryUpsertWorkspaceOperation(
    context,
    workspaceId,
    toWorkspaceOperationUpsert({
      ...op,
      status: "pending",
      nextAttemptAt: null,
      lastError: null,
      updatedAt: now,
      completedAt: null,
    }),
    op.createdAt ?? new Date().toISOString(),
  );

  const result = await dispatchWriteback(context, opId);
  if (result.kind === "not_found") {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  return context.json(
    dispatchWritebackResponse(result, opId, request, context),
    202,
  );
}

export async function handleReplayOperationInternal(
  context: OpsHandlerContext,
  request: Request,
): Promise<Response> {
  const body = await context.readJson<DispatchWritebackRequest>(request);
  const workspaceId = await context.resolveWorkspaceId(request, body);
  if (!workspaceId || !body.opId?.trim()) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing workspaceId or opId",
    );
  }
  return handleReplayOperation(context, request, body.opId);
}

export async function handlePendingWritebacks(
  context: OpsHandlerContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  return context.json(
    coreGetPendingWritebacks(
      context.coreStorageAdapter(workspaceId),
    ) as unknown as WritebackItem[],
  );
}

// Maps the agent-facing `relayfile writeback list --state <state>` surface
// onto cloud's DO-backed operations table. Hosted mounts intentionally expose
// only actionable states: pending work and dead-lettered work. Historical
// succeeded/failed status remains available through metrics/logs and internal
// operation reads, not this discovery list.
export async function handleListWritebacks(
  context: OpsHandlerContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const url = new URL(request.url);
  const stateParam = url.searchParams.get("state");
  if (!stateParam) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing state query parameter (one of: pending, dead)",
    );
  }
  const normalized = normalizeListState(stateParam);
  if (!normalized) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      `unsupported state "${stateParam}" (expected one of: pending, dead)`,
    );
  }

  const cursor = decodeWritebackListCursor(url.searchParams.get("cursor"));
  const cursorClause = cursor
    ? "AND (created_at < ? OR (created_at = ? AND op_id < ?))"
    : "";
  const bindings = cursor
    ? [
        normalized.dbStatus,
        cursor.createdAt,
        cursor.createdAt,
        cursor.opId,
        MAX_WRITEBACK_LIST_ROWS + 1,
      ]
    : [normalized.dbStatus, MAX_WRITEBACK_LIST_ROWS + 1];

  // Hardening item 3: bound this scan in SQL and expose a keyset cursor.
  // The previous unbounded query could OOM the DO; a later LIMIT-only
  // version silently hid rows after the first page.
  const rows = context.sql.exec(
    `
        SELECT op_id, path, revision, action, provider, status, attempt_count,
               next_attempt_at, last_error, provider_result_json, correlation_id, created_at,
               updated_at, completed_at
        FROM operations
        WHERE status = ?
        ${cursorClause}
        ORDER BY created_at DESC, op_id DESC
        LIMIT ?
      `,
    ...bindings,
  ) as { toArray?: <R>() => R[]; [Symbol.iterator]?: () => Iterator<Row> };
  const collected = collectRows(rows);
  const pageRows = collected.slice(0, MAX_WRITEBACK_LIST_ROWS);
  const items: WritebackItem[] = pageRows.map((row) =>
    toWritebackItem(
      workspaceId,
      toWorkspaceOperation(row),
      normalized.surfaceState,
    ),
  );
  const hasMore = collected.length > MAX_WRITEBACK_LIST_ROWS;
  return context.json({
    items,
    nextCursor: hasMore
      ? encodeWritebackListCursor(pageRows[pageRows.length - 1])
      : null,
    hasMore,
  } satisfies WritebackListResponse);
}

const MAX_WRITEBACK_LIST_ROWS = 1000;

function encodeWritebackListCursor(row: Row | undefined): string | null {
  if (!row) return null;
  const createdAt = String(row.created_at ?? "");
  const opId = String(row.op_id ?? "");
  if (!createdAt || !opId) return null;
  return btoa(JSON.stringify({ createdAt, opId }));
}

function decodeWritebackListCursor(
  cursor: string | null,
): { createdAt: string; opId: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(atob(cursor)) as {
      createdAt?: unknown;
      opId?: unknown;
    };
    if (
      typeof parsed.createdAt !== "string" ||
      typeof parsed.opId !== "string"
    ) {
      return null;
    }
    return { createdAt: parsed.createdAt, opId: parsed.opId };
  } catch {
    return null;
  }
}

function collectRows(cursor: {
  toArray?: <R>() => R[];
  [Symbol.iterator]?: () => Iterator<Row>;
}): Row[] {
  if (typeof cursor.toArray === "function") {
    return cursor.toArray<Row>();
  }
  const iteratorFactory = cursor[Symbol.iterator];
  if (typeof iteratorFactory !== "function") {
    return [];
  }
  const iterator = iteratorFactory.call(cursor);
  const out: Row[] = [];
  while (true) {
    const next = iterator.next();
    if (next.done) break;
    out.push(next.value);
  }
  return out;
}

interface NormalizedListState {
  // Status to query against the operations table. The DB stores
  // "dead_lettered"; the hosted agent-facing list exposes it as "dead".
  dbStatus: WorkspaceOperation["status"];
  // What the response surfaces back to clients.
  surfaceState: WritebackListState;
}

function normalizeListState(raw: string): NormalizedListState | null {
  switch (raw) {
    case "pending":
      return { dbStatus: "pending", surfaceState: "pending" };
    case "dead":
      return { dbStatus: "dead_lettered", surfaceState: "dead" };
    default:
      return null;
  }
}

function toWritebackItem(
  workspaceId: string,
  op: WorkspaceOperation,
  surfaceState: WritebackListState,
): WritebackItem {
  const base: WritebackItem = {
    id: op.opId,
    workspaceId,
    path: op.path,
    revision: op.revision,
    correlationId: op.correlationId,
    state: surfaceState,
    provider: op.provider || undefined,
    action: op.action,
    attempts: op.attemptCount,
    firstAttemptAt: op.createdAt || undefined,
    enqueuedAt: op.createdAt || undefined,
    lastAttemptAt: op.updatedAt || undefined,
  };
  if (op.status === "dead_lettered") {
    base.error = toDeadLetterError(op);
    base.code = base.error.code;
    base.message = base.error.message;
    base.providerStatus = base.error.providerStatus;
    base.providerResponse = base.error.providerResponse;
  }
  return base;
}

// Derive the canonical `WritebackDeadLetterError` payload (the same
// shape relayfile writes to `.relay/dead-letter/<opId>.error.json` and
// validates against `schemas/relay/dead-letter-error.schema.json`) from
// the existing operations-row columns. Today this is computed on read
// so no schema migration is required; if cloud later persists structured
// error context at terminal-transition time (cheaper for cold reads,
// preserves richer adapter responses verbatim), that writer can drop
// straight into this helper's place via `op.errorJson`.
function toDeadLetterError(op: WorkspaceOperation): WritebackDeadLetterError {
  const providerResult = parseJsonRecord(op.providerResultJson ?? undefined);
  const providerStatus = readProviderStatus(providerResult);
  return {
    code: classifyDeadLetterCode(providerStatus, op.lastError),
    message:
      op.lastError && op.lastError.trim().length > 0
        ? op.lastError
        : `writeback ${op.opId} failed after ${op.attemptCount} attempts`,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(providerResult ? { providerResponse: providerResult } : {}),
    attempts: op.attemptCount,
    firstAttemptAt: op.createdAt,
    lastAttemptAt: op.updatedAt,
    opId: op.opId,
  };
}

// The provider object id to surface on the receipt (e.g. the Slack message ts).
// Mirrors the read order in relay-helpers' slackReceiptTs so post() recovers it.
function readReceiptExternalId(
  providerResult: Record<string, unknown> | undefined,
): string | undefined {
  if (!providerResult) return undefined;
  for (const key of ["externalId", "providerObjectId", "ts"]) {
    const value = providerResult[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}

function readProviderStatus(
  providerResult: Record<string, unknown> | null,
): number | undefined {
  if (!providerResult) return undefined;
  const status = providerResult.status ?? providerResult.statusCode;
  if (typeof status === "number" && Number.isFinite(status)) {
    return status;
  }
  return undefined;
}

// Mirrors `classifyDeadLetterSidecarCode` in the relayfile Go daemon
// (`cmd/relayfile-cli/main.go`) so cloud's `state=dead` rows carry the
// same `code` literal a local-mount caller would see in the sidecar.
// `lastError` is consulted only when the provider response carried no
// HTTP status — schema-violation failures originate inside the adapter
// before any provider call.
function classifyDeadLetterCode(
  providerStatus: number | undefined,
  lastError: string | null,
): WritebackDeadLetterErrorCode {
  if (providerStatus !== undefined) {
    if (providerStatus === 429) return "provider_5xx_exhausted";
    if (providerStatus >= 500 && providerStatus <= 599) {
      return "provider_5xx_exhausted";
    }
    if (providerStatus >= 400 && providerStatus < 500) {
      return "provider_4xx";
    }
    return "timeout";
  }
  if (lastError && /schema|validation|invalid payload/i.test(lastError)) {
    return "schema_violation";
  }
  return "timeout";
}

export async function handleAckWriteback(
  context: OpsHandlerContext,
  request: Request,
  itemId: string,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const body = await context.readJson<WritebackAckRequest>(request);
  if (typeof body.success !== "boolean") {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing success flag",
    );
  }

  const op = getOperation(context, itemId);
  if (!op) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  const now = new Date().toISOString();
  const ackEvents: CoreEventRow[] = [];
  const adapter = captureCoreEvents(
    context.coreStorageAdapter(workspaceId, { broadcast: false }),
    ackEvents,
  );
  const ack = coreAcknowledgeWriteback(
    adapter,
    itemId,
    body.success,
    body.error,
    context.correlationId(request),
    () => now,
  );
  if (!ack) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  let providerResult: Record<string, unknown> | undefined;
  if (body.success) {
    const safeProviderResult = { ...(body.providerResult ?? {}) };
    delete safeProviderResult.acknowledgedAt;
    const result = JSON.stringify({
      acknowledgedAt: now,
      ...safeProviderResult,
    });
    context.sql.exec(
      "UPDATE operations SET provider_result_json = ? WHERE op_id = ?",
      result,
      itemId,
    );
    providerResult = parseJsonRecord(result) ?? undefined;

    // Surface the provider's object id (e.g. the Slack chat.postMessage ts)
    // back onto the draft file as a receipt, so a `slackClient().post()` still
    // polling `waitForReceipt` can read it and thread a reply. Without this the
    // id lives only in the operations row and the sandbox never sees it, so the
    // post returns an empty ts and the reply falls back to a separate message.
    // Best-effort: a failure here must never fail the ack itself.
    const receiptExternalId = readReceiptExternalId(providerResult);
    if (receiptExternalId && op.path && context.writeReceiptFile) {
      try {
        await context.writeReceiptFile({
          workspaceId,
          path: op.path,
          receipt: {
            created: now,
            path: op.path,
            externalId: receiptExternalId,
            ts: receiptExternalId,
            id: receiptExternalId,
          },
          provider: op.provider,
          correlationId: context.correlationId(request),
        });
      } catch (error) {
        console.warn("[writeback-ack] failed to surface writeback receipt", {
          opId: itemId,
          path: op.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Parent-dependency ordering: now that THIS op has a delivered provider
    // object id, release any child ops that were held waiting on it
    // (parent_op_id = itemId), handing each the parent's id (Slack uses it as
    // thread_ts; other providers as their parent reference). This is the
    // ordering guarantee — children are dispatched only here, after the parent
    // succeeds, never eagerly — so there's no poll/alarm spin-wait and no
    // attempt-count burn. Best-effort: a failure here must never fail the ack.
    if (receiptExternalId) {
      try {
        for (const childOpId of getPendingChildOpIds(context, itemId)) {
          // dispatchWriteback resolves the parent's delivered id from the child's
          // persisted parent_op_id (now that this parent has acked), so it's
          // carried on every dispatch including later retries.
          await dispatchWriteback(context, childOpId);
        }
      } catch (error) {
        console.warn("[writeback-ack] failed to dispatch parent-dependent child ops", {
          parentOpId: itemId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const updated = getOperation(context, itemId);
  if (context.flushStorage) {
    await context.flushStorage();
  }
  broadcastCoreEvents(context, ackEvents);

  if (updated) {
    await tryUpsertWorkspaceOperation(
      context,
      workspaceId,
      toWorkspaceOperationUpsert(updated, providerResult),
      updated.createdAt ?? now,
    );
  }

  await trySyncWorkspaceStats(context, workspaceId, {
    lastEventAt: now,
    lastWritebackAt: now,
    lastActivity: now,
  });

  return context.json({
    status: "acknowledged",
    id: itemId,
    correlationId: context.correlationId(request),
    success: body.success,
  });
}

export async function recordMutation(
  context: OpsHandlerContext,
  input: MutationRecordInput,
): Promise<WriteQueuedResponse> {
  const batch = await recordMutations(context, [input]);
  return batch.responses[0];
}

export async function recordMutations(
  context: OpsHandlerContext,
  inputs: MutationRecordInput[],
): Promise<MutationRecordBatchResult> {
  if (inputs.length === 0) {
    return { responses: [], syncCount: 0 };
  }

  const workspaceId = await context.getWorkspaceId();
  const adapter = context.coreStorageAdapter(workspaceId ?? "");
  const eventAdapter = context.coreStorageAdapter(workspaceId ?? "", {
    broadcast: false,
  });
  const responses: WriteQueuedResponse[] = [];
  const events: CoreEventRow[] = [];
  const writebackOperations: Array<{
    input: MutationRecordInput;
    operation: ReturnType<typeof coreCreateOperation>;
  }> = [];

  for (const input of inputs) {
    const origin = input.origin ?? "agent_write";
    // Sync ingests from upstream providers (`provider_sync`) and internal
    // system mutations (`system`) must not produce a writeback. Skip operation
    // creation entirely so the queue consumer never sees an op for these paths
    // and the alarm-driven retry loop can't pick them up either. We still emit a
    // file event so subscribers (onWrite handlers, daemon mounts) observe the
    // change. `system` is the cloud#2029 legacy-draft-drain primitive: it must
    // emit the `file.deleted` tombstone (mounts consume it via applyRemoteDelete)
    // WITHOUT a re-dispatching `file_delete` writeback op — deleting a delivered
    // Slack draft must never turn into a Slack chat.delete. NOTE: `origin` is
    // server-computed only (never request-body settable — see fs.ts handlers), so
    // this is not an agent backdoor to suppress dispatch. The four existing
    // `system` emitters (d1/digest/sync) use direct insertEvent and never reach
    // this op-creation path, so adding `system` here changes nothing else.
    if (origin === "provider_sync" || origin === "system") {
      const event = coreCreateEvent(eventAdapter, {
        type: input.eventType,
        path: input.path,
        revision: input.revision,
        origin,
        provider: input.provider,
        correlationId: input.correlationId,
        timestamp: input.timestamp,
      });
      events.push(event);
      responses.push({
        opId: "",
        status: "queued",
        targetRevision: input.revision,
        writeback: {
          provider: input.provider,
          state: "succeeded",
        },
      });
      continue;
    }

    if (
      getUnsupportedWritebackReason(input.provider, input.path, input.action)
    ) {
      const event = coreCreateEvent(eventAdapter, {
        type: input.eventType,
        path: input.path,
        revision: input.revision,
        origin,
        provider: input.provider,
        correlationId: input.correlationId,
        timestamp: input.timestamp,
      });
      events.push(event);
      responses.push({
        opId: "",
        status: "queued",
        targetRevision: input.revision,
        writeback: {
          provider: input.provider,
          state: "succeeded",
        },
      });
      continue;
    }

    const operation = coreCreateOperation(
      adapter,
      input.path,
      input.revision,
      input.action,
      input.provider,
      input.correlationId,
    );
    // Parent-dependency linking is deferred to the dispatch pass below: a parent
    // and its children can arrive in the SAME batch (an agent posts a header and
    // its threaded cards back-to-back), and the mount does not guarantee the
    // parent is ordered first. Resolving parentRef here would miss a parent that
    // appears later in this batch. The second pass runs after every op in the
    // batch exists, so resolveParentOpId always sees the parent.
    const event = coreCreateEvent(eventAdapter, {
      type: input.eventType,
      path: input.path,
      revision: input.revision,
      origin,
      provider: input.provider,
      correlationId: input.correlationId,
      timestamp: input.timestamp,
    });
    events.push(event);
    writebackOperations.push({ input, operation });
    responses.push({
      opId: operation.opId,
      status: "queued",
      targetRevision: input.revision,
      writeback: {
        provider: input.provider,
        state: "pending",
      },
    });
  }

  let syncCount = 0;
  if (context.flushStorage) {
    await context.flushStorage();
    syncCount += 1;
  }

  if (workspaceId) {
    for (const { input, operation } of writebackOperations) {
      await tryUpsertWorkspaceOperation(
        context,
        workspaceId,
        {
          opId: operation.opId,
          path: input.path,
          revision: input.revision,
          action: input.action,
          provider: input.provider,
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: null,
          lastError: null,
          correlationId: input.correlationId,
          updatedAt: input.timestamp,
          completedAt: null,
        },
        input.timestamp,
      );
    }
  }

  for (const event of events) {
    broadcastMutationEvent(context, event);
  }

  for (const { input, operation } of writebackOperations) {
    // Parent-dependency: resolve the parent link now that every op in this batch
    // exists, so a parent posted in the same batch (header + cards back-to-back)
    // is always found regardless of arrival order. Then hold the child until the
    // parent delivers — its ack dispatches it with the parent's delivered id. If
    // the parent already delivered (e.g. it landed in an earlier batch), dispatch
    // immediately. No parent link → dispatch as today.
    const parentOpId = input.parentRef
      ? resolveParentOpId(context, input.parentRef)
      : null;
    if (parentOpId) {
      setParentOpId(context, operation.opId, parentOpId);
      const ts = parentDeliveredTs(context, parentOpId);
      if (ts) {
        await dispatchWriteback(context, operation.opId);
      }
      // else: parent still pending — leave the op pending; the parent's ack
      // releases it. Deliberately NOT dispatched and NOT retry-scheduled.
      continue;
    }
    await dispatchWriteback(context, operation.opId);
  }

  return { responses, syncCount };
}

async function flushThenBroadcast(
  context: OpsHandlerContext,
  event: ReturnType<typeof coreCreateEvent>,
): Promise<void> {
  if (context.flushStorage) {
    await context.flushStorage();
  }
  broadcastMutationEvent(context, event);
}

function broadcastMutationEvent(
  context: OpsHandlerContext,
  event: CoreEventRow,
): void {
  context.broadcastEvent?.({
    eventId: event.eventId,
    type: event.type as FilesystemEvent["type"],
    path: event.path,
    revision: event.revision,
    origin: event.origin as FilesystemEvent["origin"],
    provider: event.provider,
    correlationId: event.correlationId,
    timestamp: event.timestamp,
  });
}

export async function dispatchWriteback(
  context: OpsHandlerContext,
  opId: string,
): Promise<DispatchWritebackResult> {
  const normalizedOpId = opId.trim();
  const op = getOperation(context, normalizedOpId);
  if (!op) {
    return { kind: "not_found" };
  }
  if (op.status !== "pending" && op.status !== "running") {
    return { kind: "already_dispatched" };
  }

  const workspaceId = await context.getWorkspaceId();
  if (!workspaceId) {
    return { kind: "not_found" };
  }

  const adapter = withOperationFallback(
    context.coreStorageAdapter(workspaceId, {
      broadcast: false,
    }),
    op,
  );
  // Parent-dependency: resolve the parent's delivered provider object id from the
  // PERSISTED parent_op_id, so EVERY dispatch of this op carries it — the initial
  // ack-driven release AND any later alarm retry (which re-dispatches with no
  // extra context). Carrying it only on a transient argument would drop it on
  // retry, and the provider would post the retry without the parent reference
  // (e.g. a Slack reply landing top-level instead of in-thread).
  const parentOpId = getParentOpId(context, normalizedOpId);
  const parentExternalId = parentOpId
    ? parentDeliveredTs(context, parentOpId)
    : undefined;
  const dispatchNow = new Date().toISOString();
  const item = {
    opId: op.opId,
    workspaceId,
    path: op.path ?? "",
    revision: op.revision ?? "",
    correlationId: op.correlationId ?? "",
    ...(parentExternalId ? { parentExternalId } : {}),
  } satisfies WritebackMessage;

  let retryScheduled = false;
  const ok = coreDispatchWriteback(adapter, normalizedOpId, {
    send: () => undefined,
    onRetryScheduled: () => {
      retryScheduled = true;
    },
    now: () => dispatchNow,
  });

  const updated = getOperation(context, normalizedOpId);
  if (!updated) {
    return ok ? { kind: "queued" } : { kind: "not_found" };
  }

  if (context.flushStorage) {
    await context.flushStorage();
  }

  if (!ok) {
    const mirror = await mirrorDispatchedOperation(
      context,
      workspaceId,
      op,
      updated,
      dispatchNow,
      retryScheduled,
    );
    return dispatchResultFromOperation(
      updated,
      retryScheduled,
      mirror.retryAlarmFailed,
    );
  }

  try {
    await context.bindings.WRITEBACK_QUEUE.send(item);
  } catch (error) {
    return markDispatchSendFailure(
      context,
      workspaceId,
      op,
      dispatchNow,
      error,
    );
  }

  await mirrorDispatchedOperation(
    context,
    workspaceId,
    op,
    updated,
    dispatchNow,
    retryScheduled,
  );

  return { kind: "queued" };
}

async function markDispatchSendFailure(
  context: OpsHandlerContext,
  workspaceId: string,
  op: WorkspaceOperation,
  dispatchNow: string,
  error: unknown,
): Promise<DispatchWritebackResult> {
  const baseAdapter = context.coreStorageAdapter(workspaceId, {
    broadcast: false,
  });
  const failureEvents: CoreEventRow[] = [];
  let retryScheduled = false;
  const ok = coreDispatchWriteback(
    captureCoreEvents(
      {
        ...baseAdapter,
        getOperation: (opId) =>
          opId.trim() === op.opId
            ? toCoreOperationRow(op)
            : baseAdapter.getOperation(opId),
      },
      failureEvents,
    ),
    op.opId,
    {
      send: () => {
        throw error;
      },
      onRetryScheduled: () => {
        retryScheduled = true;
      },
      now: () => dispatchNow,
    },
  );

  if (context.flushStorage) {
    await context.flushStorage();
  }

  const updated = getOperation(context, op.opId);
  if (!updated) {
    return ok ? { kind: "queued" } : { kind: "not_found" };
  }
  broadcastCoreEvents(context, failureEvents);

  const mirror = await mirrorDispatchedOperation(
    context,
    workspaceId,
    op,
    updated,
    dispatchNow,
    retryScheduled,
  );
  return dispatchResultFromOperation(
    updated,
    retryScheduled,
    mirror.retryAlarmFailed,
  );
}

async function mirrorDispatchedOperation(
  context: OpsHandlerContext,
  workspaceId: string,
  original: WorkspaceOperation,
  updated: WorkspaceOperation,
  dispatchNow: string,
  retryScheduled: boolean,
): Promise<{ retryAlarmFailed: boolean }> {
  await tryUpsertWorkspaceOperation(
    context,
    workspaceId,
    toWorkspaceOperationUpsert(
      updated,
      parseJsonRecord(original.providerResultJson ?? undefined) ?? undefined,
    ),
    original.createdAt ?? dispatchNow,
  );

  let retryAlarmFailed = false;
  if (retryScheduled || updated.nextAttemptAt) {
    try {
      await ensureNextAlarm(context);
    } catch (err) {
      retryAlarmFailed = true;
      console.error("writeback: ensureNextAlarm failed", err);
    }
  }
  if (updated.status === "dead_lettered") {
    await trySyncWorkspaceStats(context, workspaceId, {
      lastEventAt: dispatchNow,
      lastActivity: dispatchNow,
    });
  }
  return { retryAlarmFailed };
}

function captureCoreEvents(
  adapter: CoreStorageAdapter,
  events: CoreEventRow[],
): CoreStorageAdapter {
  return {
    ...adapter,
    appendEvent: (event) => {
      events.push(event);
      adapter.appendEvent(event);
    },
  };
}

function broadcastCoreEvents(
  context: OpsHandlerContext,
  events: readonly CoreEventRow[],
): void {
  for (const event of events) {
    broadcastMutationEvent(context, event);
  }
}

function dispatchResultFromOperation(
  operation: WorkspaceOperation,
  retryScheduled: boolean,
  retryAlarmFailed = false,
): DispatchWritebackResult {
  if (operation.status === "dead_lettered") return { kind: "dead_lettered" };
  if (retryScheduled || operation.nextAttemptAt) {
    if (retryAlarmFailed) return { kind: "retry_alarm_failed" };
    return { kind: "retry_scheduled" };
  }
  return { kind: "queued" };
}

async function tryUpsertWorkspaceOperation(
  context: Pick<OpsHandlerContext, "upsertWorkspaceOperation">,
  workspaceId: string,
  operation: WorkspaceOperationUpsert,
  createdAt: string,
): Promise<void> {
  try {
    await context.upsertWorkspaceOperation(workspaceId, operation, createdAt);
  } catch (err) {
    console.error("writeback: workspace operation mirror failed", err);
  }
}

async function trySyncWorkspaceStats(
  context: Pick<OpsHandlerContext, "syncWorkspaceStats">,
  workspaceId: string,
  overrides: StatsSyncOverrides,
): Promise<void> {
  try {
    await context.syncWorkspaceStats(workspaceId, overrides);
  } catch (err) {
    console.error("writeback: syncWorkspaceStats failed", err);
  }
}

function toCoreOperationRow(op: WorkspaceOperation) {
  return {
    opId: op.opId,
    path: op.path,
    revision: op.revision,
    action: op.action,
    provider: op.provider,
    status: op.status,
    attemptCount: op.attemptCount,
    nextAttemptAt: op.nextAttemptAt,
    lastError: op.lastError,
    correlationId: op.correlationId,
  };
}

function withOperationFallback(
  adapter: CoreStorageAdapter,
  op: WorkspaceOperation,
): CoreStorageAdapter {
  return {
    ...adapter,
    getOperation: (opId) => {
      const existing = adapter.getOperation(opId);
      if (existing) {
        return existing;
      }
      return opId.trim() === op.opId.trim() ? toCoreOperationRow(op) : null;
    },
  };
}

export function getOperation(
  context: Pick<OpsHandlerContext, "sql">,
  opId: string,
): WorkspaceOperation | null {
  const row = one<Row>(
    context.sql,
    `
      SELECT op_id, path, revision, action, provider, status, attempt_count,
             next_attempt_at, last_error, provider_result_json, correlation_id, created_at,
             updated_at, completed_at
      FROM operations
      WHERE op_id = ?
    `,
    opId,
  );
  return row ? toWorkspaceOperation(row) : null;
}

// ── Parent-dependency helpers (ordered writeback dispatch) ───────────────────
// `parent_op_id` lives only in SQL (not on the @relayfile/core WorkspaceOperation
// type), so these read/write it directly. All are no-ops for the common case.

/**
 * Resolve a parent-message draft relay path to the op_id of its writeback op.
 * Picks the most recent non-failed op at that path. Returns null if none — the
 * caller then dispatches the child normally (degrade to today's behavior).
 */
function resolveParentOpId(
  context: Pick<OpsHandlerContext, "sql">,
  parentRef: string,
): string | null {
  const row = one<{ op_id: unknown }>(
    context.sql,
    `
      SELECT op_id FROM operations
      WHERE path = ? AND status != 'failed'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    normalizePath(parentRef),
  );
  return row ? asString(row.op_id) : null;
}

/** Persist a child op's parent pointer. */
function setParentOpId(
  context: Pick<OpsHandlerContext, "sql">,
  opId: string,
  parentOpId: string,
): void {
  context.sql.exec(
    "UPDATE operations SET parent_op_id = ? WHERE op_id = ?",
    parentOpId,
    opId,
  );
}

/** A child op's parent pointer (parent_op_id), or null if it has none. */
function getParentOpId(
  context: Pick<OpsHandlerContext, "sql">,
  opId: string,
): string | null {
  const row = one<{ parent_op_id: string | null }>(
    context.sql,
    "SELECT parent_op_id FROM operations WHERE op_id = ? LIMIT 1",
    opId,
  );
  const parentOpId = row?.parent_op_id;
  return typeof parentOpId === "string" && parentOpId.length > 0
    ? parentOpId
    : null;
}

/**
 * The parent op's delivered provider object id (e.g. the Slack ts) if it has
 * acked successfully, else null — i.e. "is the parent delivered yet, and to what".
 */
function parentDeliveredTs(
  context: Pick<OpsHandlerContext, "sql">,
  parentOpId: string,
): string | null {
  const op = getOperation(context, parentOpId);
  if (!op?.providerResultJson) return null;
  return (
    readReceiptExternalId(parseJsonRecord(op.providerResultJson) ?? undefined) ??
    null
  );
}

/** Pending child ops waiting on a given parent op (ack-driven release set). */
function getPendingChildOpIds(
  context: Pick<OpsHandlerContext, "sql">,
  parentOpId: string,
): string[] {
  const cursor = context.sql.exec(
    // LIMIT keeps the CI unbounded-SELECT gate happy; a Slack message realistically
    // has a handful of held replies, never thousands.
    "SELECT op_id FROM operations WHERE parent_op_id = ? AND status = 'pending' LIMIT 1000",
    parentOpId,
  ) as {
    toArray?: <R>() => R[];
    [Symbol.iterator]?: () => Iterator<{ op_id: unknown }>;
  };
  const rows =
    typeof cursor.toArray === "function"
      ? cursor.toArray<{ op_id: unknown }>()
      : [...(cursor as Iterable<{ op_id: unknown }>)];
  return rows.map((row) => asString(row.op_id)).filter(Boolean);
}

export async function ensureNextAlarm(
  context: Pick<OpsHandlerContext, "sql" | "state">,
): Promise<void> {
  const next = one<Row>(
    context.sql,
    `
      SELECT next_attempt_at
      FROM operations
      WHERE status = 'pending'
        AND next_attempt_at IS NOT NULL
      ORDER BY next_attempt_at ASC
      LIMIT 1
    `,
  );

  // The DO has a single alarm shared between writeback-op retries and the
  // debounced digest refresh. Reconcile to the EARLIEST of the two so neither
  // wipes the other (cloud#846: a bare deleteAlarm here used to drop a pending
  // digest refresh whenever no ops were queued).
  const candidates: number[] = [];
  const opWhen = next ? Date.parse(asString(next.next_attempt_at)) : Number.NaN;
  if (Number.isFinite(opWhen)) {
    candidates.push(opWhen);
  }
  const digestDueAt = await readDigestRefreshDueAt(context);
  if (digestDueAt !== undefined) {
    candidates.push(digestDueAt);
  }

  if (candidates.length === 0) {
    await context.state.storage.deleteAlarm();
    return;
  }
  await context.state.storage.setAlarm(Math.min(...candidates));
}

async function readDigestRefreshDueAt(
  context: Pick<OpsHandlerContext, "state">,
): Promise<number | undefined> {
  const get = context.state.storage.get;
  if (typeof get !== "function") {
    return undefined;
  }
  const dueAt = await get.call(
    context.state.storage,
    DIGEST_REFRESH_DUE_STORAGE_KEY,
  );
  return typeof dueAt === "number" && Number.isFinite(dueAt)
    ? dueAt
    : undefined;
}

function one<T extends Row>(
  sql: SqlStorageLike,
  query: string,
  ...bindings: unknown[]
): T | null {
  const cursor = sql.exec(query, ...bindings) as {
    one?: <R>() => R | null;
    toArray?: <R>() => R[];
    [Symbol.iterator]?: () => Iterator<T>;
  };
  if (typeof cursor.one === "function") {
    try {
      return cursor.one<T>() ?? null;
    } catch {
      if (typeof cursor.toArray === "function") {
        const rows = cursor.toArray<T>();
        return rows[0] ?? null;
      }
    }
  }
  if (typeof cursor.toArray === "function") {
    const rows = cursor.toArray<T>();
    return rows[0] ?? null;
  }
  const iteratorFactory = cursor[Symbol.iterator];
  if (typeof iteratorFactory === "function") {
    const first = iteratorFactory.call(cursor).next();
    return first.done ? null : first.value;
  }
  return null;
}

function toWorkspaceOperation(row: Row): WorkspaceOperation {
  return {
    opId: asString(row.op_id),
    path: normalizePath(asString(row.path)),
    revision: asString(row.revision),
    action: (asString(row.action) ||
      "file_upsert") as WorkspaceOperation["action"],
    provider: asString(row.provider),
    status: (asString(row.status) || "pending") as WorkspaceOperation["status"],
    attemptCount: asNumber(row.attempt_count),
    nextAttemptAt: asOptionalString(row.next_attempt_at) ?? null,
    lastError: asOptionalString(row.last_error) ?? null,
    providerResultJson: asOptionalString(row.provider_result_json) ?? null,
    correlationId: asString(row.correlation_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at) || new Date().toISOString(),
    completedAt: row.completed_at ? asString(row.completed_at) : null,
  };
}

function toOperationStatusResponse(
  op: WorkspaceOperation,
  providerResult?: Record<string, unknown>,
): OperationStatusResponse {
  return {
    opId: op.opId,
    path: op.path || undefined,
    revision: op.revision || undefined,
    action: op.action as OperationStatusResponse["action"],
    provider: op.provider || undefined,
    status: publicOperationStatus(op.status),
    attemptCount: op.attemptCount,
    nextAttemptAt: op.nextAttemptAt,
    lastError: op.lastError,
    providerResult,
    correlationId: op.correlationId || undefined,
  };
}

function publicOperationStatus(
  status: string | undefined,
): OperationStatusResponse["status"] {
  switch (status) {
    case "dispatched":
      return "running";
    case "pending":
    case "running":
    case "succeeded":
    case "failed":
    case "dead_lettered":
    case "canceled":
      return status;
    default:
      return "pending";
  }
}

function toWorkspaceOperationUpsert(
  op: WorkspaceOperation,
  providerResult?: Record<string, unknown>,
): WorkspaceOperationUpsert {
  const updatedAt = op.updatedAt || new Date().toISOString();
  return {
    ...toOperationStatusResponse(op, providerResult),
    updatedAt,
    completedAt:
      op.completedAt ??
      (isTerminalOperationStatus(op.status) ? updatedAt : null),
  };
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

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : "/";
}

function parseJsonRecord(raw?: string): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore malformed JSON
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

function asOptionalString(value: unknown): string | undefined {
  const normalized = asString(value).trim();
  return normalized || undefined;
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isReplayableOperationStatus(status?: string): boolean {
  return (
    status === "failed" || status === "dead_lettered" || status === "canceled"
  );
}

function isTerminalOperationStatus(status?: string): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "dead_lettered" ||
    status === "canceled"
  );
}
