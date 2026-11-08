/**
 * Versioned analytics export envelope: a pure projection of engine
 * observations and exceptions, owned by the analytics producer. No I/O.
 *
 * The internal observation port (`ENGINE_OBSERVATION_FACTS`) is NOT an
 * analytics allowlist: it carries agent and channel names, user-defined
 * command / action / slug / skill strings and other caller-supplied text that
 * must never leave the installation. This module therefore owns its own
 * reviewed projection:
 *
 * - {@link ANALYTICS_FIELD_RULES}: every field that may be exported, each with
 *   a value rule (opaque engine id, count, non-negative number, boolean flag or
 *   fixed enum). A value that fails its rule is dropped (ids, counts, flags) or
 *   mapped to {@link OTHER_VALUE} (enums); it is never exported as is.
 * - {@link ANALYTICS_EVENT_FIELDS}: per observation kind, exactly which of
 *   those fields that kind exports. Exhaustive over the observation kinds, so
 *   a new kind does not compile until it is reviewed here.
 * - {@link ANALYTICS_DROPPED_FIELDS}: every observation-port field that is
 *   deliberately never exported, with the reason.
 *
 * Everything else on an observation (names, slugs, commands, skills, actions,
 * emoji, providers, content types, topics, descriptions, URLs, emails, the
 * authenticated actor's id and credential hash, the domain sender, content,
 * tokens, raw request data, arbitrary context) is dropped by construction: the
 * projector builds a new object from named fields rather than copying and
 * scrubbing the input. Origin strings are reduced to registered enums.
 *
 * Every event carries a non-empty `trace_id`: the observation's well-formed
 * `request_id` when present, else a random UUID created once here. The event
 * object is immutable after projection, so retries and 413 splits re-send the
 * same `event_id` and `trace_id`.
 */
import type { EngineObservation, EngineObservationKind } from '../ports/telemetry.js';
import type { EngineOperationLabel } from '../ports/diagnostics.js';

export const EXPORT_ENVELOPE_VERSION = 1 as const;

/** Longest exported string (ids, enums, labels); longer values are dropped or refused. */
export const EXPORT_STRING_MAX = 128;

/** Enum value for a string outside the registered set. */
export const OTHER_VALUE = 'other' as const;
/** Enum value for an absent / unknown input. */
export const UNKNOWN_VALUE = 'unknown' as const;

export type ExportFactValue = string | number | boolean | null;

export interface ExportIdentity {
  /** Explicitly configured, stable installation/deployment identity (opaque). */
  deployment: string;
}

export interface ExportOrigin {
  /** Registered app segment of the origin actor path, else `other` / `unknown`. */
  app: string;
  /** Registered type segment of the origin actor path, else `other` / `unknown`. */
  actor_type: string;
  /** Registered origin client, else `other` / `unknown`. */
  client: string;
}

export interface ExportEvent {
  v: typeof EXPORT_ENVELOPE_VERSION;
  event_id: string;
  occurred_at: string;
  component: 'relaycast';
  deployment: string;
  /** Engine observation kind, or `exception`. */
  kind: EngineObservationKind | 'exception';
  /**
   * Workspace attribution; null only for an exception raised outside a
   * workspace (installation-only). Relaycast has no tenant model separate from
   * its workspace, so there is no tenant id field.
   */
  workspace_id: string | null;
  /** Required, non-empty; stable across retries and splits. */
  trace_id: string;
  /** `authenticatedActor.type` only; never the actor id or credential hash. */
  actor_type?: 'human' | 'agent' | 'system';
  /** Observations only; registered enums only. */
  origin?: ExportOrigin;
  facts: Record<string, ExportFactValue>;
}

/** A reviewed value rule for one exported field. */
export type AnalyticsFieldRule =
  | { type: 'id'; doc: string }
  | { type: 'count'; doc: string }
  | { type: 'number'; doc: string }
  | { type: 'flag'; doc: string }
  | { type: 'enum'; values: readonly string[]; doc: string };

/**
 * Opaque engine identifiers: a snowflake (decimal digits), a UUID, or an
 * engine-generated id with a registered prefix. A name that happens to sit in
 * an id field does not match (no registered prefix, not numeric).
 */
const SNOWFLAKE_ID = /^[0-9]{1,20}$/;
const UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIXED_ID = /^(?:dm|dmch|gdm|sub|wh|whd|inv|act|file|aud|cmd|node)_[A-Za-z0-9-]{8,96}$/;

export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && (SNOWFLAKE_ID.test(value) || UUID_ID.test(value) || PREFIXED_ID.test(value));
}

