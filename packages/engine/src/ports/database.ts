import { configureNodeLiveness, nodeLivenessAuthority } from './nodeLiveness.js';
import { inheritCredentials } from '../auth/credentials.js';
import { WorkspaceDeliveryCapacityError } from '../engine/workspaceDeliveryPolicy.js';
import type { SQLWrapper } from 'drizzle-orm';
import type { EngineDatabase } from './engineDb.js';

/**
 * Driver-agnostic Drizzle handle used by every engine module.
 *
 * Every adapter (Cloudflare D1, Node better-sqlite3 / bun:sqlite, durable
 * actors, and later Postgres) hands the engine a handle of this neutral type.
 * Drizzle query builders are thenable, so `await db.select()...` works against both. The engine never
 * imports a concrete driver — adapters construct the handle and inject it.
 *
 * The one place the drivers genuinely diverge is atomicity across statements:
 * better-sqlite3 supports interactive transactions; D1 has no interactive
 * transactions but executes `db.batch([...])` atomically. Engine
 * multi-statement write paths go through {@link runAtomicWrites} with a
 * statement builder, which uses {@link TransactionCapability} when an adapter
 * attached it, then a D1-style {@link BatchCapability} when the handle exposes
 * one, and otherwise falls back to plain sequential statements (the engine's
 * historical behavior). Cross-row invariants that must hold on *every*
 * adapter — not just atomicity-capable ones — still need single-statement
 * atomicity (for example, an insert whose trigger advances a durable sequence
 * high-water) rather than a multi-step read-modify-write.
 */
// `EngineDb` is the dialect-neutral surface in `ports/engineDb.ts`: query
// builders whose row types are inferred from the bound tables (`db/tables.ts`),
// plus the `engineDialect` brand. It has no raw-SQL methods; raw statements go
// through `db/sqlx.ts`, which dispatches on the brand. Adapters produce it:
// SQLite drivers (better-sqlite3, bun:sqlite, actor sqlite-proxy, D1) through
// `brandSqliteEngineDb`, whose result is both the precise drizzle SQLite type
// and an `EngineDb`.
export type EngineDb = EngineDatabase;

/**
 * Optional atomicity capability an adapter may attach to its {@link EngineDb}
 * handle when the underlying driver supports interactive transactions.
 *
 * Semantics: `fn` runs inside a single transaction; if it throws, every
 * statement issued through `tx` is rolled back, and the error is rethrown.
 * Adapters that cannot provide this (Cloudflare D1) simply omit the capability;
 * {@link runAtomicWrites} then tries {@link BatchCapability} before degrading
 * to sequential statements.
 *
 * Only database writes belong inside `fn`. Fire-and-forget fanout (realtime
 * broadcast, webhook queueing) must stay outside so an aborted transaction
 * never emits events for rows that were rolled back, and so external I/O never
 * extends the transaction's lifetime.
 */
export interface TransactionCapability {
  withTransaction<T>(fn: (tx: EngineDb) => Promise<T>): Promise<T>;
}

/** Whether the adapter attached {@link TransactionCapability} to this handle. */
export function hasTransactionCapability<T extends object>(db: T): db is T & TransactionCapability {
  return typeof (db as Partial<TransactionCapability>).withTransaction === 'function';
}

/**
 * Narrow a handle to one that carries {@link TransactionCapability}, checking
 * at runtime instead of casting. Throws when the adapter did not attach it.
 */
export function requireTransactionCapability<T extends object>(db: T): T & TransactionCapability {
  if (!hasTransactionCapability(db)) throw new Error('database handle has no withTransaction capability');
  return db;
}

/**
 * A built-but-unexecuted Drizzle write statement.
 *
 * Drizzle query builders are lazy: constructing one issues no SQL until it is
 * awaited (it is a thenable) or handed to a D1-style `batch()`. Typed
 * structurally (a thenable SQL wrapper) rather than as drizzle's
 * `BatchItem<'sqlite'>`, so builders of any dialect qualify; a D1 handle's
 * `batch()` receives the same builder objects at runtime.
 */
