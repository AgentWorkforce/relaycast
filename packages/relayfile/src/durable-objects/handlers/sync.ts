import {
  applyWebhookEnvelope as coreApplyWebhookEnvelope,
  normalizeEnvelopeEvent as coreNormalizeEnvelopeEvent,
  normalizeEnvelopePath as coreNormalizeEnvelopePath,
  normalizeSemantics as coreNormalizeSemantics,
  type EnvelopeRow as CoreEnvelopeRow,
  type EventRow as CoreEventRow,
  type FileRow as CoreFileRow,
  type StorageAdapter as CoreStorageAdapter,
} from "@relayfile/core";
import type {
  AckResponse,
  DeadLetterFeedResponse,
  QueuedResponse,
  SyncStatusResponse,
} from "@relayfile/sdk";
import type { Bindings } from "../../env.js";
import type {
  DeadLetterItem,
  IngressStatusResponse,
  ProviderIngressStatus,
  SyncProviderStatus,
  WebhookEnvelopeRequest,
  WorkspaceFile,
} from "../../types.js";
import { base64DecodedSize, hashContent } from "../content-hash.js";
// Digest regeneration is deferred to the DO alarm; see the
// `scheduleDigestRefresh` field on `SyncHandlerContext` below and cloud#846.

type Row = Record<string, unknown>;
type JsonRecord = Record<string, unknown>;

type WorkspaceIdBody = {
  workspaceId?: string;
};

type SyncRefreshRequest = {
  provider: string;
  reason?: string;
};

type LinearFlatIndexConfig = {
  resourcePath: string;
  indexPath: string;
  titleKeys: readonly string[];
};

const LINEAR_FLAT_INDEX_REFRESHES: readonly LinearFlatIndexConfig[] = [
  {
    resourcePath: "/linear/teams",
    indexPath: "/linear/teams/_index.json",
    titleKeys: ["name", "key"],
  },
  {
    resourcePath: "/linear/projects",
    indexPath: "/linear/projects/_index.json",
    titleKeys: ["name"],
  },
];

type WebhookHealthRequest = {
  provider?: string;
  healthy?: boolean;
  eventAt?: string;
  error?: string | null;
};

type GenericWebhookRequest = {
  provider?: string;
  event_type?: string;
  path?: string;
  data?: JsonRecord;
  delivery_id?: string;
  timestamp?: string;
  headers?: Record<string, string>;
};

export type EnvelopeMessage = {
  envelopeId: string;
  workspaceId: string;
  provider: string;
  deliveryId: string;
  receivedAt: string;
  correlationId: string;
  headers: Record<string, string>;
  payload: JsonRecord;
};

type StoredEnvelopeRow = {
  envelope_id: string;
  workspace_id: string;
  provider: string;
  delivery_id: string;
  received_at: string;
  correlation_id: string;
  headers_json: string;
  payload_json: string;
  status: string;
  replay_count: number;
  last_error: string | null;
};

type IngressMetadata = {
  acceptedTotal: number;
  droppedTotal: number;
  dedupedTotal: number;
  coalescedTotal: number;
  pendingTotal: number;
  oldestPendingSince?: string | null;
  suppressedTotal: number;
  staleTotal: number;
  providers: Record<
    string,
    ProviderIngressStatus & { oldestPendingSince?: string | null }
  >;
};

type WorkspaceStatsSnapshot = {
  providerStatus: Record<string, SyncProviderStatus>;
};

type SqlStorageLike = {
  exec(query: string, ...bindings: unknown[]): unknown;
};

const VALID_EVENT_TYPES = new Set([
  "file.created",
  "file.updated",
  "file.deleted",
  "dir.created",
  "dir.deleted",
  "sync.error",
  "sync.ignored",
  "sync.suppressed",
  "sync.stale",
  "writeback.failed",
  "writeback.succeeded",
]);
const MAX_WEBHOOK_ALIAS_SCAN_ROWS = 10_000;

const ERRORS = {
  invalidInput: {
    status: 400,
    code: "invalid_input",
    message: "invalid input",
  },
  notFound: { status: 404, code: "not_found", message: "not found" },
  duplicateEnvelope: {
    status: 409,
    code: "duplicate_envelope",
    message: "duplicate envelope",
  },
} as const;

export interface SyncHandlerContext {
  bindings: Pick<
    Bindings,
    "CONTENT_BUCKET" | "ENVELOPE_QUEUE" | "RELAYFILE_DIGEST_TIMEZONE"
  >;
  sql: SqlStorageLike;
  allRows<T extends Row = Row>(query: string, ...bindings: unknown[]): T[];
  sqlExec(query: string, ...bindings: unknown[]): void;
  readJson<T>(request: Request): Promise<T>;
  requireWorkspaceId(request: Request): Promise<string>;
  resolveWorkspaceId(
    request: Request,
    body?: WorkspaceIdBody,
  ): Promise<string | null>;
  correlationId(request: Request): string;
  json(payload: unknown, status?: number, headers?: HeadersInit): Response;
  errorResponse(
    request: Request,
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ): Response;
  d1Run(query: string, ...bindings: unknown[]): Promise<void>;
  d1First<T extends Row>(
    query: string,
    ...bindings: unknown[]
  ): Promise<T | null>;
  d1All<T extends Row>(query: string, ...bindings: unknown[]): Promise<T[]>;
  ensureWorkspaceStats(workspaceId: string): Promise<void>;
  loadWorkspaceStats(workspaceId: string): Promise<WorkspaceStatsSnapshot>;
  buildSyncProviders(
    workspaceId: string,
    providerStatus: Record<string, SyncProviderStatus>,
    providerFilter?: string,
  ): Promise<SyncProviderStatus[]>;
  buildIngressStatus(
    workspaceId: string,
    providerFilter?: string,
  ): Promise<IngressStatusResponse>;
  bumpIngressMetric(
    workspaceId: string,
    provider: string,
    update: (current: IngressMetadata) => IngressMetadata,
    lastIngestedAt?: string,
  ): Promise<void>;
  updateProviderStatus(
    workspaceId: string,
    provider: string,
    updater: (current: SyncProviderStatus) => SyncProviderStatus,
  ): Promise<void>;
  syncWorkspaceStats(
    workspaceId: string,
    overrides?: {
      lastIngestedAt?: string | null;
      lastEventAt?: string | null;
      lastWritebackAt?: string | null;
      lastActivity?: string | null;
    },
  ): Promise<void>;
  touchWorkspaceWriteStats(
    workspaceId: string,
    overrides?: {
      lastIngestedAt?: string | null;
      lastEventAt?: string | null;
      lastWritebackAt?: string | null;
      lastActivity?: string | null;
      fileCountDelta?: number;
      bytesStoredDelta?: number;
      operationCountDelta?: number;
    },
  ): Promise<void>;
  nextId(prefix: "rev" | "evt" | "op"): string;
  getFileRow(path: string): WorkspaceFile | null;
  toCoreFileRow(file: WorkspaceFile): CoreFileRow;
  contentRef(workspaceId: string, path: string, revision: string): string;
  loadContent(
    contentRef: string,
    encoding: "utf-8" | "base64",
  ): Promise<string>;
  putObject(
    contentRef: string,
    content: string,
    encoding: "utf-8" | "base64",
    contentType: string,
    workspaceId: string,
    path: string,
    revision: string,
  ): Promise<void>;
  deleteContent(contentRef: string): void;
  insertEvent(
    event: {
      eventId: string;
      type: string;
      path: string;
      revision: string;
      origin: string;
      provider?: string;
      correlationId?: string;
      timestamp: string;
    },
    options?: { broadcast?: boolean },
  ): void;
  broadcastEvent(event: {
    eventId: string;
    type: string;
    path: string;
    revision: string;
    origin: string;
    provider?: string;
    correlationId?: string;
    timestamp: string;
  }): void;
  /**
   * Force pending DO SQL writes durable. Call BEFORE any non-transactional
   * side effect (R2 putObject, WS broadcast) so a later throw cannot rewind
   * the rev counter / files row out from under content the daemon already
   * received.
   */
  flushStorage(): Promise<void>;
  /**
   * Schedule a debounced digest regeneration on the DO alarm instead of
   * running it synchronously on the sync apply-envelope path. See
   * `WorkspaceFsContext.scheduleDigestRefresh` and cloud#846 — inlining the
   * refresh here silently dropped provider-sync writes whenever a workspace
   * had enough history to push the refresh past the request budget.
   */
  scheduleDigestRefresh(options: {
    changedPaths: readonly string[];
    generatedAt: Date;
    correlationId: string;
  }): Promise<void>;
}