/** The reviewed analytics fields and their value rules. Nothing else is exported. */
export const ANALYTICS_FIELD_RULES: Readonly<Record<string, AnalyticsFieldRule>> = {
  // Opaque engine ids
  agent_id: { type: 'id', doc: 'engine agent id (snowflake)' },
  audit_id: { type: 'id', doc: 'engine audit record id' },
  channel_id: { type: 'id', doc: 'engine channel id' },
  message_id: { type: 'id', doc: 'engine message id' },
  parent_message_id: { type: 'id', doc: 'engine message id of the thread parent' },
  file_id: { type: 'id', doc: 'engine file id' },
  conversation_id: { type: 'id', doc: 'engine DM / group DM conversation id' },
  invocation_id: { type: 'id', doc: 'engine command/action invocation id' },
  subscription_id: { type: 'id', doc: 'engine event subscription id' },
  webhook_id: { type: 'id', doc: 'engine inbound webhook id' },
  // Counts and measurements
  grace_seconds: { type: 'count', doc: 'key rotation grace period, seconds' },
  size_bytes: { type: 'count', doc: 'file size, bytes' },
  query_length: { type: 'count', doc: 'search query length (never the query)' },
  result_count: { type: 'count', doc: 'number of results' },
  duration_ms: { type: 'count', doc: 'session duration, ms' },
  participant_count: { type: 'count', doc: 'group DM participants' },
  event_count: { type: 'count', doc: 'subscribed event types' },
  skill_count: { type: 'count', doc: 'number of directory skills (never the skills)' },
  tag_count: { type: 'count', doc: 'number of search tags (never the tags)' },
  score: { type: 'number', doc: 'directory rating / routing match score' },
  // Flags
  success: { type: 'flag', doc: 'route feedback outcome' },
  fallback: { type: 'flag', doc: 'route resolved via fallback' },
  changed_name: { type: 'flag', doc: 'workspace name changed (never the name)' },
  changed_system_prompt: { type: 'flag', doc: 'system prompt changed' },
  changed_metadata: { type: 'flag', doc: 'metadata changed' },
  changed_status: { type: 'flag', doc: 'agent status changed' },
  changed_persona: { type: 'flag', doc: 'agent persona changed' },
  has_attachments: { type: 'flag', doc: 'message has attachments' },
  has_from_filter: { type: 'flag', doc: 'search used a sender filter' },
  has_channel_filter: { type: 'flag', doc: 'search used a channel filter' },
  // Fixed classification enums (anything else -> 'other')
  stream_mode: { type: 'enum', values: ['on', 'off', 'default', 'enabled', 'disabled'], doc: 'workspace stream mode' },
  operation: { type: 'enum', values: ['set', 'reset'], doc: 'system prompt operation' },
  session_scope: { type: 'enum', values: ['workspace', 'node'], doc: 'WebSocket session scope' },
  created_via: { type: 'enum', values: ['api', 'internal', 'bootstrap'], doc: 'workspace creation path' },
  deleted_via: { type: 'enum', values: ['api', 'internal', 'retention'], doc: 'workspace deletion path' },
  agent_type: { type: 'enum', values: ['agent', 'human', 'system'], doc: 'registered agent type' },
  message_kind: { type: 'enum', values: ['channel_message', 'thread_reply'], doc: 'message kind' },
};

/**
 * Observation-port fields that are never exported, and why. Together with
 * {@link ANALYTICS_FIELD_RULES} this covers every `ENGINE_OBSERVATION_FACTS`
 * field (a test enforces that).
 */
export const ANALYTICS_DROPPED_FIELDS: Readonly<Record<string, string>> = {
  agent_name: 'user-chosen agent name',
  invited_agent_name: 'user-chosen agent name',
  channel_name: 'user-chosen channel name',
  command: 'user-defined command string',
  action_name: 'user-defined action name',
  slug: 'user-defined directory slug',
  skill: 'user-supplied routing skill',
  emoji: 'caller-supplied reaction (may be custom text)',
  provider: 'caller-supplied provider string',
};

