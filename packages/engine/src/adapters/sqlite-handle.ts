/**
 * Branding for SQLite-backed engine handles (node better-sqlite3 / bun:sqlite,
 * durable-actor sqlite-proxy, Cloudflare D1).
 *
 * Every adapter that builds a drizzle SQLite database for the engine passes it
 * through {@link brandSqliteEngineDb} before handing it out. The brand
 * (`engineDialect: 'sqlite'`) is what dialect-dispatched helpers (`db/sqlx.ts`)
 * switch on; an unbranded handle is rejected rather than assumed to be SQLite.
 * The cloud D1 adapter lives outside this package and must call it as well.
 *
 * Branding also binds the process-wide table set (`db/tables.ts`) to SQLite, so
 * a process already bound to another dialect cannot obtain a SQLite handle.
 */
import { is } from 'drizzle-orm';
import { SQLiteDialect } from 'drizzle-orm/sqlite-core';
import { bindSchema } from '../db/tables.js';

export type SqliteBranded<T> = T & { readonly engineDialect: 'sqlite' };

/**
 * Brand a drizzle SQLite database (in place) as an engine handle of dialect
 * `'sqlite'` and return it. Throws if `db` is not a drizzle SQLite database
 * (its own `dialect` object must be a `SQLiteDialect`), or if it already
 * carries a different brand, or if the process schema is bound to another
 * dialect.
 */
export function brandSqliteEngineDb<T extends object>(db: T): SqliteBranded<T> {
  const drizzleDialect = (db as { dialect?: unknown }).dialect;
  if (!is(drizzleDialect, SQLiteDialect)) {
    throw new Error('brandSqliteEngineDb: handle is not a drizzle SQLite database');
  }
  bindSchema('sqlite');
  const existing = (db as { engineDialect?: unknown }).engineDialect;
  if (existing === 'sqlite') return db as SqliteBranded<T>;
  if (existing !== undefined) {
    throw new Error(`brandSqliteEngineDb: handle is already branded ${JSON.stringify(existing)}`);
  }
  Object.defineProperty(db, 'engineDialect', { value: 'sqlite', enumerable: false, writable: false, configurable: false });
  return db as SqliteBranded<T>;
}
