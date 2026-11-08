/**
 * Versioned analytics export envelope: a pure, typed allowlist projection of
 * engine observations and exceptions. No I/O.
 *
 * Only explicitly permitted fields leave the process. Everything else on an
 * observation (the authenticated actor's credential hash, the domain sender,
 * product content, raw request data, tokens, arbitrary context) is dropped by
 * construction: the projector builds a new object from named fields rather
 * than copying and scrubbing the input.
 */
import { ENGINE_OBSERVATION_FACTS, type EngineObservation, type EngineObservationKind } from '../ports/telemetry.js';
import type { EngineOperationLabel } from '../ports/diagnostics.js';

export const EXPORT_ENVELOPE_VERSION = 1 as const;

/** Longest exported string; longer values are truncated. */
export const EXPORT_STRING_MAX = 256;

export type ExportFactValue = string | number | boolean | null;

export interface ExportIdentity {
  /** Installation/deployment label chosen by the operator. */
  deployment: string;
  /** Process/replica label (for example the pod hostname). */
  instance?: string;
}

export interface ExportEvent {
  v: typeof EXPORT_ENVELOPE_VERSION;
  event_id: string;
  occurred_at: string;
  component: 'relaycast';
  deployment: string;
  instance?: string;
  /** Engine observation kind, or `exception`. */
  kind: EngineObservationKind | 'exception';
  /**
   * Workspace attribution; null only for an exception raised outside a
   * workspace (installation-only). Relaycast has no tenant model separate from
   * its workspace, so there is no tenant id field.
   */
  workspace_id: string | null;
  /** `authenticatedActor.type` only; never the actor id or credential hash. */
  actor_type?: 'human' | 'agent' | 'system';
  /** Observations only. */
  origin?: { actor: string; client: string; version: string };
  correlation_id?: string;
  facts: Record<string, ExportFactValue>;
}

/**
 * Extra, non-required facts that may be exported per kind. Required facts come
 * from {@link ENGINE_OBSERVATION_FACTS}; anything not listed in either place is
 * dropped. Keep entries to flags, counts and fixed enums.
 */
export const OPTIONAL_EXPORT_FACTS: Partial<Record<EngineObservationKind, readonly string[]>> = {
  'workspace.created': ['created_via'],
  'workspace.updated': ['changed_name', 'changed_system_prompt', 'changed_metadata'],
  'workspace.deleted': ['deleted_via'],
  'agent.registered': ['agent_type'],
  'agent.updated': ['changed_status', 'changed_persona', 'changed_metadata'],
  'message.created': ['has_attachments', 'message_kind'],
  'search.executed': ['has_from_filter', 'has_channel_filter'],
  'group.dm.created': ['participant_count'],
  'subscription.created': ['event_count'],
  'directory.agent.created': ['skill_count'],
  'directory.search.executed': ['tag_count'],
  'route.resolved': ['fallback'],
};

/**
 * Defence in depth: a key matching this is never exported even if a future
 * allowlist edit names it.
 */
const FORBIDDEN_KEY = /text|body|content|token|secret|password|authorization|credential|hash|sender|cookie/i;

/** Fact keys read as the correlation id (never copied into `facts`). */
const CORRELATION_FACT_KEYS = ['request_id'] as const;
const CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const ACTOR_TYPES = new Set(['human', 'agent', 'system']);

/** Exception context `source` values (with their `op`s) that may be exported. */
const EXCEPTION_SOURCES: Record<string, readonly string[]> = {
  'node.event_queue': ['poll', 'deliver', 'retention_prune'],
  'node.maintenance': ['node_delivery', 'delivery_expiry'],
  'actor.maintenance': [],
};
const ENGINE_OPERATIONS: ReadonlySet<EngineOperationLabel> = new Set<EngineOperationLabel>([
  'inbox.get',
  'deliveries.list',
  'workspace.delete',
  'invocations.sweep',
  'backfill.mention_fts',
]);

/** `error_name` for an Error whose constructor is not in {@link REGISTERED_ERROR_NAMES}. */
export const UNREGISTERED_ERROR_NAME = 'unregistered' as const;

