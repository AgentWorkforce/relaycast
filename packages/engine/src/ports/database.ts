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

/** Normalize atomic admission sentinels across SQLite adapters (D1 wraps the message).
 * Keep driver-specific error decoding at this port boundary; engine callers use a stable kind.
 */
export type DatabaseConstraintKind = 'mailbox_capacity' | 'workspace_delivery_capacity' | 'a2a_registration_changed' | 'address_changed' | 'node_capacity';

export function databaseConstraintKind(error: unknown): DatabaseConstraintKind | undefined {
  const seen = new Set<unknown>();
  let cause = error;
  while (cause !== null && typeof cause === 'object' && !seen.has(cause)) {
    seen.add(cause);
    const record = cause as { message?: unknown; cause?: unknown };
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
    cause = record.cause;
  }
  return undefined;
}