export type AtomicWrite = SQLWrapper & PromiseLike<unknown>;

/**
 * Build the full write list from the handle that will execute it.
 *
 * This matters for Node: the adapter runs file-backed transactions on a short
 * lived isolated SQLite connection, so statements must be built from the
 * transactional `tx` handle. For D1, no transaction handle exists, so the same
 * builder runs against the original batch-capable handle and the returned list
 * is passed to `batch([...])`.
 */
export type AtomicWriteBuilder = (db: EngineDb) => readonly AtomicWrite[];
export type AtomicWriteInput = readonly AtomicWrite[] | AtomicWriteBuilder;

export interface RunAtomicWritesOptions {
  /** Reject before building statements when the handle cannot guarantee rollback. */
  requireAtomic?: boolean;
}

/**
 * D1-style atomic batch: every statement applies, or none does.
 *
 * Drizzle's `DrizzleD1Database` exposes a conforming `batch()` natively, so
 * the hosted adapter's plain `drizzle(env.DB, { schema })` handle is
 * batch-capable with zero configuration — {@link runAtomicWrites} detects the
 * method structurally rather than requiring the adapter to attach anything.
 */
export interface BatchCapability {
  batch(statements: readonly [AtomicWrite, ...AtomicWrite[]]): Promise<unknown[]>;
}

/** A transaction handle carries the bindings of the handle it was opened from. */
function inheritHandleBindings(tx: EngineDb, db: EngineDb): void {
  configureNodeLiveness(tx, nodeLivenessAuthority(db));
  inheritCredentials(tx, db);
}

function buildStatements(input: AtomicWriteInput, db: EngineDb): readonly AtomicWrite[] {
  return typeof input === 'function' ? input(db) : input;
}

