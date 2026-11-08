/**
 * Dialect-dispatched raw SQL execution.
 *
 * Engine code that runs hand-written SQL goes through these helpers rather than
 * calling a driver method directly: `db.all`/`db.run` exist only on drizzle's
 * SQLite databases, and PostgreSQL executes raw SQL with `execute()`. Each
 * helper switches on the handle's `engineDialect` brand (attached by the
 * adapter that built the handle) and throws for an unbranded or unknown
 * dialect -- there is no silent SQLite fallback.
 *
 * The fragment helpers further down cover the individual SQLite-isms: each one
 * takes a handle (or a dialect name) and returns a drizzle `SQL` fragment whose
 * SQLite text is exactly what engine code wrote inline before, and whose
 * PostgreSQL text is the equivalent for the relaycast PG schema (jsonb JSON
 * columns, bigint epoch seconds, native booleans, an explicit `rowid` identity
 * column on every table). Engine code may not spell those SQLite-isms inline;
 * an ESLint rule enforces it.
 */
import { getTableColumns, is, SQL, sql, type Column, type Query, type SQLWrapper, type Table } from 'drizzle-orm';
import { PgDialect, QueryBuilder as PgQueryBuilder, PgTransaction } from 'drizzle-orm/pg-core';
import type { EngineDatabase, EngineDialect, EngineQueryBuilder, EngineWrite, InsertSelectSource } from '../ports/engineDb.js';
import { currentSchemaDialect } from './tables.js';

/** The SQLite raw executors (drizzle `BaseSQLiteDatabase`; sync drivers return values, async ones promises). */
interface SqliteRawExecutor {
  all<T>(query: SQL): Promise<T[]> | T[];
  run(query: SQL): unknown;
}

/** The PostgreSQL raw executor (drizzle `PgDatabase.execute`, node-postgres result shape). */
interface PgRawExecutor {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
}

/** Read the dialect brand of a handle, failing closed when it is missing or unknown. */
export function engineDialectOf(db: object): EngineDialect {
  const dialect = (db as { engineDialect?: unknown }).engineDialect;
  if (dialect === 'sqlite' || dialect === 'pg') return dialect;
  throw new Error(
    `Database handle has no supported engineDialect brand (got ${JSON.stringify(dialect) ?? 'undefined'}); ` +
      'the adapter that builds the handle must brand it (see brandSqliteEngineDb)',
  );
}

/** Run `query` and return every result row (column-name keyed objects). */
export async function all<T = unknown>(db: object, query: SQL): Promise<T[]> {
  const dialect = engineDialectOf(db);
  switch (dialect) {
    case 'sqlite':
      return await (db as SqliteRawExecutor).all<T>(query);
    case 'pg': {
      const result = await (db as PgRawExecutor).execute(query);
      if (!result || !Array.isArray(result.rows)) {
        throw new Error('PostgreSQL execute() returned no rows array; expected a node-postgres style result');
      }
      return result.rows as T[];
    }
    default:
      return unsupported(dialect);
  }
}

/** Run `query` for its effect; the driver's run result is not exposed. */
export async function run(db: object, query: SQL): Promise<void> {
  const dialect = engineDialectOf(db);
  switch (dialect) {
    case 'sqlite':
      await (db as SqliteRawExecutor).run(query);
      return;
    case 'pg':
      await (db as PgRawExecutor).execute(query);
      return;
    default:
      return unsupported(dialect);
  }
}

function unsupported(dialect: never): never {
  throw new Error(`Unsupported engine dialect: ${String(dialect)}`);
}

// ---------------------------------------------------------------------------
// Dialect-dispatched SQL fragments
// ---------------------------------------------------------------------------

/** A handle carrying an `engineDialect` brand, or the dialect name itself. */
export type DialectSource = object | EngineDialect;

type Fragment = SQLWrapper | SQL;

/** Resolve a handle or dialect name to a dialect, failing closed for anything else. */
export function dialectOf(source: DialectSource): EngineDialect {
  if (typeof source === 'string') {
    if (source === 'sqlite' || source === 'pg') return source;
    throw new Error(`Unsupported engine dialect: ${JSON.stringify(source)}`);
  }
  if (source === null || typeof source !== 'object') {
    throw new Error('sqlx: expected a branded database handle or a dialect name');
  }
  return engineDialectOf(source);
}

