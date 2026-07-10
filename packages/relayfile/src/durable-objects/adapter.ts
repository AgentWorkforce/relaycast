import {
  filePermissionAllows,
  parseSemantics as coreParseSemantics,
  resolveFilePermissions,
  type PermissionEvaluationOptions,
  type StorageAdapter as CoreStorageAdapter,
  type FileRow as CoreFileRow,
  type EventRow as CoreEventRow,
  type OperationRow as CoreOperationRow,
  type TokenClaims as CoreTokenClaims,
} from "@relayfile/core";
import type { FilesystemEvent, OperationStatusResponse } from "@relayfile/sdk";
import type {
  WorkspaceEvent,
  WorkspaceFile,
  WorkspaceOperation,
} from "../types.js";
import {
  RUNTIME_FILES,
  runtimeWorkspaceFile,
  runtimeContentForRef,
  activitySummaryWorkspaceFile,
} from "./runtime-files.js";

export type Row = Record<string, unknown>;

/**
 * Hard cap on how many rows any single unbounded list/scan query may
 * materialize into the DO isolate at once. The WorkspaceDO is one instance
 * per workspace with a ~128MB memory cap, so a `SELECT ... FROM files` with
 * no LIMIT on a large workspace (500+ files) was a primary OOM vector.
 *
 * Queries that support keyset pagination (cursor on a monotonic column)
 * page through in chunks of this size; queries that historically returned
 * "everything" are clamped to this many rows defensively.
 */
export const MAX_LIST_ROWS = 1000;

/**
 * Page size for keyset-paginated scans (e.g. streaming workspace export).
 * Smaller than {@link MAX_LIST_ROWS} so that even when each row drags a
 * content body along behind it (loaded one-at-a-time from R2) the working
 * set stays bounded.
 */
export const EXPORT_FILE_PAGE_SIZE = 200;

const TERMINAL_OPERATION_STATUSES = new Set([
  "succeeded",
  "failed",
  "dead_lettered",
  "canceled",
]);

export type CoreContentState = {
  content: string;
  encoding: "utf-8" | "base64";
};

export interface WorkspaceAdapterContext {
  allRows<T extends Row = Row>(query: string, ...bindings: unknown[]): T[];
  sqlExec(query: string, ...bindings: unknown[]): void;
  getFileRow(path: string): WorkspaceFile | null;
  getOperation(opId: string): WorkspaceOperation | null;
  insertEvent(event: FilesystemEvent, options?: { broadcast?: boolean }): void;
  loadContent(
    contentRef: string,
    encoding: "utf-8" | "base64",
  ): Promise<string>;
  nextId(prefix: "rev" | "evt" | "op"): string;
  toWorkspaceFile(row: Row): WorkspaceFile;
  toEvent(row: Row): WorkspaceEvent;
  toWorkspaceOperation(row: Row): WorkspaceOperation;
}

export type WebhookStagedState = {
  file: CoreFileRow | null;
  deletedPath: string | null;
  events: CoreEventRow[];
};