async function runSequentially(statements: readonly AtomicWrite[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (const statement of statements) {
    results.push(await statement);
  }
  return results;
}

/**
 * Run `fn` atomically when the handle exposes {@link TransactionCapability},
 * otherwise run it directly. Prefer {@link runAtomicWrites} for durable write
 * paths that must also be atomic under D1.
 */
export function runAtomic<T>(db: EngineDb, fn: (tx: EngineDb) => Promise<T>): Promise<T> {
  // Capability probe: the cast only adds optional capability members.
  const { withTransaction } = db as Partial<TransactionCapability>;
  return withTransaction ? withTransaction(tx => {
    inheritHandleBindings(tx, db);
    return fn(tx);
  }) : fn(db);
}

/**
 * Execute write statements atomically when the handle supports it.
 *
 * Resolution order:
 *  1. {@link TransactionCapability} (Node better-sqlite3) — statements are
 *     built from the transaction handle and run sequentially inside one
 *     transaction, so partial results roll back.
 *  2. {@link BatchCapability} (Cloudflare D1 via drizzle's native `batch`) —
 *     statements are built from the original handle and run as one atomic
 *     batch.
 *  3. Neither — statements run sequentially with no rollback, the engine's
 *     historical behavior for bare handles, unless `requireAtomic` is set.
 *
 * Returns the per-statement results in order, so callers can recover
 * `.returning()` rows by index. Statements must not depend on each other's
 * DB-returned values (IDs are app-generated snowflakes), because under a batch
 * nothing is visible until every statement has executed.
 */
async function executeAtomicWrites(
  db: EngineDb,
  input: AtomicWriteInput,
  options: RunAtomicWritesOptions = {},
): Promise<unknown[]> {
  // Capability probe: the cast only adds optional capability members.
  const handle = db as Partial<TransactionCapability> & Partial<BatchCapability>;
  if (
    options.requireAtomic &&
    typeof handle.withTransaction !== 'function' &&
    typeof handle.batch !== 'function'
  ) {
    throw new Error(
      'Atomic write capability required: database handle exposes neither withTransaction nor batch',
    );
  }

  if (handle.withTransaction) {
    return handle.withTransaction(async (tx) => {
      inheritHandleBindings(tx, db);
      const statements = buildStatements(input, tx);
      return statements.length === 0 ? [] : runSequentially(statements);
    });
  }

  const statements = buildStatements(input, db);
  if (statements.length === 0) return [];

  if (typeof handle.batch === 'function') {
    return handle.batch(statements as [AtomicWrite, ...AtomicWrite[]]);
  }
  return runSequentially(statements);
}

/** Translate a workspace guard failure after the atomic adapter rolls back. */
export async function runAtomicWrites(
  db: EngineDb, input: AtomicWriteInput, options: RunAtomicWritesOptions = {},
): Promise<unknown[]> {
  try { return await executeAtomicWrites(db, input, options); }
  catch (error) {
    if (databaseConstraintKind(error) === 'workspace_delivery_capacity') {
      throw new WorkspaceDeliveryCapacityError('Workspace delivery backlog is full; retry after it drains');
    }
    throw error;
  }
}

/** Normalize atomic admission sentinels across adapters (D1 wraps the message;
 * PostgreSQL reports SQLSTATE fields). Keep driver-specific error decoding at
 * this port boundary; engine callers use a stable kind.
 */
export type DatabaseConstraintKind = 'mailbox_capacity' | 'workspace_delivery_capacity' | 'a2a_registration_changed' | 'address_changed' | 'node_capacity';

/** The schema every PostgreSQL engine table lives in (db/schema.pg.ts). */
const PG_ENGINE_SCHEMA = 'public';

/**
 * PostgreSQL NOT NULL sentinels: SQLSTATE 23502 carries the violated
 * `table` and `column` as fields, so the kind is a lookup, never a message
 * parse. The same columns the SQLite branch below matches by message.
 * `channels.workspace_id` (the internal-admin key guard) is deliberately
 * absent: it is not an admission sentinel and must not decode as one.
 */
export const PG_NOT_NULL_SENTINELS: Readonly<Record<string, DatabaseConstraintKind>> = Object.freeze({
  'messages.agent_id': 'a2a_registration_changed',
  'a2a_inbound.workspace_id': 'a2a_registration_changed',
  'deliveries.workspace_id': 'mailbox_capacity',
  'deliveries.status': 'workspace_delivery_capacity',
  'messages.body': 'address_changed',
  'nodes.active_agents': 'node_capacity',
});

/** The fields node-postgres' DatabaseError carries (all optional on the wire). */
interface PgErrorFields {
  code?: unknown;
  schema?: unknown;
  table?: unknown;
  column?: unknown;
  constraint?: unknown;
  message?: unknown;
  cause?: unknown;
}

/** A PostgreSQL error carries a five-character SQLSTATE; SQLite codes are `SQLITE_*`. */
function pgSqlState(record: PgErrorFields): string | undefined {
  return typeof record.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code) ? record.code : undefined;
}

/** Visit `error` and its `.cause` chain once each, stopping at the first defined result. */
function walkCauses<T>(error: unknown, visit: (record: PgErrorFields) => T | undefined): T | undefined {
  const seen = new Set<unknown>();
  let cause = error;
  while (cause !== null && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    const record = cause as PgErrorFields;
    const found = visit(record);
    if (found !== undefined) return found;
    cause = record.cause;
  }
  return undefined;
}