/** Per observation kind, the reviewed fields it exports. Exhaustive over kinds. */
export const ANALYTICS_EVENT_FIELDS: Readonly<Record<EngineObservationKind, readonly string[]>> = {
  'workspace.created': ['created_via'],
  'workspace.updated': ['changed_name', 'changed_system_prompt', 'changed_metadata'],
  'workspace.deleted': ['deleted_via'],
  'workspace.stream.updated': ['stream_mode'],
  'workspace.key.rotated': ['grace_seconds'],
  'agent.registered': ['agent_id', 'agent_type'],
  'agent.updated': ['changed_status', 'changed_persona', 'changed_metadata'],
  'legacy.identity.claimed': [],
  'agent.deleted': [],
  'agent.token.rotated': [],
  'agent.identity.taken.over': ['agent_id', 'audit_id'],
  'agent.token.revoked': ['agent_id', 'audit_id'],
  'channel.created': ['channel_id'],
  'channel.updated': ['channel_id'],
  'channel.topic.updated': ['channel_id'],
  'channel.archived': [],
  'channel.joined': ['agent_id'],
  'channel.left': ['agent_id'],
  'channel.invited': [],
  'channel.muted': ['agent_id'],
  'channel.unmuted': ['agent_id'],
  'message.created': ['channel_id', 'message_id', 'has_attachments', 'message_kind'],
  'thread.reply.created': ['message_id', 'parent_message_id'],
  'file.upload.requested': ['file_id', 'size_bytes'],
  'file.upload.completed': ['file_id', 'size_bytes'],
  'dm.sent': ['conversation_id', 'message_id'],
  'group.dm.created': ['conversation_id', 'participant_count'],
  'group.dm.message.sent': ['conversation_id', 'message_id'],
  'group.dm.participant.added': ['conversation_id'],
  'group.dm.participant.removed': ['conversation_id', 'agent_id'],
  'reaction.added': ['message_id'],
  'reaction.removed': ['message_id'],
  'search.executed': ['query_length', 'result_count', 'has_from_filter', 'has_channel_filter'],
  'command.registered': [],
  'command.deleted': [],
  'command.invoked': ['invocation_id'],
  'subscription.created': ['subscription_id', 'event_count'],
  'subscription.deleted': ['subscription_id'],
  'inbound.webhook.created': ['webhook_id'],
  'inbound.webhook.deleted': ['webhook_id'],
  'inbound.webhook.triggered': ['webhook_id'],
  'message.read.marked': ['message_id', 'agent_id'],
  'presence.heartbeat': ['agent_id'],
  'presence.disconnected': ['agent_id'],
  'system.prompt.updated': ['operation'],
  'ws.session.started': ['session_scope'],
  'ws.session.ended': ['session_scope', 'duration_ms'],
  'action.registered': [],
  'action.deleted': [],
  'action.invoked': ['invocation_id'],
  'directory.agent.created': ['skill_count'],
  'directory.agent.updated': [],
  'directory.agent.deleted': [],
  'directory.rating.upserted': ['score'],
  'directory.search.executed': ['query_length', 'result_count', 'tag_count'],
  'route.resolved': ['fallback', 'score'],
  'route.feedback.recorded': ['success'],
  'routing.config.updated': [],
  'relayfile.inbound.delivered': [],
};

/** Registered origin clients (`origin.client`); anything else is `other`. */
export const REGISTERED_ORIGIN_CLIENTS: ReadonlySet<string> = new Set([
  '@relaycast/sdk',
  '@relaycast/sdk-ts',
  '@relaycast/sdk-rust',
  '@relaycast/sdk-swift',
  '@relaycast/mcp',
  '@relaycast/cli',
  '@relaycast/react',
  '@relaycast/openclaw',
  '@relaycast/a2a',
  'agent-relay-cli',
  'agent-relay-broker',
]);
/** Registered origin-actor apps (first path segment); anything else is `other`. */
export const REGISTERED_ORIGIN_APPS: ReadonlySet<string> = new Set([
  'agent-relay-cli',
  'agent-relay-broker',
  'agent-relay-cloud',
  'pear',
  'relaycast-cli',
  'relaycast-mcp',
]);
/** Registered origin-actor types (second path segment); anything else is `other`. The `{name}` segment is never exported. */
export const REGISTERED_ORIGIN_ACTOR_TYPES: ReadonlySet<string> = new Set(['agent', 'user', 'system', 'node', 'ci']);

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
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

function applyRule(rule: AnalyticsFieldRule, value: unknown): ExportFactValue | undefined {
  switch (rule.type) {
    case 'id':
      return isOpaqueId(value) ? value : undefined;
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    case 'flag':
      return typeof value === 'boolean' ? value : undefined;
    case 'enum':
      if (value === undefined || value === null) return undefined;
      return typeof value === 'string' && rule.values.includes(value) ? value : OTHER_VALUE;
  }
}

/**
 * Project the observation facts for `kind` through the reviewed allowlist and
 * value rules. Exported for tests.
 */
