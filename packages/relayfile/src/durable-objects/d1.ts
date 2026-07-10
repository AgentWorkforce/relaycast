import { normalizeEnvelopePath as coreNormalizeEnvelopePath } from "@relayfile/core";
import type { FilesystemEvent, OperationStatusResponse } from "@relayfile/sdk";
import type { Bindings } from "../env.js";
import type { SyncProviderStatus, WorkspaceOperation } from "../types.js";

export type Row = Record<string, unknown>;
export type JsonRecord = Record<string, unknown>;
type WorkspaceOperationUpsert = OperationStatusResponse &
  Pick<WorkspaceOperation, "updatedAt" | "completedAt">;

export interface EnvelopeMessage {
  envelopeId: string;
  workspaceId: string;
  provider: string;
  deliveryId: string;
  receivedAt: string;
  correlationId: string;
  headers: Record<string, string>;
  payload: JsonRecord;
}

export interface StoredEnvelopeRow {
  [key: string]: unknown;
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
}

export interface D1Context {
  bindings: Bindings;
}

export interface DeadLetterEnvelopeContext {
  d1First<T extends Row>(
    query: string,
    ...bindings: unknown[]
  ): Promise<T | null>;
  d1Run(query: string, ...bindings: unknown[]): Promise<void>;
  bumpIngressMetric(
    workspaceId: string,
    provider: string,
    update: (current: IngressState) => IngressState,
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
  insertEvent(event: FilesystemEvent): void;
  nextId(prefix: "evt" | "rev"): string;
}

type IngressState = {
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
    {
      acceptedTotal: number;
      droppedTotal: number;
      dedupedTotal: number;
      coalescedTotal: number;
      pendingTotal: number;
      oldestPendingAgeSeconds: number;
      suppressedTotal: number;
      staleTotal: number;
      dedupeRate: number;
      coalesceRate: number;
      oldestPendingSince?: string | null;
    }
  >;
};

export async function d1Run(
  ctx: D1Context,
  query: string,
  ...bindings: unknown[]
): Promise<void> {
  await ctx.bindings.DB.prepare(query)
    .bind(...bindings)
    .run();
}

export async function d1First<T extends Row>(
  ctx: D1Context,
  query: string,
  ...bindings: unknown[]
): Promise<T | null> {
  const result = await ctx.bindings.DB.prepare(query)
    .bind(...bindings)
    .first<T>();
  return result ?? null;
}

export async function d1All<T extends Row>(
  ctx: D1Context,
  query: string,
  ...bindings: unknown[]
): Promise<T[]> {
  const result = await ctx.bindings.DB.prepare(query)
    .bind(...bindings)
    .all<T>();
  return (result.results ?? []) as T[];
}

export async function upsertWorkspaceOperation(
  ctx: Pick<D1Context, "bindings">,
  workspaceId: string,
  operation: WorkspaceOperationUpsert,
  createdAt: string,
): Promise<void> {
  await d1Run(
    ctx,
    `
      INSERT INTO workspace_operations (
        op_id, workspace_id, path, revision, action, provider, status, attempt_count,
        next_attempt_at, last_error, provider_result_json, correlation_id, created_at,
        updated_at, completed_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(op_id) DO UPDATE SET
        workspace_id = excluded.workspace_id,
        path = excluded.path,
        revision = excluded.revision,
        action = excluded.action,
        provider = excluded.provider,
        status = excluded.status,
        attempt_count = excluded.attempt_count,
        next_attempt_at = excluded.next_attempt_at,
        last_error = excluded.last_error,
        provider_result_json = excluded.provider_result_json,
        correlation_id = excluded.correlation_id,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at
    `,
    operation.opId,
    workspaceId,
    operation.path ?? "",
    operation.revision ?? "",
    operation.action ?? "file_upsert",
    operation.provider ?? "",
    operation.status,
    operation.attemptCount,
    operation.nextAttemptAt ?? null,
    operation.lastError ?? null,
    operation.providerResult ? JSON.stringify(operation.providerResult) : null,
    operation.correlationId ?? "",
    createdAt,
    operation.updatedAt,
    operation.completedAt,
  );
}

export async function deadLetterEnvelope(
  ctx: DeadLetterEnvelopeContext,
  envelope: EnvelopeMessage,
  errorMessage: string,
): Promise<void> {
  const now = new Date().toISOString();

  const existing = await ctx.d1First<Row>(
    `
      SELECT attempt_count
      FROM dead_letters
      WHERE envelope_id = ? AND workspace_id = ?
    `,
    envelope.envelopeId,
    envelope.workspaceId,
  );
  const nextAttemptCount = Math.max(1, asNumber(existing?.attempt_count) + 1);

  await ctx.d1Run(
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

  await ctx.d1Run(
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

  await ctx.bumpIngressMetric(
    envelope.workspaceId,
    envelope.provider,
    (current) => decrementPending(current, envelope.provider),
  );
  await ctx.updateProviderStatus(
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

  ctx.insertEvent({
    eventId: ctx.nextId("evt"),
    type: "sync.error",
    path: coreNormalizeEnvelopePath(envelope) ?? "/",
    revision: ctx.nextId("rev"),
    origin: "system",
    provider: envelope.provider,
    correlationId: envelope.correlationId,
    timestamp: now,
  });

  await ctx.touchWorkspaceWriteStats(envelope.workspaceId, {
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

export function parseJsonRecord(raw?: string): Record<string, unknown> | null {
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

export function asString(value: unknown): string {
  return typeof value === "string" ? value : value == null ? "" : String(value);
}

export function asOptionalString(value: unknown): string | undefined {
  const normalized = asString(value).trim();
  return normalized || undefined;
}

export function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function isReplayableOperationStatus(status?: string): boolean {
  return (
    status === "failed" || status === "dead_lettered" || status === "canceled"
  );
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

function decrementPending(
  current: IngressState,
  provider: string,
): IngressState {
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

function cloneIngress(current: IngressState): IngressState {
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

function recomputeIngressRates(current: IngressState, provider: string): void {
  current.providers[provider].dedupeRate = ratio(
    current.providers[provider].dedupedTotal,
    current.providers[provider].acceptedTotal,
  );
  current.providers[provider].coalesceRate = ratio(
    current.providers[provider].coalescedTotal,
    current.providers[provider].acceptedTotal,
  );
}

function defaultProviderIngressStatus() {
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
    oldestPendingSince: null as string | null,
  };
}

function ratio(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}