export function databaseConstraintKind(error: unknown): DatabaseConstraintKind | undefined {
  return walkCauses(error, (record) => {
    const sqlState = pgSqlState(record);
    if (sqlState !== undefined) {
      // PostgreSQL: decode SQLSTATE fields only. Trigger refusals (23000) are
      // not admission sentinels, exactly as their SQLite RAISE(ABORT)
      // counterparts are not; see databaseTriggerRefusal.
      if (sqlState !== '23502' || record.schema !== PG_ENGINE_SCHEMA) return undefined;
      if (typeof record.table !== 'string' || typeof record.column !== 'string') return undefined;
      return Object.hasOwn(PG_NOT_NULL_SENTINELS, `${record.table}.${record.column}`)
        ? PG_NOT_NULL_SENTINELS[`${record.table}.${record.column}`]
        : undefined;
    }
    const message = typeof record.message === 'string' ? record.message : '';
    // Registration guards use messages.agent_id for admission and
    // a2a_inbound.workspace_id for legacy identity promotion (both non-null).
    if (/NOT NULL constraint failed: (messages\.agent_id|a2a_inbound\.workspace_id)/i.test(message)) return 'a2a_registration_changed';
    // Per-recipient/required-mailbox sentinel (workspace_id NULL), and the
    // distinct workspace-scoped growth sentinel (status NULL). Order matters
    // only for a row that trips both; either is a capacity refusal.
    if (/NOT NULL constraint failed: deliveries\.workspace_id/i.test(message)) return 'mailbox_capacity';
    if (/NOT NULL constraint failed: deliveries\.status/i.test(message)) return 'workspace_delivery_capacity';
    // Addressed DM admission: the recipient left the addressed node before commit.
    if (/NOT NULL constraint failed: messages\.body/i.test(message)) return 'address_changed';
    // Agent-slot admission: the reserve statement writes NULL into
    // nodes.active_agents when the capacity predicate fails, so a refused
    // registration aborts its whole atomic group instead of committing an
    // agent row whose slot was never granted.
    if (/NOT NULL constraint failed: nodes\.active_agents/i.test(message)) return 'node_capacity';
    return undefined;
  });
}

/**
 * Every unique index, unique constraint and primary key in the PostgreSQL
 * schema, by the name the server reports in a 23505's `constraint` field
 * (PostgreSQL truncates identifiers to 63 bytes, so the long composite key
 * name appears truncated). Each maps to `[table, columns]`. Kept in parity
 * with db/schema.pg.ts by a unit test and with the migrated catalog by the
 * fixture integration test.
 */