export function projectFacts(kind: EngineObservationKind, sourceFacts: Record<string, unknown>): Record<string, ExportFactValue> {
  const facts: Record<string, ExportFactValue> = {};
  for (const key of ANALYTICS_EVENT_FIELDS[kind]) {
    const rule = ANALYTICS_FIELD_RULES[key];
    if (!rule || !Object.prototype.hasOwnProperty.call(sourceFacts, key)) continue;
    const value = applyRule(rule, sourceFacts[key]);
    if (value !== undefined) facts[key] = value;
  }
  return facts;
}

function registered(value: unknown, set: ReadonlySet<string>): string {
  if (typeof value !== 'string' || value === '' || value === UNKNOWN_VALUE) return UNKNOWN_VALUE;
  return set.has(value) ? value : OTHER_VALUE;
}

/** Reduce origin strings to registered enums; the actor `{name}` segment and version are never exported. */
export function projectOrigin(origin: unknown): ExportOrigin {
  const o = (origin && typeof origin === 'object' ? origin : {}) as Record<string, unknown>;
  const actor = typeof o.actor === 'string' ? o.actor.toLowerCase() : undefined;
  const [app, type] = actor && actor !== UNKNOWN_VALUE ? actor.split('/') : [];
  return {
    app: registered(app, REGISTERED_ORIGIN_APPS),
    actor_type: registered(type, REGISTERED_ORIGIN_ACTOR_TYPES),
    client: registered(o.client, REGISTERED_ORIGIN_CLIENTS),
  };
}

/** The request id when well-formed, else a fresh random UUID. Never empty. */
export function traceIdOf(requestId: unknown): string {
  return typeof requestId === 'string' && REQUEST_ID.test(requestId) ? requestId : globalThis.crypto.randomUUID();
}

function isoTime(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') {
    const time = new Date(value);
    if (!Number.isNaN(time.getTime())) return time.toISOString();
  }
  return new Date().toISOString();
}

function workspaceIdOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' && value.length <= EXPORT_STRING_MAX ? value : null;
}

function base(identity: ExportIdentity, occurredAt: unknown): Pick<ExportEvent, 'v' | 'event_id' | 'occurred_at' | 'component' | 'deployment'> {
  return {
    v: EXPORT_ENVELOPE_VERSION,
    event_id: globalThis.crypto.randomUUID(),
    occurred_at: isoTime(occurredAt),
    component: 'relaycast',
    deployment: identity.deployment,
  };
}

function isKnownKind(kind: unknown): kind is EngineObservationKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(ANALYTICS_EVENT_FIELDS, kind);
}

/**
 * Project an engine observation into the export envelope, or `null` for a kind
 * outside {@link ANALYTICS_EVENT_FIELDS} or without a workspace (never exported).
 */
export function projectObservation(obs: EngineObservation, identity: ExportIdentity): ExportEvent | null {
  if (!isKnownKind(obs?.kind)) return null;
  const kind = obs.kind;
  const workspaceId = workspaceIdOf(obs.workspaceId);
  // Observations are native-workspace events: workspace_id is required.
  if (workspaceId === null) return null;
  const sourceFacts: Record<string, unknown> = obs.facts && typeof obs.facts === 'object' ? obs.facts : {};
  const actorType = obs.authenticatedActor?.type;
  return {
    ...base(identity, obs.occurredAt),
    kind,
    workspace_id: workspaceId,
    trace_id: traceIdOf(sourceFacts.request_id),
    ...(typeof actorType === 'string' && ACTOR_TYPES.has(actorType) ? { actor_type: actorType } : {}),
    origin: projectOrigin(obs.origin),
    facts: projectFacts(kind, sourceFacts),
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
 * operation, the workspace id and a trace id (the context's well-formed
 * `request_id`, else a random UUID). Never the message, stack or any other
 * context value.
 */
export function projectException(err: unknown, context: unknown, identity: ExportIdentity): ExportEvent {
  const ctx: Record<string, unknown> = context && typeof context === 'object' ? context as Record<string, unknown> : {};
  const errorCode = codeOf(err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined)
    ?? codeOf(ctx.error_code);
  const operation = operationOf(ctx);
  return {
    ...base(identity, undefined),
    kind: 'exception',
    workspace_id: workspaceIdOf(ctx.workspace_id ?? ctx.workspaceId),
    trace_id: traceIdOf(ctx.request_id ?? ctx.requestId),
    facts: {
      error_name: errorName(err),
      ...(errorCode ? { error_code: errorCode } : {}),
      ...(operation ? { operation } : {}),
    },
  };
}