/**
 * The dialect this process's table exports are bound to (db/tables.ts), for
 * SQL builders that interpolate those tables but have no handle in scope.
 * Throws before any handle has been branded.
 */
export function schemaDialect(): EngineDialect {
  const dialect = currentSchemaDialect();
  if (dialect === undefined) {
    throw new Error('sqlx.schemaDialect(): no engine dialect is bound in this process (brand a handle first)');
  }
  return dialect;
}

/** Pick the fragment for the source's dialect; no branch is a default. */
function pick<T>(source: DialectSource, forms: { sqlite: () => T; pg: () => T }): T {
  const dialect = dialectOf(source);
  switch (dialect) {
    case 'sqlite':
      return forms.sqlite();
    case 'pg':
      return forms.pg();
    default:
      return unsupported(dialect);
  }
}

/** Thrown when an engine path that only exists on SQLite is reached on PostgreSQL. */
export class UnsupportedOnPostgresError extends Error {
  readonly code = 'unsupported_on_postgres' as const;
  constructor(readonly feature: string, detail?: string) {
    super(`${feature} is not supported on PostgreSQL${detail ? `: ${detail}` : ''}`);
    this.name = 'UnsupportedOnPostgresError';
  }
}

/** Throw {@link UnsupportedOnPostgresError} when `source` is PostgreSQL; return otherwise. */
export function requireSqlite(source: DialectSource, feature: string, detail?: string): void {
  pick(source, {
    sqlite: () => undefined,
    pg: () => {
      throw new UnsupportedOnPostgresError(feature, detail);
    },
  });
}

// --- identifiers and JSON paths --------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function identifier(name: string, what: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`sqlx: invalid ${what} ${JSON.stringify(name)}`);
  return name;
}

const JSON_PATH = /^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/;

/** Validate a `$.a.b` path and return its keys. */
function jsonPathKeys(path: string): string[] {
  if (!JSON_PATH.test(path)) throw new Error(`sqlx: unsupported JSON path ${JSON.stringify(path)} (expected $.key[.key...])`);
  return path.slice(2).split('.');
}

/** `'{a,b}'` text-array literal for PostgreSQL `#>`/`#>>`/`jsonb_set`. */
function pgPathText(path: string): string {
  return `{${jsonPathKeys(path).join(',')}}`;
}

/**
 * A JSON path argument. A plain string is validated and inlined as a literal;
 * `{ bind: path }` binds it as a parameter (on PostgreSQL as a `text[]`).
 */
export type JsonPath = string | { readonly bind: string };

function sqlitePath(path: JsonPath): SQL {
  if (typeof path === 'string') {
    jsonPathKeys(path);
    return sql.raw(`'${path}'`);
  }
  jsonPathKeys(path.bind);
  return sql`${path.bind}`;
}

function pgPath(path: JsonPath): SQL {
  return typeof path === 'string'
    ? sql.raw(`'${pgPathText(path)}'`)
    : sql`${pgPathText(path.bind)}::text[]`;
}

// --- time ------------------------------------------------------------------

/** Current time as integer epoch seconds: `unixepoch()`. */
export function now(source: DialectSource): SQL<number> {
  return pick(source, {
    sqlite: () => sql<number>`unixepoch()`,
    // Truncated (like unixepoch()), statement-stable like the PG column defaults.
    pg: () => sql<number>`floor(extract(epoch from statement_timestamp()))::bigint`,
  });
}

/**
 * `unixepoch(expr)` on an epoch-seconds column. Note SQLite reads a bare
 * integer argument as a Julian day number, so on integer columns this is NULL
 * on SQLite; the text is kept as written. PostgreSQL returns the epoch itself.
 */
export function epochOf(source: DialectSource, expr: Fragment): SQL<number | null> {
  return pick(source, {
    sqlite: () => sql<number | null>`unixepoch(${expr})`,
    pg: () => sql<number | null>`(${expr})`,
  });
}

/** Render epoch seconds as text, in the format a site already produces on SQLite. */
export type EpochTextFormat =
  /** `strftime('%Y-%m-%dT%H:%M:%fZ', x, 'unixepoch')`: `2026-01-02T03:04:05.000Z` */
  | 'iso-ms'
  /** `datetime(x, 'unixepoch')`: `2026-01-02 03:04:05` */
  | 'datetime';