export const PG_UNIQUE_CONSTRAINTS: Readonly<Record<string, readonly [table: string, columns: readonly string[]]>> = Object.freeze({
  a2a_agents_pkey: ['a2a_agents', ['id']],
  a2a_agents_rowid_unique: ['a2a_agents', ['rowid']],
  idx_a2a_agents_relay_agent: ['a2a_agents', ['relay_agent_id']],
  a2a_egress_pkey: ['a2a_egress', ['id']],
  a2a_egress_rowid_unique: ['a2a_egress', ['rowid']],
  a2a_egress_context_pkey: ['a2a_egress_context', ['id']],
  a2a_egress_context_rowid_unique: ['a2a_egress_context', ['rowid']],
  a2a_inbound_pkey: ['a2a_inbound', ['id']],
  a2a_inbound_rowid_unique: ['a2a_inbound', ['rowid']],
  action_invocations_pkey: ['action_invocations', ['id']],
  action_invocations_rowid_unique: ['action_invocations', ['rowid']],
  actions_pkey: ['actions', ['id']],
  actions_rowid_unique: ['actions', ['rowid']],
  actions_workspace_agent_name_unique: ['actions', ['workspace_id', 'name']],
  actions_workspace_global_name_unique: ['actions', ['workspace_id', 'name']],
  actions_workspace_node_name_unique: ['actions', ['workspace_id', 'handler_node_id', 'name']],
  agent_identity_audit_pkey: ['agent_identity_audit', ['id']],
  agent_identity_audit_rowid_unique: ['agent_identity_audit', ['rowid']],
  agent_node_bindings_agent_node_unique: ['agent_node_bindings', ['agent_id', 'node_id']],
  agent_node_bindings_pkey: ['agent_node_bindings', ['id']],
  agent_node_bindings_rowid_unique: ['agent_node_bindings', ['rowid']],
  agent_recovery_credentials_agent_unique: ['agent_recovery_credentials', ['workspace_id', 'agent_id']],
  agent_recovery_credentials_pkey: ['agent_recovery_credentials', ['id']],
  agent_recovery_credentials_rowid_unique: ['agent_recovery_credentials', ['rowid']],
  agent_recovery_credentials_verifier_unique: ['agent_recovery_credentials', ['verifier_hash']],
  agents_pkey: ['agents', ['id']],
  agents_rowid_unique: ['agents', ['rowid']],
  agents_token_hash_unique: ['agents', ['token_hash']],
  agents_workspace_id_unique: ['agents', ['workspace_id', 'id']],
  agents_workspace_name_unique: ['agents', ['workspace_id', 'name']],
  certifications_pkey: ['certifications', ['id']],
  certifications_rowid_unique: ['certifications', ['rowid']],
  channel_members_channel_id_agent_id_pk: ['channel_members', ['channel_id', 'agent_id']],
  channel_members_rowid_unique: ['channel_members', ['rowid']],
  channels_pkey: ['channels', ['id']],
  channels_rowid_unique: ['channels', ['rowid']],
  channels_workspace_name_unique: ['channels', ['workspace_id', 'name']],
  credential_upgrades_pkey: ['credential_upgrades', ['legacy_hash']],
  credential_upgrades_rowid_unique: ['credential_upgrades', ['rowid']],
  deliveries_agent_seq_unique: ['deliveries', ['workspace_id', 'agent_id', 'seq']],
  deliveries_message_agent_unique: ['deliveries', ['message_id', 'agent_id']],
  deliveries_pkey: ['deliveries', ['id']],
  deliveries_rowid_unique: ['deliveries', ['rowid']],
  idx_deliveries_id_lookup: ['deliveries', ['id']],
  direct_dm_idempotency_pkey: ['direct_dm_idempotency', ['id']],
  direct_dm_idempotency_rowid_unique: ['direct_dm_idempotency', ['rowid']],
  directory_agents_pkey: ['directory_agents', ['id']],
  directory_agents_rowid_unique: ['directory_agents', ['rowid']],
  directory_agents_workspace_slug_unique: ['directory_agents', ['workspace_id', 'slug']],
  directory_ratings_agent_rater_unique: ['directory_ratings', ['directory_agent_id', 'rater_agent_id']],
  directory_ratings_pkey: ['directory_ratings', ['id']],
  directory_ratings_rowid_unique: ['directory_ratings', ['rowid']],
  directory_skills_pkey: ['directory_skills', ['id']],
  directory_skills_rowid_unique: ['directory_skills', ['rowid']],
  dm_conversation_reservations_pair_unique: ['dm_conversation_reservations', ['workspace_id', 'participant_one_id', 'participant_two_id']],
  dm_conversation_reservations_pkey: ['dm_conversation_reservations', ['conversation_id']],
  dm_conversation_reservations_rowid_unique: ['dm_conversation_reservations', ['rowid']],
  dm_conversations_pkey: ['dm_conversations', ['id']],
  dm_conversations_rowid_unique: ['dm_conversations', ['rowid']],
  dm_participants_conversation_id_agent_id_pk: ['dm_participants', ['conversation_id', 'agent_id']],
  dm_participants_rowid_unique: ['dm_participants', ['rowid']],
  event_subscriptions_pkey: ['event_subscriptions', ['id']],
  event_subscriptions_rowid_unique: ['event_subscriptions', ['rowid']],
  file_cleanup_queue_pkey: ['file_cleanup_queue', ['storage_key']],
  file_cleanup_queue_rowid_unique: ['file_cleanup_queue', ['rowid']],
  files_pkey: ['files', ['id']],
  files_rowid_unique: ['files', ['rowid']],
  maintenance_cursors_pkey: ['maintenance_cursors', ['id']],
  maintenance_cursors_rowid_unique: ['maintenance_cursors', ['rowid']],
  message_attachments_message_id_file_id_pk: ['message_attachments', ['message_id', 'file_id']],
  message_attachments_rowid_unique: ['message_attachments', ['rowid']],
  message_logs_message_unique: ['message_logs', ['message_id']],
  message_logs_pkey: ['message_logs', ['id']],
  message_logs_rowid_unique: ['message_logs', ['rowid']],
  message_sessions_rowid_unique: ['message_sessions', ['rowid']],
  message_sessions_workspace_id_session_ref_pk: ['message_sessions', ['workspace_id', 'session_ref']],
  messages_pkey: ['messages', ['id']],
  messages_rowid_unique: ['messages', ['rowid']],
  node_providers_node_name_unique: ['node_providers', ['workspace_id', 'node_id', 'name']],
  node_providers_pkey: ['node_providers', ['id']],
  node_providers_rowid_unique: ['node_providers', ['rowid']],
  nodes_pkey: ['nodes', ['id']],
  nodes_rowid_unique: ['nodes', ['rowid']],
  nodes_token_hash_unique: ['nodes', ['token_hash']],
  nodes_workspace_id_unique: ['nodes', ['workspace_id', 'id']],
  nodes_workspace_name_unique: ['nodes', ['workspace_id', 'name']],
  observer_tokens_pkey: ['observer_tokens', ['id']],
  observer_tokens_rowid_unique: ['observer_tokens', ['rowid']],
  observer_tokens_token_hash_unique: ['observer_tokens', ['token_hash']],
  observer_tokens_workspace_name_unique: ['observer_tokens', ['workspace_id', 'name']],
  pending_events_pkey: ['pending_events', ['id']],
  pending_events_rowid_unique: ['pending_events', ['rowid']],
  reactions_message_agent_emoji_unique: ['reactions', ['message_id', 'agent_id', 'emoji']],
  reactions_pkey: ['reactions', ['id']],
  reactions_rowid_unique: ['reactions', ['rowid']],
  idx_read_receipts_retention: ['read_receipts', ['message_id', 'agent_id']],
  read_receipts_message_id_agent_id_pk: ['read_receipts', ['message_id', 'agent_id']],
  read_receipts_rowid_unique: ['read_receipts', ['rowid']],
  routing_configs_pkey: ['routing_configs', ['workspace_id']],
  routing_configs_rowid_unique: ['routing_configs', ['rowid']],
  routing_failures_rowid_unique: ['routing_failures', ['rowid']],
  routing_failures_workspace_id_agent_id_pk: ['routing_failures', ['workspace_id', 'agent_id']],
  session_events_agent_idempotency_unique: ['session_events', ['workspace_id', 'agent_id', 'idempotency_key_hash']],
  session_events_agent_sequence_unique: ['session_events', ['agent_id', 'sequence']],
  session_events_pkey: ['session_events', ['id']],
  session_events_rowid_unique: ['session_events', ['rowid']],
  triggers_pkey: ['triggers', ['id']],
  triggers_rowid_unique: ['triggers', ['rowid']],
  usage_records_pkey: ['usage_records', ['id']],
  usage_records_rowid_unique: ['usage_records', ['rowid']],
  webhook_deliveries_event_subscription_unique: ['webhook_deliveries', ['event_id', 'subscription_id']],
  webhook_deliveries_pkey: ['webhook_deliveries', ['id']],
  webhook_deliveries_rowid_unique: ['webhook_deliveries', ['rowid']],
  webhooks_pkey: ['webhooks', ['id']],
  webhooks_rowid_unique: ['webhooks', ['rowid']],
  webhooks_workspace_name_unique: ['webhooks', ['workspace_id', 'name']],
  workspace_create_idempotency_owner_scope_hash_idempotency_key_h: ['workspace_create_idempotency', ['owner_scope_hash', 'idempotency_key_hash']],
  workspace_create_idempotency_rowid_unique: ['workspace_create_idempotency', ['rowid']],
  workspace_create_idempotency_workspace_unique: ['workspace_create_idempotency', ['workspace_id']],
  workspace_events_rowid_unique: ['workspace_events', ['rowid']],
  workspace_events_workspace_id_seq_pk: ['workspace_events', ['workspace_id', 'seq']],
  workspaces_api_key_hash_unique: ['workspaces', ['api_key_hash']],
  workspaces_pkey: ['workspaces', ['id']],
  workspaces_rowid_unique: ['workspaces', ['rowid']],
});

