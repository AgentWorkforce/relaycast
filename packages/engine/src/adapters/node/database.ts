import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database, { type RunResult } from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '../../db/schema.js';
import type { EngineDb, TransactionCapability } from '../../ports/database.js';

/**
 * The engine handle specialized to better-sqlite3's synchronous run-result,
 * with the optional transaction capability attached (better-sqlite3 supports
 * interactive transactions, unlike D1).
 */
export type NodeEngineDb = EngineDb<RunResult> & TransactionCapability;

export interface SqliteDbHandle {
  db: NodeEngineDb;
  /** The raw better-sqlite3 connection (for migrations, pragmas, backups). */
  sqlite: Database.Database;
}

/**
 * Open a SQLite-backed {@link EngineDb} for self-host. Pass a file path
 * (created if absent) or `':memory:'` for tests. Sets WAL + foreign keys.
 *
 * The better-sqlite3 driver is synchronous; Drizzle query builders are thenable
 * so the engine's `await db.select()...` works unchanged. Only the sync→async
 * surface kind is bridged by the cast here — the run-result type (`RunResult`)
 * is preserved, so {@link NodeEngineDb} stays precisely typed.
 */
export function getSqliteDb(path: string): SqliteDbHandle {
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema }) as unknown as NodeEngineDb;

  // Attach the transaction capability (`runAtomic` detects it on the handle).
  //
  // Drizzle's better-sqlite3 `db.transaction()` requires a synchronous
  // callback (better-sqlite3's native wrapper commits when the sync call
  // returns), but engine write paths are async, so we manage the transaction
  // manually on the shared connection. Transactions are serialized through a
  // promise queue: better-sqlite3 is a single connection, and an unrelated
  // request's statement issued during one of `fn`'s awaits would otherwise
  // join (and roll back with) the open transaction. Serializing `withTransaction`
  // callers closes that window for the multi-statement write paths, which all
  // run through it.
  let txTail: Promise<unknown> = Promise.resolve();
  db.withTransaction = <T>(fn: (tx: EngineDb) => Promise<T>): Promise<T> => {
    const run = async (): Promise<T> => {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await fn(db as unknown as EngineDb);
        sqlite.exec('COMMIT');
        return result;
      } catch (err) {
        if (sqlite.inTransaction) sqlite.exec('ROLLBACK');
        throw err;
      }
    };
    const result = txTail.then(run);
    txTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return { db, sqlite };
}

function migrationsDir(): string {
  // dist/adapters/node/database.js -> dist/db/migrations
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '../../db/migrations'),
    join(here, '../../../src/db/migrations'),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return candidates[0];
}

/**
 * Apply the engine's SQL migrations to a fresh/old SQLite database, in order.
 * Tracks applied files in a `_engine_migrations` table so repeated boots are
 * idempotent. Runs each migration file as a single script.
 */
export function runMigrations(handle: SqliteDbHandle): { applied: string[] } {
  const { sqlite } = handle;
  sqlite.exec(
    `CREATE TABLE IF NOT EXISTS _engine_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`,
  );
  const done = new Set<string>(
    sqlite
      .prepare(`SELECT name FROM _engine_migrations`)
      .all()
      .map((r) => (r as { name: string }).name),
  );

  const dir = migrationsDir();
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied: string[] = [];
  const insert = sqlite.prepare(
    `INSERT INTO _engine_migrations (name, applied_at) VALUES (?, ?)`,
  );

  for (const file of files) {
    if (done.has(file)) continue;
    // drizzle-kit separates statements with `--> statement-breakpoint`; SQLite's
    // `exec` runs the whole script. Apply the DDL and record the migration as
    // applied in one transaction so a crash mid-migration can't leave the schema
    // changed but unrecorded (which would replay and fail on the next boot).
    // drizzle migrations never contain their own BEGIN/COMMIT, so this won't nest.
    const ddl = readFileSync(join(dir, file), 'utf8').replace(/-->\s*statement-breakpoint/g, '');
    const applyOne = sqlite.transaction(() => {
      sqlite.exec(ddl);
      insert.run(file, Math.floor(Date.now() / 1000));
    });
    applyOne();
    applied.push(file);
  }

  return { applied };
}
