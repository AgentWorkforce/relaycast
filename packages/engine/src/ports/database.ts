import type { BatchItem } from 'drizzle-orm/batch';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from '../db/schema.js';

/**
 * Driver-agnostic Drizzle handle used by every engine module.
 *
 * Both the Cloudflare D1 driver (`drizzle-orm/d1`, async) and the Node
 * better-sqlite3 driver (`drizzle-orm/better-sqlite3`, sync) produce a
 * `BaseSQLiteDatabase` over the shared schema. Drizzle query builders are
 * thenable, so `await db.select()...` works against both. The engine never
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
// The engine is written against the async surface (everything is `await`ed),
// which is exactly what the D1 driver produces, so the Cloudflare adapter's
// handle is assignable directly. The Node better-sqlite3 driver is synchronous;
// `await` on its thenable builders works at runtime, and the Node adapter casts
// its handle to this type once at construction.
//
// The second parameter is `TRunResult` — the return type of `db.run(...)`. The
// drivers disagree on it (better-sqlite3: `{ changes, lastInsertRowid }`; D1:
// `D1Result`) and share no common shape, so no single concrete type fits both,
// and naming either here would drag a platform's types into the agnostic engine.
//
// So we leave it as a type parameter, defaulting to `unknown`. Engine core uses
// the bare `EngineDb` (i.e. `EngineDb<unknown>`) and never calls `.run()` or
// reads a run result, so it stays platform-free. Each adapter specializes it
// with its own driver's result type (the Node adapter -> `EngineDb<RunResult>`),
// importing only that platform's types, so the precise run-result type flows all
// the way through on that side without the engine ever depending on it.
export type EngineDb<TRunResult = unknown> = BaseSQLiteDatabase<'async', TRunResult, typeof schema>;

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

/**
 * A built-but-unexecuted Drizzle write statement.
 *
 * Drizzle query builders are lazy: constructing one issues no SQL until it is
 * awaited (it is a thenable) or handed to a D1-style `batch()`.
 */
export type AtomicWrite = BatchItem<'sqlite'> & PromiseLike<unknown>;

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
  const { withTransaction } = db as EngineDb & Partial<TransactionCapability>;
  return withTransaction ? withTransaction(fn) : fn(db);
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
 *     historical behavior for bare handles.
 *
 * Returns the per-statement results in order, so callers can recover
 * `.returning()` rows by index. Statements must not depend on each other's
 * DB-returned values (IDs are app-generated snowflakes), because under a batch
 * nothing is visible until every statement has executed.
 */
export async function runAtomicWrites(
  db: EngineDb,
  input: AtomicWriteInput,
): Promise<unknown[]> {
  const handle = db as EngineDb & Partial<TransactionCapability> & Partial<BatchCapability>;
  if (handle.withTransaction) {
    return handle.withTransaction(async (tx) => {
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
