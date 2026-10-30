import { drizzle } from 'drizzle-orm/sqlite-proxy';
import * as schema from '../../db/schema.js';
import type { EngineDb, TransactionCapability } from '../../ports/database.js';

/** A value SQLite can bind or return through a durable actor's database. */
export type SqliteValue = string | number | bigint | Uint8Array | null;

/**
 * The durable actor's SQL surface (`this.db` in a durable-actors `Actor`): one
 * statement per call, positional bindings, rows keyed by column name.
 *
 * The runtime owns transactions, so `BEGIN` / `SAVEPOINT` / `COMMIT` /
 * `ROLLBACK` are rejected; the enclosing `@Atomic` actor call is the
 * transaction.
 */
export interface ActorSql {
  exec(sql: string, ...bindings: SqliteValue[]): object[];
}

/** Engine handle over an actor's database. `withTransaction` joins the actor call's transaction. */
export type ActorEngineDb = EngineDb & TransactionCapability;

/**
 * Observes every statement the shim executes, so a write group can tell
 * whether it changed anything before it failed.
 */
export interface StatementObserver {
  onWrite(): void;
}

const INTEGER_KEY = /^(?:0|[1-9]\d*)$/;
const STATEMENT_VERBS = new Set(['SELECT', 'VALUES', 'INSERT', 'REPLACE', 'UPDATE', 'DELETE']);

/**
 * The verb of the statement `sql` runs: its first keyword, or for a `WITH`
 * statement the first statement keyword after the common table expressions
 * (`WITH x AS (...) INSERT ...` is an INSERT). Comments, literals and
 * parenthesized text are skipped.
 */
export function statementVerb(sql: string): string | undefined {
  let depth = 0;
  let sawWith = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      const end = sql.indexOf(ch === '[' ? ']' : ch, i + 1);
      i = end === -1 ? sql.length : end + 1;
    } else if (ch === '(') {
      depth += 1;
      i += 1;
    } else if (ch === ')') {
      depth -= 1;
      i += 1;
    } else if (/[A-Za-z_]/.test(ch)) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))![0];
      i += word.length;
      if (depth > 0) continue;
      const upper = word.toUpperCase();
      if (!sawWith) {
        if (upper !== 'WITH') return upper;
        sawWith = true;
      } else if (STATEMENT_VERBS.has(upper)) {
        return upper;
      }
    } else {
      i += 1;
    }
  }
  return undefined;
}

/** Whether `sql` is a query whose result columns the shim must recover by position. */
export function isReadStatement(sql: string): boolean {
  const verb = statementVerb(sql);
  return verb === 'SELECT' || verb === 'VALUES';
}

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

/** Run one statement, giving runtime constraint errors the `code` the engine classifies by. */
function exec(sql: ActorSql, statement: string, bindings: SqliteValue[]): object[] {
  try {
    return sql.exec(statement, ...bindings);
  } catch (error) {
    if (error instanceof Error && !(error as { code?: unknown }).code) {
      const match = RUNTIME_ERROR_CODE.exec(error.message);
      const code = match ? SQLITE_CONSTRAINT_CODES[Number(match[1])] : undefined;
      if (code) Object.assign(error, { code });
    }
    throw error;
  }
}

/** Column names and values of `row`, in result-column order when its names are not integer-like. */
function rowEntries(row: object): { columns: string[]; values: unknown[] } {
  const columns = Object.keys(row);
  const record = row as Record<string, unknown>;
  return { columns, values: columns.map((column) => record[column]) };
}

/**
 * JS enumerates integer-like keys ("0", "1", ...) before every other key, so
 * a row object with such a key next to other columns no longer says where the
 * integer-named column sat. Drizzle emits unaliased literals (`select "id", 0`)
 * this way.
 */
function hasAmbiguousOrder(columns: readonly string[]): boolean {
  return columns.length > 1 && columns.some((column) => INTEGER_KEY.test(column));
}

/**
 * A row as both drizzle consumers read it: query builders map by position,
 * raw `db.all(sql\`...\`)` callers read by column name.
 */