/** Which uniqueness rule a write violated: the table and the columns it covers. */
export interface DatabaseUniqueViolation {
  table: string;
  columns: readonly string[];
  /** The PostgreSQL constraint or index name; absent on SQLite, which does not report it. */
  constraint?: string;
}

const SQLITE_UNIQUE_CODES = new Set(['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY']);

/**
 * Decode a unique or primary-key violation anywhere in the `.cause` chain.
 * PostgreSQL: SQLSTATE 23505 in schema `relaycast`, looked up by the
 * `constraint` field in {@link PG_UNIQUE_CONSTRAINTS} (an unmapped name
 * decodes as undefined, never as a guess). SQLite: the extended result code,
 * or the bare `SQLITE_CONSTRAINT` code / a D1-wrapped message, with the
 * `UNIQUE constraint failed: t.a, t.b` column list. Returns undefined for
 * anything else. No engine caller uses this yet; the per-table unique
 * detectors in src/engine are SQLite-only today.
 */
export function databaseUniqueViolation(error: unknown): DatabaseUniqueViolation | undefined {
  return walkCauses(error, (record) => {
    const sqlState = pgSqlState(record);
    if (sqlState !== undefined) {
      if (sqlState !== '23505' || record.schema !== PG_ENGINE_SCHEMA || typeof record.constraint !== 'string') return undefined;
      if (!Object.hasOwn(PG_UNIQUE_CONSTRAINTS, record.constraint)) return undefined;
      const [table, columns] = PG_UNIQUE_CONSTRAINTS[record.constraint];
      return { table, columns, constraint: record.constraint };
    }
    const message = typeof record.message === 'string' ? record.message : '';
    const codeMatches = typeof record.code === 'string' && (SQLITE_UNIQUE_CODES.has(record.code) || record.code === 'SQLITE_CONSTRAINT');
    const match = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/.exec(message);
    if (!match || (record.code !== undefined && !codeMatches)) return undefined;
    const qualified = match[1].split(', ');
    const table = qualified[0].split('.')[0];
    return { table, columns: qualified.map((name) => name.slice(name.indexOf('.') + 1)) };
  });
}

