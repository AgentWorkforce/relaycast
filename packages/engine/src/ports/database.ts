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
 * The one place the drivers genuinely diverge is interactive transactions:
 * better-sqlite3 supports them; D1 has no interactive transactions and relies
 * on `db.batch()`. Adapters whose driver supports transactions may attach the
 * optional {@link TransactionCapability} to the handle; engine multi-statement
 * write paths go through {@link runAtomic}, which uses the capability when
 * present and otherwise falls back to plain sequential statements (today's D1
 * behavior). Cross-row invariants that must hold on *every* adapter — not just
 * transaction-capable ones — still need single-statement atomicity (e.g. a
 * `... SELECT COALESCE(MAX(seq),0)+1 ...` scalar-subquery insert guarded by a
 * UNIQUE index) rather than a multi-step read-modify-write.
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
// with its own driver's result type (the Node adapter → `EngineDb<RunResult>`),
// importing only that platform's types, so the precise run-result type flows all
// the way through on that side without the engine ever depending on it.
export type EngineDb<TRunResult = unknown> = BaseSQLiteDatabase<'async', TRunResult, typeof schema>;

/**
 * Optional atomicity capability an adapter may attach to its {@link EngineDb}
 * handle when the underlying driver supports interactive transactions.
 *
 * Semantics: `fn` runs inside a single transaction; if it throws, every
 * statement issued through `tx` is rolled back, and the error is rethrown.
 * Adapters that cannot provide this (Cloudflare D1) simply omit the capability,
 * and {@link runAtomic} degrades to running `fn` directly — sequential
 * statements with no rollback, exactly the engine's historical behavior.
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
 * Run `fn` atomically when the handle exposes {@link TransactionCapability},
 * otherwise run it directly (plain sequential statements). Engine write paths
 * that span multiple statements call this instead of assuming either driver.
 */
export function runAtomic<T>(db: EngineDb, fn: (tx: EngineDb) => Promise<T>): Promise<T> {
  const { withTransaction } = db as EngineDb & Partial<TransactionCapability>;
  return withTransaction ? withTransaction(fn) : fn(db);
}