function positionalRow(row: object, sql: string): unknown[] {
  const { columns, values } = rowEntries(row);
  const out: unknown[] = [...values];
  const named = out as unknown as Record<string, unknown>;
  // For duplicate result names SQLite suffixes later columns (`id`, `id:1`);
  // the first occurrence keeps the plain name, as a by-name reader expects.
  // An integer-like name would overwrite an array slot, so it is positional only.
  columns.forEach((column, index) => {
    if (INTEGER_KEY.test(column) || Object.hasOwn(named, column)) return;
    if (column === 'length') throw new Error(`Actor SQL result column "length" must be aliased: ${sql.slice(0, 200)}`);
    named[column] = values[index];
  });
  return out;
}

/**
 * Column counts of reads whose results have integer-named columns, by SQL
 * text. Those reads run with positional column names (`c0`, `c1`, ...) from
 * the start once seen. Drizzle builds SQL from a fixed set of call sites, so
 * the set is small; the bound only guards against unbounded raw SQL.
 */
const POSITIONAL_SHAPES_LIMIT = 1_000;
const positionalShapes = new Map<string, number>();

function positionalRead(body: string, count: number): string {
  const names = Array.from({ length: count }, (_, index) => `c${index}`).join(', ');
  return `WITH __actor_positional(${names}) AS (${body}) SELECT * FROM __actor_positional`;
}

function execRenamed(sql: ActorSql, body: string, count: number, bindings: SqliteValue[]): unknown[][] {
  return exec(sql, positionalRead(body, count), bindings).map((row) => rowEntries(row).values);
}

/**
 * Execute one statement and return positional rows.
 *
 * `exec` keys rows by column name, so a join that repeats a name
 * (`SELECT a.id, b.id`) collapses to one value. Reads are therefore run as
 * `SELECT * FROM (<sql>)`: SQLite names the subquery's columns uniquely
 * (`id`, `id:1`), and the values come back in column order. The wrapper adds
 * no outer `ORDER BY`; SQLite keeps the subquery's order for a plain
 * `SELECT *` over it.
 *
 * When a result has integer-named columns, the read runs again as
 * `WITH __actor_positional(c0, c1, ...) AS (<sql>) SELECT * ...`, which names
 * every column by position. Such rows are positional only: raw by-name
 * readers must alias literal columns.
 *
 * Writes (including `RETURNING`) run unchanged: their result columns come from
 * one table and are unique.
 */
export function execPositional(
  sql: ActorSql,
  statement: string,
  params: readonly unknown[],
  observer?: StatementObserver,
): unknown[][] {
  const bindings = params as SqliteValue[];
  if (!isReadStatement(statement)) {
    const rows = exec(sql, statement, bindings);
    observer?.onWrite();
    return rows.map((row) => positionalRow(row, statement));
  }

  const body = statement.replace(/;\s*$/, '');
  const knownCount = positionalShapes.get(statement);
  if (knownCount !== undefined) return execRenamed(sql, body, knownCount, bindings);

  const rows = exec(sql, `SELECT * FROM (${body})`, bindings);
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  if (!hasAmbiguousOrder(columns)) return rows.map((row) => positionalRow(row, statement));

  if (positionalShapes.size >= POSITIONAL_SHAPES_LIMIT) positionalShapes.clear();
  positionalShapes.set(statement, columns.length);
  return execRenamed(sql, body, columns.length, bindings);
}

/**
 * Build the engine's Drizzle handle over an actor database.
 *
 * `withTransaction` runs its body directly: the enclosing `@Atomic` actor
 * call is already one SQLite transaction. `runGroup` decides what a failed
 * group means for that call (see `ActorCallScope`).
 */
export function createActorEngineDb(
  sql: ActorSql,
  options: {
    observer?: StatementObserver;
    runGroup: <T>(body: () => Promise<T>) => Promise<T>;
  },
): ActorEngineDb {
  const db = drizzle(
    async (statement, params, method) => {
      const rows = execPositional(sql, statement, params, options.observer);
      if (method === 'run') return { rows: [] };
      // `get` resolves one row (or undefined); drizzle types it as an array.
      if (method === 'get') return { rows: rows[0] as unknown as unknown[] };
      return { rows };
    },
    { schema },
  ) as unknown as ActorEngineDb;
  db.withTransaction = <T>(fn: (tx: EngineDb) => Promise<T>): Promise<T> =>
    options.runGroup(() => fn(db));
  return db;
}
