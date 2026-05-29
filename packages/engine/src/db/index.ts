import { sql } from 'drizzle-orm';
import type { EngineDb } from '../ports/database.js';

/**
 * The engine never constructs a database driver itself — an adapter does, and
 * injects the handle as the `db` port. This identity helper exists only so the
 * many engine modules that write `type Db = ReturnType<typeof getDb>` keep a
 * single canonical alias for {@link EngineDb} without importing a concrete
 * driver (which would pull `better-sqlite3` / `drizzle-orm/d1` into every
 * bundle). Construct real handles with `getSqliteDb` (Node adapter) or the
 * Cloudflare D1 driver (cloud adapter).
 */
export function getDb(db: EngineDb): EngineDb {
  return db;
}

/** Canonical database type used across the engine. */
export type Db = EngineDb;

/** Health check — run a trivial query to verify connectivity. */
export async function healthCheck(db: EngineDb): Promise<boolean> {
  try {
    await db.run(sql`SELECT 1`);
    return true;
  } catch {
    return false;
  }
}
