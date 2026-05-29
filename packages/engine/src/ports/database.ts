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
// its handle to this type once at construction. Result type is left `any` so we
// don't pull a D1-specific result type (and thus `@cloudflare/workers-types`)
// into the platform-agnostic engine.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EngineDb = BaseSQLiteDatabase<'async', any, typeof schema>;