export async function handleSyncStatus(
  context: SyncHandlerContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const providerFilter =
    new URL(request.url).searchParams.get("provider") ?? undefined;
  const stats = await context.loadWorkspaceStats(workspaceId);
  const providers = await context.buildSyncProviders(
    workspaceId,
    stats.providerStatus,
    providerFilter,
  );

  return context.json({
    workspaceId,
    providers,
  } satisfies SyncStatusResponse);
}

export async function handleSyncIngress(
  context: SyncHandlerContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const providerFilter =
    new URL(request.url).searchParams.get("provider") ?? undefined;
  const status = await context.buildIngressStatus(workspaceId, providerFilter);
  return context.json(status);
}

export async function handleSyncWebhookHealth(
  context: SyncHandlerContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const body = await context.readJson<WebhookHealthRequest>(request);
  const provider = normalizeProvider(body.provider);
  if (!provider) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing provider",
    );
  }
  if (typeof body.healthy !== "boolean") {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "healthy must be a boolean",
    );
  }
  const healthy = body.healthy;

  const eventAt =
    typeof body.eventAt === "string" && body.eventAt.trim()
      ? body.eventAt.trim()
      : new Date().toISOString();
  const errorMessage =
    typeof body.error === "string" && body.error.trim()
      ? body.error.trim()
      : healthy
        ? null
        : "Webhook delivery failed";

  let responseWebhookHealthy = healthy;
  let responseWebhookLastEventAt: string | null = eventAt;
  let responseWebhookLastError: string | null = errorMessage;
  await context.updateProviderStatus(workspaceId, provider, (current) => {
    const currentEventMs = current.webhookLastEventAt
      ? Date.parse(current.webhookLastEventAt)
      : Number.NaN;
    const incomingEventMs = Date.parse(eventAt);
    if (
      Number.isFinite(currentEventMs) &&
      Number.isFinite(incomingEventMs) &&
      incomingEventMs <= currentEventMs
    ) {
      responseWebhookHealthy = current.webhookHealthy ?? healthy;
      responseWebhookLastEventAt = current.webhookLastEventAt ?? eventAt;
      responseWebhookLastError = current.webhookLastError ?? null;
      return current;
    }

    const failureMatchesCurrent =
      current.lastError &&
      current.webhookLastError &&
      current.lastError === current.webhookLastError;
    const nextStatus: SyncProviderStatus = {
      ...current,
      provider,
      status: healthy
        ? failureMatchesCurrent
          ? "lagging"
          : current.status
        : "error",
      lastError: healthy
        ? failureMatchesCurrent
          ? null
          : current.lastError
        : errorMessage,
      webhookHealthy: healthy,
      webhookLastEventAt: eventAt,
      webhookLastError: errorMessage,
    };
    responseWebhookHealthy = nextStatus.webhookHealthy ?? healthy;
    responseWebhookLastEventAt = nextStatus.webhookLastEventAt ?? eventAt;
    responseWebhookLastError = nextStatus.webhookLastError ?? null;
    return nextStatus;
  });

  return context.json(
    {
      workspaceId,
      provider,
      webhookHealthy: responseWebhookHealthy,
      webhookLastEventAt: responseWebhookLastEventAt,
      webhookLastError: responseWebhookLastError,
    },
    202,
  );
}

export async function handleListDeadLetters(
  context: SyncHandlerContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const url = new URL(request.url);
  const provider = normalizeProvider(
    url.searchParams.get("provider") ?? undefined,
  );
  const cursor = url.searchParams.get("cursor");
  const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);

  let rows = await context.d1All<Row>(
    `
      SELECT envelope_id, workspace_id, provider, delivery_id, correlation_id, attempt_count, last_error, failed_at
      FROM dead_letters
      WHERE workspace_id = ?
      ORDER BY failed_at DESC, envelope_id DESC
    `,
    workspaceId,
  );

  if (provider) {
    rows = rows.filter(
      (row) => normalizeProvider(asString(row.provider)) === provider,
    );
  }

  let items = rows.map((row) => toDeadLetterItem(row));
  if (cursor) {
    const index = items.findIndex((item) => item.envelopeId === cursor);
    if (index >= 0) {
      items = items.slice(index + 1);
    }
  }

  const slice = items.slice(0, limit);
  return context.json({
    items: slice,
    nextCursor:
      items.length > slice.length
        ? (slice[slice.length - 1]?.envelopeId ?? null)
        : null,
  } satisfies DeadLetterFeedResponse);
}