/**
 * Integrity triggers on agent_node_bindings (SQLite migrations/0024 and
 * migrations-pg/0001_triggers.sql) refuse a binding whose agent or node
 * belongs to another workspace. Neither dialect's trigger emits a table,
 * column or constraint field, only a fixed message, so this matches the
 * exact message text: on PostgreSQL only with SQLSTATE 23000
 * (integrity_constraint_violation, the trigger's ERRCODE) and an exactly
 * equal message; on SQLite the RAISE(ABORT) text, which D1 may wrap.
 */
export type DatabaseTriggerRefusal = 'binding_agent_workspace_mismatch' | 'binding_node_workspace_mismatch';

export const TRIGGER_REFUSAL_MESSAGES: Readonly<Record<string, DatabaseTriggerRefusal>> = Object.freeze({
  'agent_node_bindings workspace/agent mismatch': 'binding_agent_workspace_mismatch',
  'agent_node_bindings workspace/node mismatch': 'binding_node_workspace_mismatch',
});

export function databaseTriggerRefusal(error: unknown): DatabaseTriggerRefusal | undefined {
  return walkCauses(error, (record) => {
    const message = typeof record.message === 'string' ? record.message : '';
    const sqlState = pgSqlState(record);
    if (sqlState !== undefined) {
      return sqlState === '23000' && Object.hasOwn(TRIGGER_REFUSAL_MESSAGES, message)
        ? TRIGGER_REFUSAL_MESSAGES[message]
        : undefined;
    }
    for (const [text, kind] of Object.entries(TRIGGER_REFUSAL_MESSAGES)) {
      if (message.includes(text)) return kind;
    }
    return undefined;
  });
}