export function createCoreStorageAdapter(
  context: WorkspaceAdapterContext,
  workspaceId: string,
  contentByPath?: Map<string, CoreContentState>,
  eventOptions?: { broadcast?: boolean },
): CoreStorageAdapter {
  return {
    getFile: (path) => {
      const file = context.getFileRow(normalizePath(path));
      return file ? toCoreFileRow(file, contentByPath) : null;
    },
    listFiles: () => {
      const files: CoreFileRow[] = [];
      let cursor: string | null = null;
      for (;;) {
        const rows = context.allRows<Row>(
          `
            SELECT path, revision, content_type, content_ref, size, encoding, updated_at, semantics_json,
                   provider, provider_object_id, content_hash
            FROM files
            ${cursor !== null ? "WHERE path > ?" : ""}
            ORDER BY path ASC
            LIMIT ?
          `,
          ...(cursor !== null ? [cursor] : []),
          MAX_LIST_ROWS,
        );
        for (const row of rows) {
          const file = context.toWorkspaceFile(row);
          cursor = file.path;
          files.push(toCoreFileRow(file, contentByPath));
        }
        if (rows.length < MAX_LIST_ROWS) {
          return files;
        }
      }
    },
    putFile: () => {
      throw new Error(
        "putFile must stay in workspace.ts because it depends on R2",
      );
    },
    deleteFile: (path) => {
      context.sqlExec("DELETE FROM files WHERE path = ?", normalizePath(path));
    },
    loadFileContent: (file) => {
      const loaded = contentByPath?.get(normalizePath(file.path));
      return loaded
        ? { ...loaded }
        : { content: file.content, encoding: file.encoding };
    },
    appendEvent: (event) => {
      context.insertEvent(
        {
          eventId: event.eventId,
          type: event.type as FilesystemEvent["type"],
          path: normalizePath(event.path),
          revision: event.revision,
          origin: event.origin as FilesystemEvent["origin"],
          provider: event.provider,
          correlationId: event.correlationId,
          timestamp: event.timestamp,
        },
        eventOptions,
      );
    },
    listEvents: (options) => {
      const provider = normalizeProvider(options.provider);
      const limit = Math.max(1, Math.min(options.limit ?? 200, MAX_LIST_ROWS));

      // Forward keyset pagination: the feed is ordered (timestamp ASC,
      // event_id ASC) and the cursor is the last (newest) event_id of the
      // previous page. The daemon uses the cursor as a forward watermark and
      // expects events *newer* than it, oldest-first, so incremental sync can
      // replay changes chronologically and advance toward the tip. We resolve
      // the cursor's (timestamp, event_id) and ask SQL for only the next
      // `limit + 1` rows strictly after it, instead of pulling every event
      // row into the isolate and slicing in JS. (getRecentEvents below stays
      // newest-first for the "latest N" read path.)
      const conditions: string[] = [];
      const bindings: unknown[] = [];
      if (provider) {
        conditions.push("provider = ?");
        bindings.push(provider);
      }

      if (options.cursor) {
        const cursorBindings: unknown[] = [options.cursor];
        const cursorProvider = provider ? "AND provider = ?" : "";
        if (provider) cursorBindings.push(provider);
        const cursorRow = context.allRows<Row>(
          `SELECT timestamp, event_id FROM events WHERE event_id = ? ${cursorProvider} LIMIT 1`,
          ...cursorBindings,
        )[0];
        if (cursorRow) {
          // Seek on the numeric suffix, not the lexical id: `evt_<n>` counters are
          // unpadded so `evt_100` < `evt_99` lexically, which on a same-ms tie
          // strands events after the cursor permanently (e.g. a lost Slack receipt
          // → post() never threads). Mirrors the listEvents fix in handlers/fs.ts.
          conditions.push(
            "(timestamp > ? OR (timestamp = ? AND CAST(SUBSTR(event_id, 5) AS INTEGER) > ?))",
          );
          bindings.push(
            cursorRow.timestamp,
            cursorRow.timestamp,
            Number.parseInt(String(cursorRow.event_id).slice(4), 10),
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
            ORDER BY timestamp ASC, CAST(SUBSTR(event_id, 5) AS INTEGER) ASC
            LIMIT ?
          `,
          ...bindings,
          limit + 1,
        )
        .map((row) => toCoreEventRow(context.toEvent(row)));

      const hasMore = rows.length > limit;
      const slice = rows.slice(0, limit);
      return {
        items: slice,
        nextCursor: hasMore ? (slice[slice.length - 1]?.eventId ?? null) : null,
      };
    },
    getRecentEvents: (limit) => {
      const cappedLimit = Math.max(1, Math.min(limit, 1000));
      return context
        .allRows<Row>(
          `
            SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp, content_hash
            FROM (
              SELECT event_id, type, path, revision, origin, provider, correlation_id, timestamp, content_hash
              FROM events
              ORDER BY timestamp DESC, CAST(SUBSTR(event_id, 5) AS INTEGER) DESC
              LIMIT ?
            )
            ORDER BY timestamp ASC, CAST(SUBSTR(event_id, 5) AS INTEGER) ASC
          `,
          cappedLimit,
        )
        .map((row) => toCoreEventRow(context.toEvent(row)));
    },
    getOperation: (opId) => {
      const op = context.getOperation(opId);
      return op ? toCoreOperationRow(op) : null;
    },
    putOperation: (op) => {
      const now = new Date().toISOString();
      const isTerminal = TERMINAL_OPERATION_STATUSES.has(op.status);
      context.sqlExec(
        `
          INSERT INTO operations (
            op_id, path, revision, action, provider, status, attempt_count,
            next_attempt_at, last_error, provider_result_json, correlation_id, created_at,
            updated_at, completed_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?,
            COALESCE((SELECT created_at FROM operations WHERE op_id = ?), ?),
            ?,
            CASE
              WHEN ? THEN COALESCE((SELECT completed_at FROM operations WHERE op_id = ?), ?)
              ELSE NULL
            END
          )
          ON CONFLICT(op_id) DO UPDATE SET
            path = excluded.path,
            revision = excluded.revision,
            action = excluded.action,
            provider = excluded.provider,
            status = excluded.status,
            attempt_count = excluded.attempt_count,
            next_attempt_at = excluded.next_attempt_at,
            last_error = excluded.last_error,
            correlation_id = excluded.correlation_id,
            updated_at = excluded.updated_at,
            completed_at = excluded.completed_at
        `,
        op.opId,
        normalizePath(op.path),
        op.revision,
        op.action,
        normalizeProvider(op.provider),
        op.status,
        op.attemptCount,
        op.nextAttemptAt,
        op.lastError,
        op.correlationId,
        op.opId,
        now,
        now,
        isTerminal ? 1 : 0,
        op.opId,
        now,
      );
    },
    listOperations: (options) => {
      const provider = normalizeProvider(options.provider);
      const limit = Math.max(1, Math.min(options.limit ?? 100, MAX_LIST_ROWS));
      const conditions: string[] = [];
      const bindings: unknown[] = [];

      if (options.status) {
        if (options.status === "running") {
          conditions.push("status IN (?, ?)");
          bindings.push("running", "dispatched");
        } else {
          conditions.push("status = ?");
          bindings.push(options.status);
        }
      }
      if (options.action) {
        conditions.push("action = ?");
        bindings.push(options.action);
      }
      if (provider) {
        conditions.push("provider = ?");
        bindings.push(provider);
      }
      if (options.cursor) {
        const cursorRow = context.allRows<Row>(
          `SELECT created_at, op_id FROM operations WHERE op_id = ? LIMIT 1`,
          options.cursor,
        )[0];
        if (cursorRow) {
          conditions.push("(created_at < ? OR (created_at = ? AND op_id < ?))");
          bindings.push(
            cursorRow.created_at,
            cursorRow.created_at,
            cursorRow.op_id,
          );
        }
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const ops = context
        .allRows<Row>(
          `
            SELECT op_id, path, revision, action, provider, status, attempt_count,
                   next_attempt_at, last_error, provider_result_json, correlation_id, created_at,
                   updated_at, completed_at
            FROM operations
            ${whereClause}
            ORDER BY created_at DESC, op_id DESC
            LIMIT ?
          `,
          ...bindings,
          limit + 1,
        )
        .map((row) => toCoreOperationRow(context.toWorkspaceOperation(row)));

      const slice = ops.slice(0, limit);
      return {
        items: slice,
        nextCursor:
          ops.length > limit ? (slice[slice.length - 1]?.opId ?? null) : null,
      };
    },
    nextRevision: () => context.nextId("rev"),
    nextOperationId: () => context.nextId("op"),
    nextEventId: () => context.nextId("evt"),
    enqueueWriteback: () => {},
    getPendingWritebacks: () => [],
    getWorkspaceId: () => workspaceId,
  };
}

export function createWebhookStagingAdapter(
  context: Pick<WorkspaceAdapterContext, "getFileRow" | "nextId">,
  workspaceId: string,
): { adapter: CoreStorageAdapter; staged: WebhookStagedState } {
  const staged: WebhookStagedState = {
    file: null,
    deletedPath: null,
    events: [],
  };

  const adapter: CoreStorageAdapter = {
    getFile: (path) => {
      const normalizedPath = normalizePath(path);
      if (staged.deletedPath === normalizedPath) {
        return null;
      }
      if (staged.file?.path === normalizedPath) {
        return staged.file;
      }

      const existing = context.getFileRow(normalizedPath);
      return existing ? toCoreFileRow(existing) : null;
    },
    listFiles: () => [],
    putFile: (file) => {
      staged.file = file;
      staged.deletedPath = null;
    },
    deleteFile: (path) => {
      const normalizedPath = normalizePath(path);
      if (staged.file?.path === normalizedPath) {
        staged.file = null;
      }
      staged.deletedPath = normalizedPath;
    },
    appendEvent: (event) => {
      staged.events.push(event);
    },
    listEvents: () => ({ items: [], nextCursor: null }),
    getRecentEvents: () => [],
    getOperation: () => null,
    putOperation: () => {},
    listOperations: () => ({ items: [], nextCursor: null }),
    nextRevision: () => context.nextId("rev"),
    nextOperationId: () => context.nextId("op"),
    nextEventId: () => context.nextId("evt"),
    enqueueWriteback: () => {},
    getPendingWritebacks: () => [],
    getWorkspaceId: () => workspaceId,
  };

  return { adapter, staged };
}

export type ExportContextDeps = Pick<
  WorkspaceAdapterContext,
  "allRows" | "toWorkspaceFile" | "loadContent"
> &
  Pick<
    WorkspaceAdapterContext,
    | "getFileRow"
    | "getOperation"
    | "insertEvent"
    | "nextId"
    | "sqlExec"
    | "toEvent"
    | "toWorkspaceOperation"
  >;

export type ExportFileChunk = {
  file: WorkspaceFile;
  content: string;
};

function normalizeExportPathPrefix(pathPrefix?: string | null): string | null {
  if (!pathPrefix?.trim()) {
    return null;
  }
  const normalized = normalizePath(pathPrefix);
  return normalized === "/" ? null : normalized;
}

function exportPathRange(pathPrefix: string): [string, string] {
  return [`${pathPrefix}/`, `${pathPrefix}0`];
}

function exportRowsQuery(
  pathPrefix: string | null,
  cursor: string | null,
): string {
  if (pathPrefix) {
    return `
      SELECT path, revision, content_type, content_ref, size, encoding, updated_at, semantics_json,
             provider, provider_object_id, content_hash
      FROM files
      WHERE path >= ? AND path < ?
        ${cursor !== null ? "AND path > ?" : ""}
      ORDER BY path ASC
      LIMIT ?
    `;
  }
  return `
    SELECT path, revision, content_type, content_ref, size, encoding, updated_at, semantics_json,
           provider, provider_object_id, content_hash
    FROM files
    ${cursor !== null ? "WHERE path > ?" : ""}
    ORDER BY path ASC
    LIMIT ?
  `;
}

function exportSizeRowsQuery(
  pathPrefix: string | null,
  cursor: string | null,
): string {
  if (pathPrefix) {
    return `
      SELECT path, size
      FROM files
      WHERE path >= ? AND path < ?
        ${cursor !== null ? "AND path > ?" : ""}
      ORDER BY path ASC
      LIMIT ?
    `;
  }
  return `
    SELECT path, size
    FROM files
    ${cursor !== null ? "WHERE path > ?" : ""}
    ORDER BY path ASC
    LIMIT ?
  `;
}

function exportBindings(
  pathPrefix: string | null,
  cursor: string | null,
  limit: number,
): unknown[] {
  if (pathPrefix) {
    const [lower, upper] = exportPathRange(pathPrefix);
    return cursor !== null
      ? [lower, upper, cursor, limit]
      : [lower, upper, limit];
  }
  return cursor !== null ? [cursor, limit] : [limit];
}

/**
 * Count of files in the workspace, used to gate non-paginated full export
 * on very large workspaces.
 */
export function countWorkspaceFiles(
  context: Pick<WorkspaceAdapterContext, "allRows">,
): number {
  const row = context.allRows<Row>(`SELECT COUNT(*) AS count FROM files`)[0];
  const raw = row?.count;
  return typeof raw === "number" ? raw : Number(raw ?? 0);
}

export function countExportableWorkspaceFiles(
  context: ExportContextDeps,
  workspaceId: string,
  claims: TokenClaimsLike | null,
  pageSize = MAX_LIST_ROWS,
  stopAfter = Number.POSITIVE_INFINITY,
  pathPrefix?: string | null,
  aclOptions: PermissionEvaluationOptions = {},
): number {
  const aclAdapter = createCoreStorageAdapter(context, workspaceId);
  const limit = Math.max(1, Math.min(pageSize, MAX_LIST_ROWS));
  const normalizedPrefix = normalizeExportPathPrefix(pathPrefix);
  let cursor: string | null = null;
  let count = 0;
  for (const rf of RUNTIME_FILES) {
    const file = runtimeWorkspaceFile(rf);
    if (
      (!normalizedPrefix || file.path.startsWith(normalizedPrefix + "/") || file.path === normalizedPrefix) &&
      exportAclAllows(aclAdapter, workspaceId, file.path, claims, aclOptions)
    ) {
      count += 1;
      if (count >= stopAfter) {
        return count;
      }
    }
  }

  for (;;) {
    const rows: WorkspaceFile[] = context
      .allRows<Row>(
        exportRowsQuery(normalizedPrefix, cursor),
        ...exportBindings(normalizedPrefix, cursor, limit),
      )
      .map((row) => context.toWorkspaceFile(row));

    if (rows.length === 0) {
      return count;
    }

    for (const file of rows) {
      cursor = file.path;
      if (
        exportAclAllows(aclAdapter, workspaceId, file.path, claims, aclOptions)
      ) {
        count += 1;
        if (count >= stopAfter) {
          return count;
        }
      }
    }

    if (rows.length < limit) {
      return count;
    }
  }
}

export type ExportableWorkspaceSummary = {
  fileCount: number;
  totalSizeBytes: number;
  exceededFileLimit: boolean;
  exceededBodyLimit: boolean;
};

type ExportableWorkspaceFileRow = Row & {
  path: unknown;
  size: unknown;
};

export function summarizeExportableWorkspaceFiles(
  context: ExportContextDeps,
  workspaceId: string,
  claims: TokenClaimsLike | null,
  options: {
    pageSize?: number;
    stopAfterCount?: number;
    stopAfterBytes?: number;
    pathPrefix?: string | null;
    aclOptions?: PermissionEvaluationOptions;
  } = {},
): ExportableWorkspaceSummary {
  const aclAdapter = createCoreStorageAdapter(context, workspaceId);
  const limit = Math.max(
    1,
    Math.min(options.pageSize ?? MAX_LIST_ROWS, MAX_LIST_ROWS),
  );
  const stopAfterCount = options.stopAfterCount ?? Number.POSITIVE_INFINITY;
  const stopAfterBytes = options.stopAfterBytes ?? Number.POSITIVE_INFINITY;
  const pathPrefix = normalizeExportPathPrefix(options.pathPrefix);
  const aclOptions = options.aclOptions ?? {};
  let cursor: string | null = null;
  let fileCount = 0;
  let totalSizeBytes = 0;

  const includeFile = (path: string, size: number): boolean => {
    if (!exportAclAllows(aclAdapter, workspaceId, path, claims, aclOptions)) {
      return false;
    }
    fileCount += 1;
    totalSizeBytes += Math.max(0, size);
    return fileCount >= stopAfterCount || totalSizeBytes > stopAfterBytes;
  };

  for (const rf of RUNTIME_FILES) {
    const file = runtimeWorkspaceFile(rf);
    if (!pathPrefix || file.path.startsWith(pathPrefix + "/") || file.path === pathPrefix) {
      if (includeFile(file.path, file.size)) {
        return {
          fileCount,
          totalSizeBytes,
          exceededFileLimit: fileCount >= stopAfterCount,
          exceededBodyLimit: totalSizeBytes > stopAfterBytes,
        };
      }
    }
  }

  for (;;) {
    const rows: ExportableWorkspaceFileRow[] =
      context.allRows<ExportableWorkspaceFileRow>(
        exportSizeRowsQuery(pathPrefix, cursor),
        ...exportBindings(pathPrefix, cursor, limit),
      );

    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      const path = String(row.path ?? "");
      cursor = path;
      const rawSize = row.size;
      const size = typeof rawSize === "number" ? rawSize : Number(rawSize ?? 0);
      if (includeFile(path, Number.isFinite(size) ? size : 0)) {
        return {
          fileCount,
          totalSizeBytes,
          exceededFileLimit: fileCount >= stopAfterCount,
          exceededBodyLimit: totalSizeBytes > stopAfterBytes,
        };
      }
    }

    if (rows.length < limit) {
      break;
    }
  }

  return {
    fileCount,
    totalSizeBytes,
    exceededFileLimit: false,
    exceededBodyLimit: false,
  };
}

/**
 * Keyset-paginated async iterator over every file in the workspace.
 *
 * This replaces the previous `buildCoreExportContext`, which materialized
 * the ENTIRE workspace tree AND every file body into a single
 * `contentByPath` map before returning — the primary OOM offender for the
 * one-DO-per-workspace WorkspaceDO (~128MB cap).
 *
 * Instead we:
 *  - page the `files` table via `WHERE path > ? ORDER BY path ASC LIMIT N`
 *    (no unbounded `SELECT ... FROM files`), and
 *  - load each file's body from R2 one at a time, yielding it and then
 *    letting it be garbage-collected before the next file is fetched.
 *
 * ACL filtering is applied per-file using a metadata-only adapter
 * (`createCoreStorageAdapter` with no `contentByPath`); `resolveFilePermissions`
 * only reads `semantics.permissions` off ancestor `.relayfile.acl` markers,
 * never file bodies, so streaming export never needs the full content map.
 */
/**
 * Metadata-only export manifest row.
 *
 * Mirrors {@link WorkspaceFile} but the contract is: the DO returns this,
 * NEVER a file body. The parent Worker pages through manifest entries and
 * streams the actual body bytes from R2 directly, so an export of an
 * N-file workspace never causes the DO isolate to allocate a single file
 * body. See `hardening item 1`.
 */
export type ExportManifestEntry = WorkspaceFile;

/**
 * One page of manifest entries plus a keyset cursor. `nextCursor` is the
 * last scanned path (the caller passes this back as `afterPath` to continue);
 * `null` when there are no more rows.
 */
export type ExportManifestPage = {
  entries: ExportManifestEntry[];
  nextCursor: string | null;
};

/**
 * Returns a single page of export-manifest entries, ACL-filtered, with
 * keyset pagination. Critically, this function does NOT call
 * `context.loadContent` — the DO returns metadata only, and the parent
 * Worker pulls bodies straight from R2. This is the structural OOM
 * guarantee for export.
 */
export function listWorkspaceExportManifestPage(
  context: ExportContextDeps,
  workspaceId: string,
  claims: TokenClaimsLike | null,
  afterPath: string | null,
  pageSize = EXPORT_FILE_PAGE_SIZE,
  pathPrefix?: string | null,
  aclOptions: PermissionEvaluationOptions = {},
): ExportManifestPage {
  const aclAdapter = createCoreStorageAdapter(context, workspaceId);
  const limit = Math.max(1, Math.min(pageSize, MAX_LIST_ROWS));
  const normalizedPrefix = normalizeExportPathPrefix(pathPrefix);
  const entries: ExportManifestEntry[] = [];
  let cursor = afterPath;

  // Sorted queue of runtime files not yet past the afterPath cursor.
  // RUNTIME_FILES is pre-sorted, so we can advance through it in one pass.
  const runtimeQueue: WorkspaceFile[] = RUNTIME_FILES
    .filter((rf) => {
      const path = rf.path;
      if (normalizedPrefix && !path.startsWith(normalizedPrefix + "/") && path !== normalizedPrefix) return false;
      return afterPath === null || path > afterPath;
    })
    .map(runtimeWorkspaceFile);
  let runtimeIdx = 0;

  const appendIfAllowed = (file: WorkspaceFile): boolean => {
    if (
      exportAclAllows(aclAdapter, workspaceId, file.path, claims, aclOptions)
    ) {
      entries.push(file);
    }
    return entries.length >= limit;
  };

  for (;;) {
    const rows = context
      .allRows<Row>(
        exportRowsQuery(normalizedPrefix, cursor),
        ...exportBindings(normalizedPrefix, cursor, limit),
      )
      .map((row) => context.toWorkspaceFile(row));

    for (const file of rows) {
      // Insert any runtime files that sort before this DB row
      while (runtimeIdx < runtimeQueue.length && runtimeQueue[runtimeIdx].path < file.path) {
        const rf = runtimeQueue[runtimeIdx++];
        if (appendIfAllowed(rf)) {
          return { entries, nextCursor: rf.path };
        }
      }
      cursor = file.path;
      if (appendIfAllowed(file)) {
        return { entries, nextCursor: cursor };
      }
    }

    if (rows.length < limit) {
      // Drain any remaining runtime files after the last DB row
      while (runtimeIdx < runtimeQueue.length) {
        appendIfAllowed(runtimeQueue[runtimeIdx++]);
      }
      return { entries, nextCursor: null };
    }
  }
}

export async function* iterateWorkspaceFilesForExport(
  context: ExportContextDeps,
  workspaceId: string,
  claims: TokenClaimsLike | null,
  pageSize = EXPORT_FILE_PAGE_SIZE,
  pathPrefix?: string | null,
  aclOptions: PermissionEvaluationOptions = {},
): AsyncGenerator<ExportFileChunk> {
  const aclAdapter = createCoreStorageAdapter(context, workspaceId);
  const normalizedPrefix = normalizeExportPathPrefix(pathPrefix);
  let cursor: string | null = null;
  const limit = Math.max(1, Math.min(pageSize, MAX_LIST_ROWS));
  for (const rf of RUNTIME_FILES) {
    const file = runtimeWorkspaceFile(rf);
    if (
      (!normalizedPrefix || file.path.startsWith(normalizedPrefix + "/") || file.path === normalizedPrefix) &&
      exportAclAllows(aclAdapter, workspaceId, file.path, claims, aclOptions)
    ) {
      yield { file, content: rf.content };
    }
  }

  for (;;) {
    const rows: WorkspaceFile[] = context
      .allRows<Row>(
        exportRowsQuery(normalizedPrefix, cursor),
        ...exportBindings(normalizedPrefix, cursor, limit),
      )
      .map((row: Row) => context.toWorkspaceFile(row));

    if (rows.length === 0) {
      return;
    }

    for (const file of rows) {
      cursor = file.path;
      const allowed = exportAclAllows(
        aclAdapter,
        workspaceId,
        file.path,
        claims,
        aclOptions,
      );
      if (!allowed) {
        continue;
      }
      // Load exactly one body at a time; it goes out of scope (and is
      // eligible for GC) before the next iteration fetches the next one.
      const content: string = await context.loadContent(
        file.contentRef,
        file.encoding,
      );
      yield { file, content };
    }

    if (rows.length < limit) {
      return;
    }
  }
}

export type TokenClaimsLike = CoreTokenClaims;

function exportAclAllows(
  adapter: CoreStorageAdapter,
  workspaceId: string,
  path: string,
  claims: TokenClaimsLike | null,
  aclOptions: PermissionEvaluationOptions = {},
): boolean {
  return filePermissionAllows(
    resolveFilePermissions(adapter, path, true),
    workspaceId,
    claims,
    {
      ...aclOptions,
      action: aclOptions.action ?? "read",
      requestedPath: path,
    },
  );
}

export function toCoreFileRow(
  file: WorkspaceFile,
  contentByPath?: Map<string, CoreContentState>,
): CoreFileRow {
  const loaded = contentByPath?.get(file.path);
  return {
    path: file.path,
    revision: file.revision,
    contentType: file.contentType,
    content: loaded?.content ?? "",
    encoding: loaded?.encoding ?? file.encoding,
    provider: file.provider,
    lastEditedAt: file.updatedAt,
    semantics: coreParseSemantics(file.semanticsJson),
  };
}

export function toCoreEventRow(event: WorkspaceEvent): CoreEventRow {
  return {
    eventId: event.eventId,
    type: event.type,
    path: event.path,
    revision: event.revision,
    origin: event.origin,
    provider: event.provider ?? "",
    correlationId: event.correlationId,
    timestamp: event.timestamp,
  };
}

export function toCoreOperationRow(op: WorkspaceOperation): CoreOperationRow {
  return {
    opId: op.opId,
    path: op.path,
    revision: op.revision,
    action: op.action,
    provider: op.provider,
    status: op.status,
    attemptCount: op.attemptCount,
    lastError: op.lastError,
    nextAttemptAt: op.nextAttemptAt,
    correlationId: op.correlationId,
  };
}

export function toOperationStatusResponse(
  op: WorkspaceOperation,
  providerResult?: Record<string, unknown>,
): OperationStatusResponse {
  return {
    opId: op.opId,
    path: op.path || undefined,
    revision: op.revision || undefined,
    action: op.action as OperationStatusResponse["action"],
    provider: op.provider || undefined,
    status: op.status === "dispatched" ? "running" : op.status,
    attemptCount: op.attemptCount,
    nextAttemptAt: op.nextAttemptAt,
    lastError: op.lastError,
    providerResult,
    correlationId: op.correlationId || undefined,
  };
}

function normalizeProvider(provider?: string): string {
  return provider?.trim().toLowerCase() ?? "";
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : "/";
}
