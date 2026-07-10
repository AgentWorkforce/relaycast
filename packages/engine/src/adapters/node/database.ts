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
 * so the engine's `await db.select()...` works unchanged. Only the sync->async
 * surface kind is bridged by the cast here — the run-result type (`RunResult`)
 * is preserved, so {@link NodeEngineDb} stays precisely typed.
 */
export function getSqliteDb(path: string): SqliteDbHandle {
  const sqlite = new Database(path);
  configureSqlite(sqlite, { enableWal: true });
  const db = drizzle(sqlite, { schema }) as unknown as NodeEngineDb;

  // `:memory:` databases are connection-local: a transaction and a raw write
  // share the same connection, so there is no cross-connection lock contention
  // and no event-loop-freezing busy-wait. Keep the shared connection and only
  // serialize transactional callers.
  if (path === ':memory:') {
    attachMemoryTransaction(db, sqlite);
    return { db, sqlite };
  }

  return { db: withFileWriteGate(db, path), sqlite };
}

/** A drizzle handle method or a built statement's executor. */
type DbFn = (...args: unknown[]) => unknown;

/** Serialize a write task onto the shared gate, resolving with its result. */
type WriteGate = <T>(task: () => Promise<T> | T) => Promise<T>;

const noop = (): void => {};

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * `:memory:` transaction capability: interactive transactions on the shared
 * connection, serialized so concurrent callers don't interleave `BEGIN`s.
 */
function attachMemoryTransaction(db: NodeEngineDb, sqlite: Database.Database): void {
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
    txTail = result.then(noop, noop);
    return result;
  };
}

/**
 * File-backed transaction capability plus a single async write gate.
 *
 * better-sqlite3 is synchronous, so a raw write that finds the database locked
 * blocks the entire Node event loop on `busy_timeout`. A transaction body runs
 * async (engine write paths `await` inside it), so it holds `BEGIN IMMEDIATE`'s
 * write lock across awaits on its own short-lived connection. If a raw write on
 * the main connection busy-waits for that lock, the event loop freezes and the
 * lock-holding transaction can never progress to `COMMIT` — the raw write times
 * out with `SQLITE_BUSY` and its losing statement rolls back with the error
 * swallowed by the caller. Under concurrency (two nodes registering at once)
 * this silently drops a provider registration.
 *
 * Funnelling *every* write — raw statement writes on the main connection and
 * transaction bodies alike — through one serialization chain guarantees that no
 * raw write ever executes while a transaction holds the lock. Writes never
 * contend, `busy_timeout` stops being load-bearing, and the transaction always
 * commits. Reads stay ungated: WAL readers never block the single writer.
 */
function withFileWriteGate(db: NodeEngineDb, path: string): NodeEngineDb {
  let writeGate: Promise<unknown> = Promise.resolve();
  const runGated: WriteGate = (task) => {
    const result = writeGate.then(task);
    // The chain must survive an individual failure so later writes still run.
    writeGate = result.then(noop, noop);
    return result;
  };

  // Interactive transactions run on a dedicated short-lived connection so
  // unrelated statements can't join the open transaction. `runAtomicWrites`
  // detects this capability and prefers it over a batch.
  db.withTransaction = <T>(fn: (tx: EngineDb) => Promise<T>): Promise<T> =>
    runGated(async () => {
      const txSqlite = new Database(path);
      try {
        configureSqlite(txSqlite);
        const txDb = drizzle(txSqlite, { schema }) as unknown as EngineDb;
        txSqlite.exec('BEGIN IMMEDIATE');
        try {
          const result = await fn(txDb);
          txSqlite.exec('COMMIT');
          return result;
        } catch (err) {
          if (txSqlite.inTransaction) txSqlite.exec('ROLLBACK');
          throw err;
        }
      } finally {
        txSqlite.close();
      }
    });

  return gateRawWrites(db, runGated);
}

/**
 * Wrap the main-connection handle so raw statement writes route through the
 * write gate. `insert`/`update`/`delete` return lazy drizzle builders, so the
 * builder is wrapped and gated at its execution seam; `run(sql)` executes on
 * call, so the whole call is deferred behind the gate. Reads and every other
 * method run directly against the main connection.
 */
function gateRawWrites(db: NodeEngineDb, runGated: WriteGate): NodeEngineDb {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'run') {
        return (...args: unknown[]) => runGated(() => (value as DbFn).apply(target, args));
      }
      if (prop === 'insert' || prop === 'update' || prop === 'delete') {
        return (...args: unknown[]) =>
          gateWriteBuilder((value as DbFn).apply(target, args) as object, runGated);
      }
      // Binding to `target` keeps read builders and helpers running against the
      // real handle rather than leaking the proxy into their `this`.
      return (value as DbFn).bind(target);
    },
  });
}

/**
 * Wrap a drizzle write-statement builder so its execution runs inside the write
 * gate. Drizzle builders are lazy and thenable — SQL runs only when the promise
 * protocol (`then`/`catch`/`finally`) or an explicit executor (`run`/`execute`/
 * `all`/`get`) fires. Those points are gated; chain methods (`values`/`set`/
 * `where`/`returning`/`onConflict*`) are re-wrapped so whichever stage the
 * caller finally awaits still routes through the gate.
 */
function gateWriteBuilder<B extends object>(builder: B, runGated: WriteGate): B {
  return new Proxy(builder, {
    get(target, prop) {
      const targetThenable = isThenable(target);
      if (targetThenable && (prop === 'then' || prop === 'catch' || prop === 'finally')) {
        // Await the raw builder inside the gate — that is where SQL executes.
        const gated = () => runGated(() => Promise.resolve(target as PromiseLike<unknown>));
        if (prop === 'then') {
          return (onF?: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
            gated().then(onF, onR);
        }
        if (prop === 'catch') {
          return (onR?: (e: unknown) => unknown) => gated().catch(onR);
        }
        return (onFinally?: () => void) => gated().finally(onFinally);
      }
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (targetThenable && (prop === 'execute' || prop === 'run' || prop === 'all' || prop === 'get')) {
        return (...args: unknown[]) => runGated(() => (value as DbFn).apply(target, args));
      }
      return (...args: unknown[]) => {
        const result = (value as DbFn).apply(target, args);
        return isThenable(result) ? gateWriteBuilder(result as object, runGated) : result;
      };
    },
  });
}

function configureSqlite(
  sqlite: Database.Database,
  options: { enableWal?: boolean } = {},
): void {
  if (options.enableWal) sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
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
