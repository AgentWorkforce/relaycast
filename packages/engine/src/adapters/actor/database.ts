import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../../db/schema.js';
import type { EngineDb, TransactionCapability } from '../../ports/database.js';

/** A value SQLite can bind or return through a durable actor's database. */
export type SqliteValue = string | number | bigint | Uint8Array | null;

/**
 * An actor's database as `this.db` types it: `exec` and nested `transaction`.
 * The runtime object also carries `query` (durable-actors >= 0.14.5, the
 * method `durable-actors/drizzle` runs on), which `createActorRuntime` checks
 * for.
 */
export interface ActorDatabase {
  exec(sql: string, ...bindings: SqliteValue[]): object[];
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

/**
 * The durable actor's SQL surface at runtime (durable-actors >= 0.14.5): one
 * statement per call, positional bindings, and nested transactions on runtime
 * savepoints.
 */
export interface ActorSql extends ActorDatabase {
  /** Run one statement; rows keyed by column name. */
  exec(sql: string, ...bindings: SqliteValue[]): object[];
  /** Run one statement; rows as value arrays in column order. */
  query(sql: string, ...bindings: SqliteValue[]): { columns: string[]; rows: SqliteValue[][] };
  /** Run `operation` in a nested transaction: if it throws, only its writes roll back. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
}

/** Engine handle over an actor's database. `withTransaction` is a runtime savepoint. */
export type ActorEngineDb = EngineDb & TransactionCapability;

/**
 * SQLite extended result codes for constraint failures, by the names
 * better-sqlite3 reports in `error.code`. The actor runtime reports only the
 * number, inside the message (`UNIQUE constraint failed: t.c: Error code 2067:
 * constraint failed`), and engine classifiers read `code`.
 */
export const SQLITE_CONSTRAINT_CODES: Readonly<Record<number, string>> = {
  19: 'SQLITE_CONSTRAINT',
  275: 'SQLITE_CONSTRAINT_CHECK',
  531: 'SQLITE_CONSTRAINT_COMMITHOOK',
  787: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  1043: 'SQLITE_CONSTRAINT_FUNCTION',
  1299: 'SQLITE_CONSTRAINT_NOTNULL',
  1555: 'SQLITE_CONSTRAINT_PRIMARYKEY',
  1811: 'SQLITE_CONSTRAINT_TRIGGER',
  2067: 'SQLITE_CONSTRAINT_UNIQUE',
  2323: 'SQLITE_CONSTRAINT_VTAB',
  2579: 'SQLITE_CONSTRAINT_ROWID',
};

const RUNTIME_ERROR_CODE = /: Error code (\d+): /;
const INTEGER_KEY = /^(?:0|[1-9]\d*)$/;

/** Run one statement, giving runtime constraint errors the `code` engine classifiers read. */
function query(sql: ActorSql, statement: string, params: readonly unknown[]): { columns: string[]; rows: SqliteValue[][] } {
  try {
    return sql.query(statement, ...params.map(binding));
  } catch (error) {
    if (error instanceof Error && !(error as { code?: unknown }).code) {
      const match = RUNTIME_ERROR_CODE.exec(error.message);
      const code = match ? SQLITE_CONSTRAINT_CODES[Number(match[1])] : undefined;
      if (code) Object.assign(error, { code });
    }
    throw error;
  }
}

function binding(value: unknown): SqliteValue {
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value as SqliteValue;
}

/**
 * A row as both drizzle consumers read it: query builders map by position,
 * raw `db.all(sql\`...\`)` callers read by column name. A repeated name keeps
 * its first column; an integer-like name would overwrite an array slot, so it
 * is positional only.
 */
function namedRow(columns: readonly string[], values: SqliteValue[]): unknown[] {
  const named = values as unknown as Record<string, unknown>;
  columns.forEach((column, index) => {
    if (INTEGER_KEY.test(column) || column === 'length' || Object.hasOwn(named, column)) return;
    named[column] = values[index];
  });
  return values;
}

/**
 * Build the engine's Drizzle handle over an actor database: statements run
 * through `query` (positional rows), and `withTransaction` is a nested actor
 * transaction, so a failed write group rolls back alone and the call goes on.
 * `onGroupStart` sees every write group open, `onGroupFailure` every one
 * that rolled back.
 */
export function createActorEngineDb(
  sql: ActorSql,
  options: { onGroupStart?: () => void; onGroupFailure?: (error: unknown) => void } = {},
): ActorEngineDb {
  const db = drizzle(
    async (statement, params, method) => {
      const { columns, rows } = query(sql, statement, params);
      if (method === 'run') return { rows: [] };
      const named = rows.map((row) => namedRow(columns, row));
      // `get` resolves one row (or undefined); drizzle types it as an array.
      if (method === 'get') return { rows: named[0] as unknown as unknown[] };
      return { rows: named };
    },
    { schema },
  ) as unknown as ActorEngineDb;
  db.withTransaction = <T>(fn: (tx: EngineDb) => Promise<T>): Promise<T> => {
    options.onGroupStart?.();
    return sql.transaction(() => fn(db)).catch((error: unknown) => {
      options.onGroupFailure?.(error);
      throw error;
    });
  };
  return db;
}