export async function handleGetDeadLetter(
  context: SyncHandlerContext,
  request: Request,
  envelopeId: string,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const row = await context.d1First<Row>(
    `
      SELECT envelope_id, workspace_id, provider, delivery_id, correlation_id, attempt_count, last_error, failed_at
      FROM dead_letters
      WHERE workspace_id = ? AND envelope_id = ?
    `,
    workspaceId,
    envelopeId,
  );
  if (!row) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  return context.json(toDeadLetterItem(row));
}

export async function handleReplayDeadLetter(
  context: SyncHandlerContext,
  request: Request,
  envelopeId: string,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const row = await context.d1First<StoredEnvelopeRow>(
    `
      SELECT envelope_id, workspace_id, provider, delivery_id, received_at, correlation_id, headers_json, payload_json, status, replay_count, last_error
      FROM webhook_envelopes
      WHERE envelope_id = ? AND workspace_id = ?
    `,
    envelopeId,
    workspaceId,
  );
  if (!row) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  const envelope = storedEnvelopeToMessage(row);
  await context.bindings.ENVELOPE_QUEUE.send(envelope);
  await context.d1Run(
    `
      UPDATE webhook_envelopes
      SET status = 'replayed',
          replay_count = replay_count + 1,
          updated_at = ?
      WHERE envelope_id = ?
    `,
    new Date().toISOString(),
    envelopeId,
  );

  return context.json(
    {
      status: "queued",
      id: envelopeId,
      correlationId: context.correlationId(request),
    } satisfies QueuedResponse,
    202,
  );
}

export async function handleAckDeadLetter(
  context: SyncHandlerContext,
  request: Request,
  envelopeId: string,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const existing = await context.d1First<Row>(
    "SELECT envelope_id FROM dead_letters WHERE workspace_id = ? AND envelope_id = ?",
    workspaceId,
    envelopeId,
  );
  if (!existing) {
    return context.errorResponse(
      request,
      ERRORS.notFound.status,
      ERRORS.notFound.code,
      ERRORS.notFound.message,
    );
  }

  await context.d1Run(
    "DELETE FROM dead_letters WHERE workspace_id = ? AND envelope_id = ?",
    workspaceId,
    envelopeId,
  );
  await context.syncWorkspaceStats(workspaceId);

  return context.json({
    status: "acknowledged",
    id: envelopeId,
    correlationId: context.correlationId(request),
  } satisfies AckResponse);
}