/**
 * Registered exception classifications: the error constructor names an
 * exported `error_name` may carry. The JavaScript built-ins, the classes the
 * engine defines (`class ... extends Error`) and the driver errors its storage
 * layer surfaces. Any other constructor name is exported as
 * {@link UNREGISTERED_ERROR_NAME}, never as is: a name is caller-controlled
 * text, and a code-shaped string alone is not a privacy allowlist.
 */
export const REGISTERED_ERROR_NAMES: ReadonlySet<string> = new Set([
  // JavaScript / platform built-ins
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'DOMException',
  // Engine-defined (src/**: `class ... extends Error`)
  'AdmissionDeniedError',
  'ConfigError',
  'D1WriteRetryExhaustedError',
  'ExternalIoOutsideMaintenance',
  'WorkspaceDeliveryCapacityError',
  'WorkspaceIdNotSnowflakeError',
  // Storage drivers (better-sqlite3, drizzle-orm)
  'SqliteError',
  'DrizzleError',
  'DrizzleQueryError',
]);

/**
 * Registered exception codes an exported `error_code` may carry; any other
 * code is omitted. There is no single exported enum of engine wire codes, so
 * this lists the stable codes of the engine's server-side failures (the `5xx`
 * responses that reach `captureException`), the generic fallback, and the
 * storage-driver / Node system codes maintenance errors carry. 4xx codes are
 * never captured as exceptions.
 */
export const REGISTERED_ERROR_CODES: ReadonlySet<string> = new Set([
  // Engine wire codes (5xx)
  'internal_error',
  'delivery_failed',
  'webhook_agent_provision_failed',
  'workspace_id_collision',
  'a2a_agent_card_fetch_failed',
  'a2a_invalid_response',
  'a2a_jsonrpc_error',
  'a2a_redirect_forbidden',
  'a2a_transport_unavailable',
  'a2a_legacy_replay_unavailable',
  'action_deleted',
  'agent_host_unavailable',
  'database_overloaded',
  'event_delivery_fetch_required',
  'event_delivery_retryable_failure',
  'file_storage_delete_partial',
  'file_storage_delete_unsupported',
  'handler_unavailable',
  'idempotency_unavailable',
  'mailbox_full',
  'node_dispatch_unavailable',
  'relayfile_inbound_unavailable',
  'spawn_target_unavailable',
  'workspace_create_idempotency_unavailable',
  'workspace_storage_unavailable',
  // SQLite (better-sqlite3 `SqliteError.code`)
  'SQLITE_ERROR',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_READONLY',
  'SQLITE_CANTOPEN',
  'SQLITE_CONSTRAINT',
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  'SQLITE_CONSTRAINT_FOREIGNKEY',
  'SQLITE_CONSTRAINT_NOTNULL',
  'SQLITE_CONSTRAINT_CHECK',
  // Node system errors
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOSPC',
  'EACCES',
  'ENOENT',
  'EMFILE',
]);

function truncate(value: string): string {
  return value.length > EXPORT_STRING_MAX ? value.slice(0, EXPORT_STRING_MAX) : value;
}

function factValue(value: unknown): ExportFactValue | undefined {
  if (value === null) return null;
  if (typeof value === 'string') return truncate(value);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return undefined;
}

function isoTime(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    const time = new Date(value);
    if (!Number.isNaN(time.getTime())) return time.toISOString();
  }
  return new Date().toISOString();
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? truncate(value) : fallback;
}

function base(identity: ExportIdentity, occurredAt: unknown): Pick<ExportEvent, 'v' | 'event_id' | 'occurred_at' | 'component' | 'deployment' | 'instance'> {
  return {
    v: EXPORT_ENVELOPE_VERSION,
    event_id: globalThis.crypto.randomUUID(),
    occurred_at: isoTime(occurredAt),
    component: 'relaycast',
    deployment: truncate(identity.deployment),
    ...(identity.instance ? { instance: truncate(identity.instance) } : {}),
  };
}

function isKnownKind(kind: unknown): kind is EngineObservationKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ENGINE_OBSERVATION_FACTS, kind);
}

