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
 * better-sqlite3 runs them synchronously; D1 has no interactive transactions
 * and relies on `db.batch()`. Engine code that needs atomicity across rows must
 * use a single statement (e.g. a `... SELECT COALESCE(MAX(seq),0)+1 ...`
 * scalar-subquery insert guarded by a UNIQUE index) rather than a multi-step
 * read-modify-write, so the same code is correct on both drivers.
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