export async function handleSyncRefresh(
  context: SyncHandlerContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const body = await context.readJson<SyncRefreshRequest>(request);
  const provider = normalizeProvider(body.provider);
  if (!provider) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing provider",
    );
  }

  const refreshId = `refresh_${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await context.d1Run(
    `
      INSERT INTO sync_refresh_jobs (
        id, workspace_id, provider, reason, correlation_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)
    `,
    refreshId,
    workspaceId,
    provider,
    body.reason?.trim() ?? "",
    context.correlationId(request),
    now,
    now,
  );

  await context.updateProviderStatus(workspaceId, provider, (current) => ({
    ...current,
    provider,
    status: current.status === "error" ? "error" : "lagging",
  }));

  if (provider === "linear") {
    try {
      const changedPaths = await refreshLinearFlatIndexes(
        context,
        workspaceId,
        context.correlationId(request),
      );
      const completedAt = new Date().toISOString();
      await context.d1Run(
        `
          UPDATE sync_refresh_jobs
          SET status = 'completed', updated_at = ?
          WHERE id = ?
        `,
        completedAt,
        refreshId,
      );
      await context.updateProviderStatus(workspaceId, provider, (current) => ({
        ...current,
        provider,
        status: current.status === "error" ? "error" : "healthy",
        lagSeconds: 0,
      }));
      if (changedPaths.length > 0) {
        await maybeRefreshWorkspaceDigests(context, workspaceId, {
          changedPaths,
          generatedAt: new Date(completedAt),
          correlationId: context.correlationId(request),
        });
      }
    } catch (error) {
      const failedAt = new Date().toISOString();
      await context.d1Run(
        `
          UPDATE sync_refresh_jobs
          SET status = 'failed', updated_at = ?
          WHERE id = ?
        `,
        failedAt,
        refreshId,
      );
      await context.updateProviderStatus(workspaceId, provider, (current) => ({
        ...current,
        provider,
        status: "error",
        lastError: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  }

  return context.json(
    {
      status: "queued",
      id: refreshId,
      correlationId: context.correlationId(request),
    } satisfies QueuedResponse,
    202,
  );
}

async function refreshLinearFlatIndexes(
  context: SyncHandlerContext,
  workspaceId: string,
  correlationId: string,
): Promise<string[]> {
  const changedPaths: string[] = [];
  for (const config of LINEAR_FLAT_INDEX_REFRESHES) {
    const rows = await buildLinearFlatIndexRows(context, config);
    if (rows.length === 0) {
      continue;
    }
    const content = `${JSON.stringify(rows.sort(compareLinearIndexRows))}\n`;
    const changed = await writeSystemFileIfChanged(context, workspaceId, {
      path: config.indexPath,
      content,
      contentType: "application/json; charset=utf-8",
      provider: "linear",
      correlationId,
    });
    if (changed) {
      changedPaths.push(config.indexPath);
    }
  }
  return changedPaths;
}

async function buildLinearFlatIndexRows(
  context: SyncHandlerContext,
  config: LinearFlatIndexConfig,
): Promise<Array<Record<string, string>>> {
  const candidates = context.allRows<Row>(
    `
      SELECT path
      FROM files
      WHERE path LIKE ?
        AND path <> ?
        AND path NOT LIKE ?
      ORDER BY path ASC
      LIMIT 1000
    `,
    `${config.resourcePath}/%.json`,
    config.indexPath,
    `${config.resourcePath}/by-%`,
  );
  const rows: Array<Record<string, string>> = [];
  for (const candidate of candidates) {
    const path = asString(candidate.path);
    if (!path || !path.endsWith(".json")) {
      continue;
    }
    const file = context.getFileRow(path);
    if (!file) {
      continue;
    }
    const parsed = parseJsonObject(
      await context.loadContent(file.contentRef, file.encoding),
    );
    const record = unwrapProviderPayload(parsed);
    const id = readRecordString(record, "id");
    if (!id) {
      continue;
    }
    rows.push({
      id,
      title: readFirstRecordString(record, config.titleKeys) ?? "",
      updated:
        readFirstRecordString(record, [
          "updatedAt",
          "updated_at",
          "createdAt",
          "created_at",
        ]) ??
        file.updatedAt ??
        "",
    });
  }
  return rows;
}

export async function writeSystemFileIfChanged(
  context: SyncHandlerContext,
  workspaceId: string,
  input: {
    path: string;
    content: string;
    contentType: string;
    provider: string;
    correlationId: string;
  },
): Promise<boolean> {
  const existing = context.getFileRow(input.path);
  if (existing) {
    const existingContent = await context.loadContent(
      existing.contentRef,
      existing.encoding,
    );
    if (existingContent === input.content) {
      return false;
    }
  }

  const revision = context.nextId("rev");
  const contentRef = context.contentRef(workspaceId, input.path, revision);
  const encoding = "utf-8" as const;
  const timestamp = new Date().toISOString();
  const contentHash = await hashContent(input.content, encoding);

  await context.flushStorage();
  await context.putObject(
    contentRef,
    input.content,
    encoding,
    input.contentType,
    workspaceId,
    input.path,
    revision,
  );
  context.sqlExec(
    `
      INSERT INTO files (
        path, revision, content_type, content_ref, size, encoding, updated_at,
        semantics_json, provider, provider_object_id, content_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        revision = excluded.revision,
        content_type = excluded.content_type,
        content_ref = excluded.content_ref,
        size = excluded.size,
        encoding = excluded.encoding,
        updated_at = excluded.updated_at,
        semantics_json = excluded.semantics_json,
        provider = excluded.provider,
        provider_object_id = excluded.provider_object_id,
        content_hash = excluded.content_hash
    `,
    input.path,
    revision,
    input.contentType,
    contentRef,
    encodedSize(input.content, encoding),
    encoding,
    timestamp,
    "{}",
    input.provider,
    "",
    contentHash,
  );
  const event = {
    eventId: context.nextId("evt"),
    type: existing ? "file.updated" : "file.created",
    path: input.path,
    revision,
    origin: "system",
    provider: input.provider,
    correlationId: input.correlationId,
    timestamp,
  };
  context.insertEvent(event, { broadcast: false });
  await context.flushStorage();
  context.broadcastEvent(event);
  return true;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function unwrapProviderPayload(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const payload = record.payload;
  return isJsonRecord(payload) ? payload : record;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareLinearIndexRows(
  left: Record<string, string>,
  right: Record<string, string>,
): number {
  if (left.updated !== right.updated) {
    return right.updated.localeCompare(left.updated);
  }
  return left.id.localeCompare(right.id);
}

function readFirstRecordString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = readRecordString(record, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function readRecordString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export async function handleInternalWebhookEnvelope(
  context: SyncHandlerContext,
  request: Request,
): Promise<Response> {
  const envelope = await context.readJson<WebhookEnvelopeRequest>(request);
  if (
    !envelope.workspaceId?.trim() ||
    !envelope.envelopeId?.trim() ||
    !envelope.provider?.trim()
  ) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing envelope fields",
    );
  }
  if (
    !envelope.deliveryId?.trim() ||
    !envelope.receivedAt?.trim() ||
    !envelope.correlationId?.trim()
  ) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "missing envelope metadata",
    );
  }

  return storeEnvelopeAndQueue(context, request, {
    envelopeId: envelope.envelopeId,
    workspaceId: envelope.workspaceId.trim(),
    provider: normalizeProvider(envelope.provider),
    deliveryId: envelope.deliveryId.trim(),
    receivedAt: envelope.receivedAt.trim(),
    correlationId: envelope.correlationId.trim(),
    headers: normalizeHeaderMap(envelope.headers),
    payload: asRecord(envelope.payload),
  });
}

export async function handleGenericWebhook(
  context: SyncHandlerContext,
  request: Request,
): Promise<Response> {
  const workspaceId = await context.requireWorkspaceId(request);
  const body = await context.readJson<GenericWebhookRequest>(request);
  const provider = normalizeProvider(body.provider);
  const eventType = normalizeEventType(body.event_type);
  const path = normalizePath(body.path ?? "");

  if (!provider || !eventType || !body.path?.trim()) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "provider, event_type, and path are required",
    );
  }

  const envelopeId = `env_${crypto.randomUUID()}`;
  const receivedAt =
    normalizeIsoDate(body.timestamp) ?? new Date().toISOString();
  const deliveryId = body.delivery_id?.trim() || envelopeId;
  const correlationId = context.correlationId(request);

  return storeEnvelopeAndQueue(context, request, {
    envelopeId,
    workspaceId,
    provider,
    deliveryId,
    receivedAt,
    correlationId,
    headers: normalizeHeaderMap(body.headers),
    payload: {
      provider,
      event_type: eventType,
      path,
      timestamp: receivedAt,
      data: asRecord(body.data),
      delivery_id: deliveryId,
    },
  });
}

export async function handleProcessEnvelope(
  context: SyncHandlerContext,
  request: Request,
): Promise<Response> {
  const envelope = await context.readJson<EnvelopeMessage>(request);
  if (
    !envelope.workspaceId?.trim() ||
    !envelope.envelopeId?.trim() ||
    !envelope.provider?.trim()
  ) {
    return context.errorResponse(
      request,
      ERRORS.invalidInput.status,
      ERRORS.invalidInput.code,
      "invalid envelope",
    );
  }

  await context.resolveWorkspaceId(request, {
    workspaceId: envelope.workspaceId,
  });

  try {
    await applyEnvelope(context, envelope);
    await context.d1Run(
      `
        UPDATE webhook_envelopes
        SET status = 'processed',
            last_error = NULL,
            updated_at = ?
        WHERE envelope_id = ?
      `,
      new Date().toISOString(),
      envelope.envelopeId,
    );
    await onEnvelopeProcessed(context, envelope.workspaceId, envelope.provider);

    return context.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "failed to process envelope";
    await deadLetterEnvelope(context, envelope, message);
    return context.json({ ok: true, deadLettered: true });
  }
}

export async function storeEnvelopeAndQueue(
  context: SyncHandlerContext,
  request: Request,
  envelope: EnvelopeMessage,
): Promise<Response> {
  await context.ensureWorkspaceStats(envelope.workspaceId);

  const existing = await context.d1First<Row>(
    "SELECT envelope_id FROM webhook_envelopes WHERE envelope_id = ?",
    envelope.envelopeId,
  );
  if (existing) {
    await context.bumpIngressMetric(
      envelope.workspaceId,
      envelope.provider,
      (current) =>
        incrementIngressMetric(current, envelope.provider, "deduped"),
    );
    return context.errorResponse(
      request,
      ERRORS.duplicateEnvelope.status,
      ERRORS.duplicateEnvelope.code,
      ERRORS.duplicateEnvelope.message,
    );
  }

  const now = new Date().toISOString();
  await context.d1Run(
    `
      INSERT INTO webhook_envelopes (
        envelope_id,
        workspace_id,
        provider,
        delivery_id,
        received_at,
        correlation_id,
        headers_json,
        payload_json,
        status,
        replay_count,
        last_error,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, ?, ?)
    `,
    envelope.envelopeId,
    envelope.workspaceId,
    envelope.provider,
    envelope.deliveryId,
    envelope.receivedAt,
    envelope.correlationId,
    JSON.stringify(envelope.headers),
    JSON.stringify(envelope.payload),
    now,
    now,
  );

  await context.bindings.ENVELOPE_QUEUE.send(envelope);
  try {
    await context.updateProviderStatus(
      envelope.workspaceId,
      envelope.provider,
      (current) => ({
        ...current,
        provider: envelope.provider,
        webhookHealthy: true,
        webhookLastEventAt: envelope.receivedAt,
        webhookLastError: null,
      }),
    );
  } catch (err) {
    console.error("storeEnvelopeAndQueue: updateProviderStatus failed", err);
  }
  await context.bumpIngressMetric(
    envelope.workspaceId,
    envelope.provider,
    (current) =>
      incrementIngressMetric(
        current,
        envelope.provider,
        "accepted",
        envelope.receivedAt,
      ),
    envelope.receivedAt,
  );

  return context.json(
    {
      status: "queued",
      id: envelope.envelopeId,
      correlationId: envelope.correlationId,
    } satisfies QueuedResponse,
    202,
  );
}

export async function applyEnvelope(
  context: SyncHandlerContext,
  envelope: EnvelopeMessage,
): Promise<void> {
  const normalizedEvent = coreNormalizeEnvelopeEvent(envelope);
  if (!normalizedEvent) {
    if (coreNormalizeEnvelopePath(envelope) === null) {
      return;
    }
    throw new Error("unsupported envelope payload");
  }

  const workspaceId = envelope.workspaceId;
  const provider = envelope.provider;
  const correlationId = envelope.correlationId ?? "";
  const staged: {
    file: CoreFileRow | null;
    deletedPath: string | null;
    events: CoreEventRow[];
  } = {
    file: null,
    deletedPath: null,
    events: [],
  };

  const stagingAdapter: CoreStorageAdapter = {
    getFile: (path) => {
      const normalizedPath = normalizePath(path);
      if (staged.deletedPath === normalizedPath) {
        return null;
      }
      if (staged.file?.path === normalizedPath) {
        return staged.file;
      }

      const existing = context.getFileRow(normalizedPath);
      return existing ? context.toCoreFileRow(existing) : null;
    },
    listFiles: () => {
      const files = listWebhookAliasCandidateFiles(context);
      if (staged.file) {
        files.push(staged.file);
      }
      return files;
    },
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

  const result = coreApplyWebhookEnvelope(
    stagingAdapter,
    {
      envelopeId: envelope.envelopeId,
      workspaceId,
      provider,
      deliveryId: envelope.deliveryId,
      deliveryIds: [envelope.deliveryId],
      receivedAt: envelope.receivedAt,
      headers: envelope.headers,
      payload: envelope.payload,
      correlationId,
      status: "queued",
      attemptCount: 0,
      lastError: null,
    } satisfies CoreEnvelopeRow,
    {
      isPathWriteAllowed: isProviderSyncPathAllowed,
      isStale: (_row, event) => isOlderThanCurrentFile(context, event),
    },
  );

  // Order is load-bearing — see PR description (rev_96 hash divergence) and
  // PR #460 review (Codex P1: don't commit files row before R2 succeeds).
  //
  // The DO request handler runs in an implicit transaction: SQL writes are
  // staged and only committed at request end. R2 putObject and WS broadcast
  // are NOT transactional. Two failure modes to defend against:
  //
  //   1. A later throw (e.g. "Durable Object overloaded" from a stats write)
  //      rolls back the rev counter / files row AFTER R2 + broadcast already
  //      happened — daemon receives a rev that cloud later forgets.
  //   2. R2 put fails AFTER the files row is already durable — readers see
  //      the new revision but loadContent returns "" for the missing object.
  //
  // Sequence to satisfy both:
  //   a. coreApplyWebhookEnvelope above already incremented the rev counter
  //      (writes to the `meta` SQL table). Flush now to BURN the revision —
  //      a later rollback can't reuse it.
  //   b. putObject to R2. If this throws, we leak the rev counter (fine —
  //      it's monotonic) and the files row was never INSERTed.
  //   c. INSERT files row (with monotonic guard) + event rows.
  //   d. Flush again to commit files + events durably.
  //   e. Broadcast — daemons fetching content find it in R2.
  let pendingR2Put: {
    contentRef: string;
    content: string;
    encoding: "utf-8" | "base64";
    contentType: string;
    path: string;
    revision: string;
  } | null = null;
  let pendingFileInsert: {
    path: string;
    revision: string;
    contentType: string;
    contentRef: string;
    size: number;
    encoding: "utf-8" | "base64";
    lastEditedAt: string;
    semanticsJson: string;
    provider: string;
    providerObjectId: string;
    contentHash: string;
  } | null = null;
  let staleContentRefToDelete: string | null = null;
  let pendingDeletePath: string | null = null;
  let pendingDeleteRevision: string | null = null;
  let pendingDeleteContentRef: string | null = null;
  let pendingWritePreviousSize: number | null = null;
  let pendingWriteWasCreate = false;
  let pendingDeleteSize: number | null = null;
  let ignoredStaleDeletePath: string | null = null;
  let ignoredStaleWritePath: string | null = null;

  if (staged.file) {
    const existing = context.getFileRow(staged.file.path);
    pendingWritePreviousSize = existing?.size ?? null;
    pendingWriteWasCreate = !existing;
    const contentRef = context.contentRef(
      workspaceId,
      staged.file.path,
      staged.file.revision,
    );
    const encoding = normalizeEncoding(staged.file.encoding) ?? "utf-8";
    // SHA-256 hex of the staged file's bytes — must match what the daemon
    // computes via hashBytes in internal/mountsync/syncer.go. Persisted on
    // the files row so /fs/file, /fs/tree, /fs/events surface it for the
    // PR #90 cross-check.
    const contentHash = await hashContent(staged.file.content, encoding);

    pendingFileInsert = {
      path: staged.file.path,
      revision: staged.file.revision,
      contentType: staged.file.contentType,
      contentRef,
      size: encodedSize(staged.file.content, encoding),
      encoding,
      lastEditedAt: staged.file.lastEditedAt,
      semanticsJson: JSON.stringify(
        coreNormalizeSemantics(staged.file.semantics),
      ),
      provider,
      providerObjectId: existing?.providerObjectId ?? "",
      contentHash,
    };

    pendingR2Put = {
      contentRef,
      content: staged.file.content,
      encoding,
      contentType: staged.file.contentType,
      path: staged.file.path,
      revision: staged.file.revision,
    };
    // Keep prior revision content in R2. Digest rendering dereferences event
    // revisions, so deleting old content here can erase terminal-state wording
    // after a later same-day update.
  } else if (staged.deletedPath) {
    const existing = context.getFileRow(staged.deletedPath);
    if (existing) {
      if (existing.contentRef) {
        pendingDeleteContentRef = existing.contentRef;
      }
      pendingDeleteSize = existing.size;
    }
    pendingDeleteRevision =
      [...staged.events]
        .reverse()
        .find(
          (event) =>
            event.type === "file.deleted" &&
            normalizePath(event.path) === staged.deletedPath,
        )?.revision ?? null;
    pendingDeletePath = staged.deletedPath;
  }

  // Step (a): burn the revision counter durably so a rollback cannot rewind
  // it and cause a future write to reuse the same rev_N with different bytes.
  // The counter increment lives in the `meta` table inside the implicit DO
  // transaction, so flushStorage commits it before we do any side effect.
  await context.flushStorage();

  // Step (b): put R2 content BEFORE the files row is INSERTed so a put
  // failure leaves cloud's view of the file untouched (no row pointing at a
  // missing object). On success, the contentRef is durable in R2.
  if (pendingR2Put) {
    await context.putObject(
      pendingR2Put.contentRef,
      pendingR2Put.content,
      pendingR2Put.encoding,
      pendingR2Put.contentType,
      workspaceId,
      pendingR2Put.path,
      pendingR2Put.revision,
    );
  }

  // Step (c): now INSERT files row + event rows. If the put above already
  // succeeded, readers of the new revision will find content in R2.
  if (pendingFileInsert) {
    // Monotonic guard: if a concurrent envelope on the same path already
    // committed a NEWER revision, drop this older write rather than letting
    // ON CONFLICT blindly take excluded.revision and clobber the newer row.
    // Compare the numeric suffix of the rev id, NOT the TEXT — `nextId`
    // emits unpadded ids like rev_9 / rev_10, so lexicographic comparison
    // (rev_10 > rev_9) evaluates false. SUBSTR(..., 5) skips the literal
    // `rev_` prefix; CAST AS INTEGER coerces the numeric suffix.
    context.sql.exec(
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
      pendingFileInsert.path,
      pendingFileInsert.revision,
      pendingFileInsert.contentType,
      pendingFileInsert.contentRef,
      pendingFileInsert.size,
      pendingFileInsert.encoding,
      pendingFileInsert.lastEditedAt,
      pendingFileInsert.semanticsJson,
      pendingFileInsert.provider,
      pendingFileInsert.providerObjectId,
      pendingFileInsert.contentHash,
    );
    const applied = context.getFileRow(pendingFileInsert.path);
    if (
      applied?.revision !== pendingFileInsert.revision ||
      applied.contentRef !== pendingFileInsert.contentRef
    ) {
      ignoredStaleWritePath = pendingFileInsert.path;
      staleContentRefToDelete = pendingFileInsert.contentRef;
    }
  } else if (pendingDeletePath) {
    context.sql.exec(
      `
        DELETE FROM files
        WHERE path = ?
          AND CAST(SUBSTR(?, 5) AS INTEGER) > CAST(SUBSTR(revision, 5) AS INTEGER)
      `,
      pendingDeletePath,
      pendingDeleteRevision ?? "rev_0",
    );
    const remaining = context.getFileRow(pendingDeletePath);
    if (remaining) {
      ignoredStaleDeletePath = pendingDeletePath;
    } else if (pendingDeleteContentRef) {
      staleContentRefToDelete = pendingDeleteContentRef;
    }
  }

  const eventsWithAppliedPaths = staged.events.map((event): CoreEventRow => {
    if (
      pendingFileInsert &&
      (event.type === "file.created" || event.type === "file.updated") &&
      event.revision === pendingFileInsert.revision
    ) {
      return { ...event, path: pendingFileInsert.path };
    }
    if (
      pendingDeletePath &&
      event.type === "file.deleted" &&
      event.revision === pendingDeleteRevision
    ) {
      return { ...event, path: pendingDeletePath };
    }
    return event;
  });

  const committedEvents = eventsWithAppliedPaths.filter((event) => {
    const normalizedEventPath = normalizePath(event.path);
    if (
      ignoredStaleDeletePath &&
      event.type === "file.deleted" &&
      normalizedEventPath === ignoredStaleDeletePath
    ) {
      return false;
    }
    if (
      ignoredStaleWritePath &&
      (event.type === "file.created" || event.type === "file.updated") &&
      normalizedEventPath === ignoredStaleWritePath
    ) {
      return false;
    }
    return true;
  });

  // Insert event rows into SQL but DO NOT broadcast yet — broadcast must
  // not fire until the rev counter, files row, and event rows are all
  // durably committed.
  for (const event of committedEvents) {
    context.insertEvent(
      {
        eventId: event.eventId,
        type: event.type,
        path: event.path,
        revision: event.revision,
        origin: event.origin,
        provider: event.provider,
        correlationId: event.correlationId,
        timestamp: event.timestamp,
      },
      { broadcast: false },
    );
  }

  // Step (d): durably commit files row + event rows BEFORE broadcast.
  await context.flushStorage();

  if (staleContentRefToDelete) {
    void context.bindings.CONTENT_BUCKET.delete(staleContentRefToDelete);
  }

  // Step (e): now safe to broadcast — SQL is durable and (if any) R2
  // content is in place. Subscribed daemons can re-fetch and find the bytes.
  for (const event of committedEvents) {
    context.broadcastEvent({
      eventId: event.eventId,
      type: event.type,
      path: event.path,
      revision: event.revision,
      origin: event.origin,
      provider: event.provider,
      correlationId: event.correlationId,
      timestamp: event.timestamp,
    });
  }

  await maybeRefreshWorkspaceDigests(context, workspaceId, {
    changedPaths: committedEvents.map((event) => event.path),
    generatedAt: new Date(),
    correlationId,
  });

  const appliedEventType =
    committedEvents[committedEvents.length - 1]?.type ??
    result.eventType ??
    normalizedEvent.type;
  const timestamp =
    committedEvents[committedEvents.length - 1]?.timestamp ??
    normalizedEvent.timestamp ??
    envelope.receivedAt ??
    new Date().toISOString();
  const fileCountDelta =
    pendingFileInsert && !ignoredStaleWritePath && pendingWriteWasCreate
      ? 1
      : pendingDeletePath &&
          !ignoredStaleDeletePath &&
          pendingDeleteSize !== null
        ? -1
        : 0;
  const bytesStoredDelta =
    pendingFileInsert && !ignoredStaleWritePath
      ? pendingFileInsert.size - (pendingWritePreviousSize ?? 0)
      : pendingDeletePath &&
          !ignoredStaleDeletePath &&
          pendingDeleteSize !== null
        ? -pendingDeleteSize
        : 0;

  // Stats writes are observability — they hit other DOs / D1 and can throw
  // "Durable Object overloaded". They MUST NOT roll back the rev counter or
  // files row, so swallow + log instead of letting them reach the request
  // boundary (which would discard the staged SQL transaction). These
  // failures are recoverable: the next envelope's stats write will catch up.
  try {
    await context.updateProviderStatus(workspaceId, provider, (current) => ({
      ...current,
      provider,
      status: appliedEventType === "sync.error" ? "error" : "healthy",
      cursor: envelope.deliveryId,
      watermarkTs: timestamp,
      lagSeconds: 0,
      lastError:
        appliedEventType === "sync.error"
          ? typeof normalizedEvent.data?.error === "string"
            ? normalizedEvent.data.error
            : null
          : null,
      failureCodes: current.failureCodes,
      webhookHealthy: true,
      webhookLastEventAt: timestamp,
      webhookLastError: null,
    }));
  } catch (err) {
    console.error("applyEnvelope: updateProviderStatus failed", err);
  }

  if (appliedEventType === "sync.suppressed") {
    try {
      await context.bumpIngressMetric(workspaceId, provider, (current) =>
        incrementIngressMetric(current, provider, "suppressed"),
      );
    } catch (err) {
      console.error("applyEnvelope: bumpIngressMetric(suppressed) failed", err);
    }
  }
  if (appliedEventType === "sync.stale") {
    try {
      await context.bumpIngressMetric(workspaceId, provider, (current) =>
        incrementIngressMetric(current, provider, "stale"),
      );
    } catch (err) {
      console.error("applyEnvelope: bumpIngressMetric(stale) failed", err);
    }
  }

  try {
    await context.touchWorkspaceWriteStats(workspaceId, {
      fileCountDelta,
      bytesStoredDelta,
      lastEventAt: timestamp,
      lastActivity: timestamp,
    });
  } catch (err) {
    console.error("applyEnvelope: touchWorkspaceWriteStats failed", err);
  }
}

function listWebhookAliasCandidateFiles(
  context: SyncHandlerContext,
): CoreFileRow[] {
  return context
    .allRows<Row>(
      `
        SELECT path, revision, content_type, content_ref, encoding,
               updated_at, semantics_json, provider
        FROM files
        WHERE path >= ? AND path < ?
        ORDER BY path
        LIMIT ?
      `,
      "/slack/channels/",
      "/slack/channels0",
      MAX_WEBHOOK_ALIAS_SCAN_ROWS,
    )
    .map(rowToCoreFileRow)
    .filter((row): row is CoreFileRow => row !== null);
}

function rowToCoreFileRow(row: Row): CoreFileRow | null {
  const path = asString(row.path);
  if (!path) {
    return null;
  }

  return {
    path,
    revision: asString(row.revision) || "",
    contentType: asString(row.content_type) || "application/json",
    content: asString(row.content_ref) || "",
    encoding: asString(row.encoding) || "utf-8",
    provider: asString(row.provider) || "",
    lastEditedAt: asString(row.updated_at) || "",
    semantics: parseSemanticsJson(asString(row.semantics_json)),
  };
}

function parseSemanticsJson(raw: string): CoreFileRow["semantics"] {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? coreNormalizeSemantics(parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function maybeRefreshWorkspaceDigests(
  context: SyncHandlerContext,
  _workspaceId: string,
  options: {
    changedPaths: readonly string[];
    generatedAt: Date;
    correlationId: string;
  },
): Promise<void> {
  // Deferred to the DO alarm — see `SyncHandlerContext.scheduleDigestRefresh`
  // and cloud#846. Inlining the multi-window per-event-R2-read refresh on the
  // sync apply path silently dropped provider writes on busy workspaces (the
  // sync state machine still marked "complete" because no exception was
  // thrown — see the "silent data loss" half of #846).
  try {
    await context.scheduleDigestRefresh(options);
  } catch (err) {
    console.error("maybeRefreshWorkspaceDigests: schedule failed", err);
  }
}

export async function onEnvelopeProcessed(
  context: SyncHandlerContext,
  workspaceId: string,
  provider: string,
): Promise<void> {
  await context.bumpIngressMetric(workspaceId, provider, (current) =>
    decrementPending(current, provider),
  );
}

function isOlderThanCurrentFile(
  context: Pick<SyncHandlerContext, "getFileRow">,
  event: { type: string; path: string; timestamp: string },
): boolean {
  if (
    event.type !== "file.created" &&
    event.type !== "file.updated" &&
    event.type !== "file.deleted"
  ) {
    return false;
  }
  const current = context.getFileRow(normalizePath(event.path));
  if (!current?.updatedAt) {
    return false;
  }
  const eventMs = Date.parse(event.timestamp);
  const currentMs = Date.parse(current.updatedAt);
  return (
    Number.isFinite(eventMs) &&
    Number.isFinite(currentMs) &&
    eventMs < currentMs
  );
}

export async function deadLetterEnvelope(
  context: SyncHandlerContext,
  envelope: EnvelopeMessage,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();

  const existing = await context.d1First<Row>(
    `
      SELECT attempt_count
      FROM dead_letters
      WHERE envelope_id = ? AND workspace_id = ?
    `,
    envelope.envelopeId,
    envelope.workspaceId,
  );
  const nextAttemptCount = Math.max(1, asNumber(existing?.attempt_count) + 1);

  await context.d1Run(
    `
      INSERT INTO dead_letters (
        envelope_id,
        workspace_id,
        provider,
        delivery_id,
        correlation_id,
        headers_json,
        payload_json,
        attempt_count,
        last_error,
        replayable,
        failed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(workspace_id, envelope_id) DO UPDATE SET
        provider = excluded.provider,
        delivery_id = excluded.delivery_id,
        correlation_id = excluded.correlation_id,
        headers_json = excluded.headers_json,
        payload_json = excluded.payload_json,
        attempt_count = excluded.attempt_count,
        last_error = excluded.last_error,
        failed_at = excluded.failed_at
    `,
    envelope.envelopeId,
    envelope.workspaceId,
    envelope.provider,
    envelope.deliveryId,
    envelope.correlationId,
    JSON.stringify(envelope.headers),
    JSON.stringify(envelope.payload),
    nextAttemptCount,
    errorMessage,
    now,
  );

  await context.d1Run(
    `
      UPDATE webhook_envelopes
      SET status = 'dead_lettered',
          last_error = ?,
          updated_at = ?
      WHERE envelope_id = ?
    `,
    errorMessage,
    now,
    envelope.envelopeId,
  );

  await context.bumpIngressMetric(
    envelope.workspaceId,
    envelope.provider,
    (current) => decrementPending(current, envelope.provider),
  );
  await context.updateProviderStatus(
    envelope.workspaceId,
    envelope.provider,
    (current) => ({
      ...current,
      provider: envelope.provider,
      status: "error",
      lastError: errorMessage,
      webhookHealthy: false,
      webhookLastError: errorMessage,
      failureCodes: incrementFailureCode(
        current.failureCodes,
        "process_failed",
      ),
    }),
  );

  const errorPath = coreNormalizeEnvelopePath(envelope) ?? "/";
  context.insertEvent({
    eventId: context.nextId("evt"),
    type: "sync.error",
    path: errorPath,
    revision: context.nextId("rev"),
    origin: "system",
    provider: envelope.provider,
    correlationId: envelope.correlationId,
    timestamp: now,
  });

  await maybeRefreshWorkspaceDigests(context, envelope.workspaceId, {
    changedPaths: [errorPath],
    generatedAt: new Date(now),
    correlationId: envelope.correlationId,
  });

  await context.touchWorkspaceWriteStats(envelope.workspaceId, {
    lastEventAt: now,
    lastActivity: now,
  });
}

export function storedEnvelopeToMessage(
  row: StoredEnvelopeRow,
): EnvelopeMessage {
  return {
    envelopeId: row.envelope_id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    deliveryId: row.delivery_id,
    receivedAt: row.received_at,
    correlationId: row.correlation_id,
    headers:
      (parseJsonRecord(row.headers_json) as Record<string, string>) ?? {},
    payload: parseJsonRecord(row.payload_json) ?? {},
  };
}

function toDeadLetterItem(row: Row): DeadLetterItem {
  return {
    envelopeId: asString(row.envelope_id),
    workspaceId: asString(row.workspace_id),
    provider: asString(row.provider),
    deliveryId: asString(row.delivery_id),
    correlationId: asOptionalString(row.correlation_id),
    failedAt: asString(row.failed_at),
    attemptCount: Math.max(1, asNumber(row.attempt_count)),
    lastError: asString(row.last_error),
  };
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "/";
  }
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.length > 1 ? prefixed.replace(/\/+$/, "") : "/";
}

function isProviderSyncPathAllowed(path: string): boolean {
  const normalizedPath = normalizePath(path);
  return normalizedPath !== "/teams" && !normalizedPath.startsWith("/teams/");
}

function normalizeProvider(provider?: string): string {
  return provider?.trim().toLowerCase() ?? "";
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

function normalizeEventType(value?: string): string | null {
  const type = value?.trim() ?? "";
  return VALID_EVENT_TYPES.has(type) ? type : null;
}

function normalizeHeaderMap(
  headers?: Record<string, string>,
): Record<string, string> {
  if (!headers) {
    return {};
  }
  return Object.entries(headers).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      const normalizedKey = key.trim();
      if (normalizedKey) {
        acc[normalizedKey] = String(value);
      }
      return acc;
    },
    {},
  );
}

function normalizeIsoDate(value?: string | null): string | null {
  if (!value?.trim()) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
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

function incrementIngressMetric(
  current: IngressMetadata,
  provider: string,
  metric: "accepted" | "deduped" | "suppressed" | "stale",
  pendingSince?: string,
): IngressMetadata {
  const next = cloneIngress(current);
  const providerState =
    next.providers[provider] ?? defaultProviderIngressStatus();
  next.providers[provider] = providerState;

  switch (metric) {
    case "accepted":
      next.acceptedTotal += 1;
      next.pendingTotal += 1;
      providerState.acceptedTotal += 1;
      providerState.pendingTotal += 1;
      providerState.oldestPendingSince =
        providerState.oldestPendingSince ??
        pendingSince ??
        new Date().toISOString();
      next.oldestPendingSince =
        next.oldestPendingSince ?? pendingSince ?? new Date().toISOString();
      break;
    case "deduped":
      next.dedupedTotal += 1;
      providerState.dedupedTotal += 1;
      break;
    case "suppressed":
      next.suppressedTotal += 1;
      providerState.suppressedTotal += 1;
      break;
    case "stale":
      next.staleTotal += 1;
      providerState.staleTotal += 1;
      break;
  }

  recomputeIngressRates(next, provider);
  return next;
}

function decrementPending(
  current: IngressMetadata,
  provider: string,
): IngressMetadata {
  const next = cloneIngress(current);
  const providerState =
    next.providers[provider] ?? defaultProviderIngressStatus();
  next.providers[provider] = providerState;

  next.pendingTotal = Math.max(0, next.pendingTotal - 1);
  providerState.pendingTotal = Math.max(0, providerState.pendingTotal - 1);
  if (providerState.pendingTotal === 0) {
    providerState.oldestPendingSince = null;
  }
  if (next.pendingTotal === 0) {
    next.oldestPendingSince = null;
  }
  recomputeIngressRates(next, provider);
  return next;
}

function cloneIngress(current: IngressMetadata): IngressMetadata {
  return {
    ...current,
    providers: Object.fromEntries(
      Object.entries(current.providers).map(([provider, status]) => [
        provider,
        { ...status },
      ]),
    ),
  };
}

function recomputeIngressRates(
  current: IngressMetadata,
  provider: string,
): void {
  current.providers[provider].dedupeRate = ratio(
    current.providers[provider].dedupedTotal,
    current.providers[provider].acceptedTotal,
  );
  current.providers[provider].coalesceRate = ratio(
    current.providers[provider].coalescedTotal,
    current.providers[provider].acceptedTotal,
  );
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}

function defaultProviderIngressStatus(): ProviderIngressStatus & {
  oldestPendingSince?: string | null;
} {
  return {
    acceptedTotal: 0,
    droppedTotal: 0,
    dedupedTotal: 0,
    coalescedTotal: 0,
    pendingTotal: 0,
    oldestPendingAgeSeconds: 0,
    suppressedTotal: 0,
    staleTotal: 0,
    dedupeRate: 0,
    coalesceRate: 0,
    oldestPendingSince: null,
  };
}

function incrementFailureCode(
  current: Record<string, number> | undefined,
  code: string,
): Record<string, number> {
  return {
    ...(current ?? {}),
    [code]: (current?.[code] ?? 0) + 1,
  };
}

function encodedSize(content: string, encoding: "utf-8" | "base64"): number {
  if (encoding === "base64") {
    return base64DecodedSize(content);
  }
  return new TextEncoder().encode(content).byteLength;
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

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}