/**
 * Project an engine observation into the export envelope, or `null` for a kind
 * outside {@link ENGINE_OBSERVATION_FACTS} (which is never exported).
 */
export function projectObservation(obs: EngineObservation, identity: ExportIdentity): ExportEvent | null {
  if (!isKnownKind(obs?.kind)) return null;
  const kind = obs.kind;
  const sourceFacts: Record<string, unknown> = obs.facts && typeof obs.facts === 'object' ? obs.facts : {};
  const permitted = [...ENGINE_OBSERVATION_FACTS[kind], ...(OPTIONAL_EXPORT_FACTS[kind] ?? [])];
  const facts: Record<string, ExportFactValue> = {};
  for (const key of permitted) {
    if (FORBIDDEN_KEY.test(key) || !Object.prototype.hasOwnProperty.call(sourceFacts, key)) continue;
    const value = factValue(sourceFacts[key]);
    if (value !== undefined) facts[key] = value;
  }

  let correlationId: string | undefined;
  for (const key of CORRELATION_FACT_KEYS) {
    const value = sourceFacts[key];
    if (typeof value === 'string' && CORRELATION_ID.test(value)) {
      correlationId = value;
      break;
    }
  }

  const actorType = obs.authenticatedActor?.type;
  const origin = obs.origin as Partial<EngineObservation['origin']> | undefined;
  return {
    ...base(identity, obs.occurredAt),
    kind,
    workspace_id: stringOr(obs.workspaceId, ''),
    ...(typeof actorType === 'string' && ACTOR_TYPES.has(actorType)
      ? { actor_type: actorType }
      : {}),
    origin: {
      actor: stringOr(origin?.actor, 'unknown'),
      client: stringOr(origin?.client, 'unknown'),
      version: stringOr(origin?.version, 'unknown'),
    },
    ...(correlationId ? { correlation_id: correlationId } : {}),
    facts,
  };
}

function errorName(err: unknown): string {
  if (err instanceof Error) {
    const ctorName = (err.constructor as { name?: unknown } | undefined)?.name;
    return typeof ctorName === 'string' && REGISTERED_ERROR_NAMES.has(ctorName) ? ctorName : UNREGISTERED_ERROR_NAME;
  }
  // `typeof` yields a fixed set of values, so this is a closed classification too.
  return err === null ? 'NonError:null' : `NonError:${typeof err}`;
}

function codeOf(value: unknown): string | undefined {
  return typeof value === 'string' && REGISTERED_ERROR_CODES.has(value) ? value : undefined;
}

function operationOf(context: Record<string, unknown>): string | undefined {
  const source = context.source;
  if (typeof source === 'string' && Object.prototype.hasOwnProperty.call(EXCEPTION_SOURCES, source)) {
    const op = context.op;
    return typeof op === 'string' && EXCEPTION_SOURCES[source]!.includes(op) ? `${source}.${op}` : source;
  }
  const engineOperation = context.engine_operation;
  if (typeof engineOperation === 'string' && ENGINE_OPERATIONS.has(engineOperation as EngineOperationLabel)) {
    return engineOperation;
  }
  return undefined;
}

/**
 * Classify an exception: a registered constructor name (else
 * {@link UNREGISTERED_ERROR_NAME}), a registered `code` (from the error, else
 * the context's `error_code`; omitted when unregistered), an allowlisted
 * operation and the workspace id. Never the message, stack or any other
 * context value.
 */
export function projectException(err: unknown, context: unknown, identity: ExportIdentity): ExportEvent {
  const ctx: Record<string, unknown> = context && typeof context === 'object' ? context as Record<string, unknown> : {};
  const errorCode = codeOf(err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined)
    ?? codeOf(ctx.error_code);
  const operation = operationOf(ctx);
  const workspaceId = ctx.workspace_id ?? ctx.workspaceId;
  return {
    ...base(identity, undefined),
    kind: 'exception',
    workspace_id: typeof workspaceId === 'string' && workspaceId ? truncate(workspaceId) : null,
    facts: {
      error_name: errorName(err),
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(operation ? { operation } : {}),
    },
  };
}