export function isoFromEpoch(source: DialectSource, expr: Fragment, format: EpochTextFormat): SQL<string | null> {
  return pick(source, {
    sqlite: () => format === 'iso-ms'
      ? sql<string | null>`strftime('%Y-%m-%dT%H:%M:%fZ', ${expr}, 'unixepoch')`
      : sql<string | null>`datetime(${expr}, 'unixepoch')`,
    pg: () => format === 'iso-ms'
      ? sql<string | null>`to_char(to_timestamp(${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
      : sql<string | null>`to_char(to_timestamp(${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,
  });
}

// --- JSON ------------------------------------------------------------------

/** `json_extract(expr, path)`; on PostgreSQL the text value (`#>>`). */
export function jsonGet(source: DialectSource, expr: Fragment, path: JsonPath): SQL<unknown> {
  return pick(source, {
    sqlite: () => sql`json_extract(${expr}, ${sqlitePath(path)})`,
    pg: () => sql`((${expr})::jsonb #>> ${pgPath(path)})`,
  });
}

/** {@link jsonGet} for numeric comparisons: identical on SQLite, `::numeric` on PostgreSQL. */
export function jsonGetNum(source: DialectSource, expr: Fragment, path: JsonPath): SQL<number | null> {
  return pick(source, {
    sqlite: () => sql<number | null>`json_extract(${expr}, ${sqlitePath(path)})`,
    pg: () => sql<number | null>`((${expr})::jsonb #>> ${pgPath(path)})::numeric`,
  });
}

/**
 * Table-valued expansion of a JSON array, with `value` and `key` columns.
 * `alias` is appended on SQLite exactly as written at the site (`' AS cap'`,
 * `' je'`, or `''`); on PostgreSQL it names the derived table, with columns
 * `(value, key)`. `elements: 'text'` yields text values (arrays of strings),
 * `'json'` yields jsonb values (arrays of objects).
 */
export function jsonEach(
  source: DialectSource,
  expr: Fragment | string,
  opts: { alias?: string; elements: 'text' | 'json' },
): SQL {
  const alias = opts.alias ?? '';
  const match = /^(?:( AS)? ([A-Za-z_][A-Za-z0-9_]*))?$/.exec(alias);
  if (!match) throw new Error(`sqlx: invalid jsonEach alias ${JSON.stringify(alias)}`);
  const name = match[2] ?? 'json_each';
  return pick(source, {
    sqlite: () => sql`json_each(${expr})${sql.raw(alias)}`,
    pg: () => sql`${sql.raw(opts.elements === 'text' ? 'jsonb_array_elements_text' : 'jsonb_array_elements')}((${expr})::jsonb) WITH ORDINALITY AS ${sql.raw(name)}(value, key)`,
  });
}

/**
 * `expr IN (<ids>)` for a bound id list: one JSON argument through `json_each`
 * on SQLite (D1's parameter limit), `= ANY($1::text[])` on PostgreSQL.
 */
export function inJsonArray(source: DialectSource, expr: Fragment, ids: readonly string[]): SQL<boolean> {
  return pick(source, {
    sqlite: () => sql<boolean>`${expr} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
    pg: () => sql<boolean>`${expr} = ANY(${sql.param([...ids])}::text[])`,
  });
}

/** How a value given to a JSON-writing helper is stored on PostgreSQL. */
export type JsonValueKind =
  /** a JSON document (object/array): `(v)::jsonb` */
  | 'json'
  /** a text scalar, stored as a JSON string: `to_jsonb((v)::text)` */
  | 'text';

function pgJsonValue(value: Fragment, kind: JsonValueKind): SQL {
  return kind === 'json' ? sql`(${value})::jsonb` : sql`to_jsonb((${value})::text)`;
}

/**
 * `json_set(target, path, value)`; `jsonb_set(..., true)` on PostgreSQL.
 * `jsonb_set` is STRICT, so a NULL value (an empty scalar subquery, a missing
 * key) would null the whole document where SQLite stores a JSON `null`; the
 * value is coalesced to `'null'::jsonb` to keep that behaviour.
 */
export function jsonSet(
  source: DialectSource,
  target: Fragment,
  path: JsonPath,
  value: Fragment,
  kind: JsonValueKind,
): SQL {
  return pick(source, {
    sqlite: () => sql`json_set(${target}, ${sqlitePath(path)}, ${value})`,
    pg: () => sql`jsonb_set((${target})::jsonb, ${pgPath(path)}, COALESCE(${pgJsonValue(value, kind)}, 'null'::jsonb), true)`,
  });
}

/** `json_insert(target, '$[#]', value)`: append one element to a JSON array. */
export function jsonAppend(source: DialectSource, target: Fragment, value: Fragment, kind: JsonValueKind): SQL {
  return pick(source, {
    sqlite: () => sql`json_insert(${target}, '$[#]', ${value})`,
    pg: () => sql`((${target})::jsonb || jsonb_build_array(${pgJsonValue(value, kind)}))`,
  });
}

/**
 * `json_patch(target, patch)`. PostgreSQL uses jsonb `||`, which merges top-level
 * keys only (RFC 7396 merge patch also recurses and deletes `null` members);
 * engine call sites patch top-level keys with non-null values.
 */
export function jsonMerge(source: DialectSource, target: Fragment, patch: Fragment): SQL {
  return pick(source, {
    sqlite: () => sql`json_patch(${target}, ${patch})`,
    pg: () => sql`((${target})::jsonb || (${patch})::jsonb)`,
  });
}

/**
 * `json_object(<args>)`. `args` is the site's argument list verbatim (keys and
 * values alternating, layout included); PostgreSQL wraps it in `jsonb_build_object`.
 */
export function jsonObject(source: DialectSource, args: SQL): SQL {
  return pick(source, {
    sqlite: () => sql`json_object(${args})`,
    pg: () => sql`jsonb_build_object(${args})`,
  });
}

/** `json(expr)`: parse/minify text as a JSON value; `(expr)::jsonb` on PostgreSQL. */
export function json(source: DialectSource, expr: Fragment): SQL {
  return pick(source, {
    sqlite: () => sql`json(${expr})`,
    pg: () => sql`(${expr})::jsonb`,
  });
}

/** `json_group_array(expr)`; on PostgreSQL `jsonb_agg`, `'[]'` (not NULL) over no rows like SQLite. */
export function jsonAgg(source: DialectSource, expr: Fragment): SQL {
  return pick(source, {
    sqlite: () => sql`json_group_array(${expr})`,
    pg: () => sql`COALESCE(jsonb_agg(${expr}), '[]'::jsonb)`,
  });
}

/** `json_valid(expr)`; `pg_input_is_valid(text, 'jsonb')` on PostgreSQL (16+, enforced by `verifyIdentity`). */
export function jsonValid(source: DialectSource, expr: Fragment): SQL<boolean> {
  return pick(source, {
    sqlite: () => sql<boolean>`json_valid(${expr})`,
    pg: () => sql<boolean>`pg_input_is_valid((${expr})::text, 'jsonb')`,
  });
}

/**
 * `json_type(expr[, path])`. Only `'object'`, `'array'`, `'null'` and SQL NULL
 * (path absent) mean the same on both dialects; scalar type names differ.
 */
export function jsonType(source: DialectSource, expr: Fragment, path?: JsonPath): SQL<string | null> {
  return pick(source, {
    sqlite: () => path === undefined
      ? sql<string | null>`json_type(${expr})`
      : sql<string | null>`json_type(${expr}, ${sqlitePath(path)})`,
    pg: () => path === undefined
      ? sql<string | null>`jsonb_typeof((${expr})::jsonb)`
      : sql<string | null>`jsonb_typeof((${expr})::jsonb #> ${pgPath(path)})`,
  });
}

// --- types and comparisons ---------------------------------------------------

/** `typeof(expr) = 'integer'`; on PostgreSQL (bigint columns) `expr IS NOT NULL`. */
export function isInteger(source: DialectSource, expr: Fragment): SQL<boolean> {
  return pick(source, {
    sqlite: () => sql<boolean>`typeof(${expr}) = 'integer'`,
    pg: () => sql<boolean>`(${expr}) IS NOT NULL`,
  });
}

/** `typeof(expr) != 'integer'`; on PostgreSQL (bigint columns) `expr IS NULL`. */
export function isNotInteger(source: DialectSource, expr: Fragment): SQL<boolean> {
  return pick(source, {
    sqlite: () => sql<boolean>`typeof(${expr}) != 'integer'`,
    pg: () => sql<boolean>`(${expr}) IS NULL`,
  });
}

/** `CAST(expr AS INTEGER)`; `(expr)::bigint` on PostgreSQL. */
export function castInt(source: DialectSource, expr: Fragment): SQL<number> {
  return pick(source, {
    sqlite: () => sql<number>`CAST(${expr} AS INTEGER)`,
    pg: () => sql<number>`(${expr})::bigint`,
  });
}

/** `CAST(expr AS REAL)`; `(expr)::double precision` on PostgreSQL. */
export function castReal(source: DialectSource, expr: Fragment): SQL<number> {
  return pick(source, {
    sqlite: () => sql<number>`CAST(${expr} AS REAL)`,
    pg: () => sql<number>`(${expr})::double precision`,
  });
}

/**
 * Numeric comparison key for snowflake id strings: `CAST(expr AS BIGINT)` on
 * SQLite, `(expr)::numeric` on PostgreSQL (ids may exceed bigint).
 */
export function castNumeric(source: DialectSource, expr: Fragment): SQL<number> {
  return pick(source, {
    sqlite: () => sql<number>`CAST(${expr} AS BIGINT)`,
    pg: () => sql<number>`(${expr})::numeric`,
  });
}

/** Two-argument maximum: scalar `MAX(a, b)`; `GREATEST(a, b)` on PostgreSQL. */
export function greatest<T = unknown>(source: DialectSource, a: Fragment, b: Fragment): SQL<T> {
  return pick(source, {
    sqlite: () => sql<T>`MAX(${a}, ${b})`,
    pg: () => sql<T>`GREATEST(${a}, ${b})`,
  });
}

/** Two-argument minimum: scalar `MIN(a, b)`; `LEAST(a, b)` on PostgreSQL. */
export function least<T = unknown>(source: DialectSource, a: Fragment, b: Fragment): SQL<T> {
  return pick(source, {
    sqlite: () => sql<T>`MIN(${a}, ${b})`,
    pg: () => sql<T>`LEAST(${a}, ${b})`,
  });
}

/** A boolean literal: `1`/`0` on SQLite, `true`/`false` on PostgreSQL. */
export function bool<T = boolean>(source: DialectSource, value: boolean): SQL<T> {
  return pick(source, {
    sqlite: () => sql.raw(value ? '1' : '0') as SQL<T>,
    pg: () => sql.raw(value ? 'true' : 'false') as SQL<T>,
  });
}

/** `a IS NOT b` (null-safe inequality); `IS DISTINCT FROM` on PostgreSQL. */
export function isDistinct(source: DialectSource, a: Fragment, b: Fragment): SQL<boolean> {
  return pick(source, {
    sqlite: () => sql<boolean>`${a} IS NOT ${b}`,
    pg: () => sql<boolean>`${a} IS DISTINCT FROM ${b}`,
  });
}

/** `a IS b` (null-safe equality); `IS NOT DISTINCT FROM` on PostgreSQL. */
export function isNotDistinct(source: DialectSource, a: Fragment, b: Fragment): SQL<boolean> {
  return pick(source, {
    sqlite: () => sql<boolean>`${a} IS ${b}`,
    pg: () => sql<boolean>`${a} IS NOT DISTINCT FROM ${b}`,
  });
}

/** `expr GLOB '<prefix>*'`; `starts_with(expr, '<prefix>')` on PostgreSQL. */
export function startsWith(source: DialectSource, expr: Fragment, prefix: string): SQL<boolean> {
  if (!/^[A-Za-z0-9_:.-]*$/.test(prefix)) throw new Error(`sqlx: unsupported startsWith prefix ${JSON.stringify(prefix)}`);
  return pick(source, {
    sqlite: () => sql<boolean>`${expr} GLOB ${sql.raw(`'${prefix}*'`)}`,
    pg: () => sql<boolean>`starts_with(${expr}, ${sql.raw(`'${prefix}'`)})`,
  });
}

/** `instr(haystack, needle) > 0`; `strpos(...) > 0` on PostgreSQL. */
export function contains(source: DialectSource, haystack: Fragment, needle: Fragment | string): SQL<boolean> {
  return pick(source, {
    sqlite: () => sql<boolean>`instr(${haystack}, ${needle}) > 0`,
    pg: () => sql<boolean>`strpos(${haystack}, ${needle}) > 0`,
  });
}

// --- catalog and planner hints ---------------------------------------------

/**
 * A query returning one `name` row per index in `names` that exists:
 * `sqlite_master` on SQLite, `to_regclass` (current search_path) on PostgreSQL.
 */
export function indexExists(source: DialectSource, names: readonly string[]): SQL {
  for (const name of names) identifier(name, 'index name');
  return pick(source, {
    sqlite: () => sql`SELECT name FROM sqlite_master
    WHERE type = 'index' AND name IN (${sql.join(names.map(name => sql`${name}`), sql`, `)})`,
    pg: () => sql`SELECT name FROM unnest(${sql.param([...names])}::text[]) AS name WHERE to_regclass(name) IS NOT NULL`,
  });
}

/** `INDEXED BY <index>` planner pin; empty on PostgreSQL. */
export function indexedBy(source: DialectSource, index: string): SQL {
  identifier(index, 'index name');
  return pick(source, {
    sqlite: () => sql.raw(`INDEXED BY ${index}`),
    pg: () => sql``,
  });
}

/** `NOT INDEXED` planner hint; empty on PostgreSQL. */
export function notIndexed(source: DialectSource): SQL {
  return pick(source, {
    sqlite: () => sql.raw('NOT INDEXED'),
    pg: () => sql``,
  });
}

/**
 * The row-order key: SQLite's implicit `rowid`, and on PostgreSQL the explicit
 * `rowid bigint GENERATED ALWAYS AS IDENTITY` column every table carries. The
 * text is the same on both; `table` qualifies it (a table, or an alias name).
 */
export function rowid(source: DialectSource, table?: Fragment | string): SQL<number> {
  dialectOf(source);
  if (table === undefined) return sql.raw('rowid') as SQL<number>;
  if (typeof table === 'string') return sql.raw(`${identifier(table, 'table alias')}.rowid`) as SQL<number>;
  return sql<number>`${table}.rowid`;
}

// --- insert from select ------------------------------------------------------

/**
 * The columns an `INSERT ... SELECT` into `table` lists, keyed by property name
 * in drizzle's declaration order: every column drizzle itself would list
 * (generated `ALWAYS` columns excluded), minus identity columns. On
 * PostgreSQL every table carries the `rowid bigint GENERATED ALWAYS AS
 * IDENTITY` column (db/schema.pg.ts); drizzle 0.45 still lists it (its
 * insert filter only checks generated columns), which is harmless for
 * `values()` (it fills DEFAULT) but makes an insert-select one target column
 * longer than its select. SQLite schema tables declare no identity column, so
 * there this is exactly `getTableColumns(table)` filtered as drizzle does.
 * Select lists and CTE column lists that feed such an insert use the same
 * enumeration.
 */
export function insertColumns<T extends Table>(table: T): Record<string, Column> {
  const columns: Record<string, Column> = {};
  for (const [key, column] of Object.entries(getTableColumns(table)) as [string, Column][]) {
    if (column.generated !== undefined && column.generated.type !== 'byDefault') continue;
    if (column.generatedIdentity !== undefined) continue;
    columns[key] = column;
  }
  return columns;
}

/** Options for {@link insertSelect}. */
export interface InsertSelectOptions {
  /** Append `on conflict do nothing` (no conflict target, as drizzle's `onConflictDoNothing()`). */
  onConflictDoNothing?: boolean;
}

/**
 * The text of `insert into <table> (<insertColumns>) <select>[ on conflict do
 * nothing]`, laid out exactly as drizzle's insert builder lays out an
 * insert-select (no `with`, no `returning`). `select` is rendered with its own
 * `getSQL()`, as drizzle does, so it is not parenthesized.
 */
export function insertSelectSql(
  source: DialectSource,
  table: Table,
  select: SQLWrapper,
  options: InsertSelectOptions = {},
): SQL {
  const columns = Object.values(insertColumns(table)).map((column) => sql.identifier(column.name));
  dialectOf(source);
  const conflict = options.onConflictDoNothing ? sql` on conflict do nothing` : undefined;
  return sql`insert into ${table} ${columns} ${sql.join([select.getSQL()])}${conflict}`;
}

const pgDialect = new PgDialect();

/**
 * `insert into <table> (...) select ...` as an executable write.
 *
 * SQLite: drizzle's own `db.insert(table).select(select)` builder (plus
 * `onConflictDoNothing()`), unchanged, so D1 batches still receive drizzle
 * builders and the SQL bytes are drizzle's. PostgreSQL: the statement from
 * {@link insertSelectSql}, whose column list omits the `rowid` identity that
 * drizzle's pg builder would list; awaiting it runs it on `db` (pass the
 * transaction handle when it must join a transaction) and yields the driver
 * result. A select builder (not raw SQL) must select exactly the
 * {@link insertColumns} keys in order, the check drizzle applies.
 */
export function insertSelect<T extends Table>(
  db: EngineDatabase,
  table: T,
  select: InsertSelectSource<T> | ((qb: EngineQueryBuilder) => InsertSelectSource<T>),
  options: InsertSelectOptions = {},
): EngineWrite {
  const dialect = engineDialectOf(db);
  switch (dialect) {
    case 'sqlite': {
      const insert = db.insert(table).select(select);
      return options.onConflictDoNothing ? insert.onConflictDoNothing() : insert;
    }
    case 'pg': {
      const source = typeof select === 'function'
        ? select(new PgQueryBuilder() as unknown as EngineQueryBuilder)
        : select;
      if (!is(source, SQL)) {
        const selected = Object.keys((source as { _: { selectedFields: object } })._.selectedFields);
        const expected = Object.keys(insertColumns(table));
        if (selected.length !== expected.length || selected.some((key, i) => key !== expected[i])) {
          throw new Error(
            'sqlx.insertSelect: selected fields are not the insertable columns in table order ' +
              `(expected ${expected.join(', ')}; got ${selected.join(', ')})`,
          );
        }
      }
      const query = insertSelectSql(dialect, table, source as SQLWrapper, options);
      return {
        getSQL: () => query,
        toSQL: (): Query => {
          const { sql: text, params } = pgDialect.sqlToQuery(query);
          return { sql: text, params };
        },
        then(onfulfilled, onrejected) {
          return (db as unknown as PgRawExecutor).execute(query).then(onfulfilled, onrejected);
        },
      };
    }
    default:
      return unsupported(dialect);
  }
}

// --- sequence locks ----------------------------------------------------------

/** What a sequence lock serializes, and its key. */
export type SeqLockTarget =
  /** `workspace_events.seq` allocation for one workspace */
  | { kind: 'workspace_event'; workspaceId: string }
  /** `session_events.sequence` allocation for one agent */
  | { kind: 'session_event'; agentId: string }
  /**
   * per-agent `deliveries.seq` allocation: locks the recipients' agent rows in
   * id order. `agentIds` is a bound list or a subquery selecting agent ids.
   */
  | { kind: 'delivery'; workspaceId: string; agentIds: readonly string[] | SQL };

/**
 * The statement that serializes a sequence allocation, to run in the same
 * transaction as the insert that allocates (`MAX(seq) + 1`). SQLite writers
 * are already serialized, so the SQLite form is an empty statement and callers
 * skip it ({@link isNoopLock}); PostgreSQL takes a transaction-scoped advisory
 * lock or row locks.
 */
export function lockSeq(source: DialectSource, target: SeqLockTarget): SQL {
  return pick(source, {
    sqlite: () => sql``,
    pg: () => {
      switch (target.kind) {
        case 'workspace_event':
          return sql`SELECT pg_advisory_xact_lock(hashtextextended(${'we:' + target.workspaceId}, 0))`;
        case 'session_event':
          return sql`SELECT pg_advisory_xact_lock(hashtextextended(${'se:' + target.agentId}, 0))`;
        case 'delivery': {
          const ids = Array.isArray(target.agentIds)
            ? sql`= ANY(${sql.param([...(target.agentIds as readonly string[])])}::text[])`
            : sql`IN (${target.agentIds as SQL})`;
          return sql`SELECT id FROM agents WHERE workspace_id = ${target.workspaceId} AND id ${ids} ORDER BY id FOR UPDATE`;
        }
        default:
          throw new Error(`sqlx.lockSeq: unknown lock kind ${JSON.stringify((target as { kind?: unknown }).kind)}`);
      }
    },
  });
}

/** True when {@link lockSeq} is a no-op for `source` (SQLite). */
export function isNoopLock(source: DialectSource): boolean {
  return pick(source, { sqlite: () => true, pg: () => false });
}

/**
 * True when `db` is a PostgreSQL transaction handle (drizzle `PgTransaction`),
 * the only place a {@link lockSeq} statement has any effect. False for SQLite.
 */
export function inPgTransaction(source: DialectSource): boolean {
  return pick(source, { sqlite: () => false, pg: () => is(source, PgTransaction) });
}
