import { is, SQL } from 'drizzle-orm';
import { getTableConfig as getPgTableConfig, PgDialect, PgTable, type PgColumn } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { getSqliteDb, runMigrations } from '../../adapters/node/database.js';
import * as pgSchema from '../schema.pg.js';
import * as sqliteSchema from '../schema.js';

/**
 * Indexes and CHECKs the SQLite migrations create that schema.ts does not
 * declare; schema.pg.ts carries them so the Postgres DDL matches a fully
 * migrated SQLite database.
 */
const PG_ONLY_INDEXES = new Set([
  'idx_nodes_online_liveness',
  'idx_nodes_context_reachable',
  'idx_action_invocations_spawn_canceled',
  'idx_action_invocations_status_dispatched',
  'idx_action_invocations_status_retry_after',
  'idx_action_invocations_status_task_deadline',
  'idx_action_invocations_task_deadline',
  'idx_workspaces_usage_classification',
]);
const PG_ONLY_CHECKS = new Set(['action_invocations_invocation_origin_check', 'workspace_events_seq_positive_check']);

interface Shape {
  columns: Record<string, { notNull: boolean; primary: boolean }>;
  primaryKeys: string[];
  /** Index and unique-constraint names (a pg UNIQUE constraint stands in for a SQLite unique index). */
  uniques: string[];
  indexes: string[];
  foreignKeys: string[];
  checks: string[];
}

type AnyConfig = ReturnType<typeof getPgTableConfig> | ReturnType<typeof getSqliteTableConfig>;

function shape(config: AnyConfig): Shape {
  const columns: Shape['columns'] = {};
  const uniques: string[] = [];
  for (const col of config.columns) {
    columns[col.name] = { notNull: col.notNull, primary: col.primary };
    if (col.isUnique && col.uniqueName) uniques.push(col.uniqueName);
  }
  for (const u of config.uniqueConstraints) uniques.push(u.getName());
  const indexes: string[] = [];
  for (const idx of config.indexes) {
    if (idx.config.unique) uniques.push(idx.config.name);
    else indexes.push(idx.config.name);
  }
  const foreignKeys = config.foreignKeys.map((fk) => {
    const ref = fk.reference();
    const local = ref.columns.map((c) => c.name).join(',');
    const target = getName(ref.foreignTable);
    const remote = ref.foreignColumns.map((c) => c.name).join(',');
    return `${fk.getName()}: (${local}) -> ${target}(${remote}) on delete ${fk.onDelete ?? 'no action'}`;
  });
  return {
    columns,
    primaryKeys: config.primaryKeys.map((pk) => pk.columns.map((c) => c.name).join(',')).sort(),
    // De-duplicated by SQL name: schema.ts declares observer_tokens_token_hash_unique
    // both as a column .unique() and as a uniqueIndex; Postgres allows one.
    uniques: [...new Set(uniques)].sort(),
    indexes: indexes.sort(),
    foreignKeys: foreignKeys.sort(),
    checks: config.checks.map((c) => c.name).sort(),
  };
}

function getName(table: unknown): string {
  return is(table, PgTable) ? getPgTableConfig(table).name : getSqliteTableConfig(table as SQLiteTable).name;
}

const sqliteTables = new Map(
  Object.values(sqliteSchema)
    .filter((v): v is SQLiteTable => is(v, SQLiteTable))
    .map((t) => [getSqliteTableConfig(t).name, shape(getSqliteTableConfig(t))]),
);
const pgTables = new Map(
  Object.values(pgSchema)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => {
      const config = getPgTableConfig(t);
      expect(config.schema).toBe('relaycast');
      return [config.name, shape(config)] as const;
    }),
);

describe('schema.pg.ts parity with schema.ts', () => {
  it('declares the same tables', () => {
    expect([...pgTables.keys()].sort()).toEqual([...sqliteTables.keys()].sort());
    expect(pgTables.size).toBeGreaterThan(40);
  });

  describe.each([...sqliteTables.keys()].sort())('%s', (name) => {
    const lite = sqliteTables.get(name)!;
    const pg = pgTables.get(name)!;

    it('has the same columns, nullability and primary keys, plus rowid', () => {
      const { rowid, ...rest } = pg.columns;
      expect(rowid).toEqual({ notNull: true, primary: false });
      expect(lite.columns).not.toHaveProperty('rowid');
      expect(rest).toEqual(lite.columns);
      expect(pg.primaryKeys).toEqual(lite.primaryKeys);
    });

    it('has the same unique indexes/constraints, plus <table>_rowid_unique', () => {
      expect(pg.uniques).toEqual([...lite.uniques, `${name}_rowid_unique`].sort());
    });

    it('has the same indexes, plus the documented migration-only ones', () => {
      expect(pg.indexes.filter((i) => !PG_ONLY_INDEXES.has(i))).toEqual(lite.indexes);
    });

    it('has the same foreign keys and checks', () => {
      expect(pg.foreignKeys).toEqual(lite.foreignKeys);
      expect(pg.checks.filter((c) => !PG_ONLY_CHECKS.has(c))).toEqual(lite.checks);
    });
  });

  it('every documented Postgres-only index and check exists', () => {
    const allIndexes = new Set([...pgTables.values()].flatMap((t) => t.indexes));
    const allChecks = new Set([...pgTables.values()].flatMap((t) => t.checks));
    for (const i of PG_ONLY_INDEXES) expect(allIndexes.has(i), i).toBe(true);
    for (const c of PG_ONLY_CHECKS) expect(allChecks.has(c), c).toBe(true);
  });
});

/**
 * Defaults, nullability and CHECK bodies against a SQLite database built by
 * running every SQLite migration (the source of truth: drizzle's `.default()`
 * in schema.ts only feeds migration generation, never inserts, so the
 * migrated DDL is what a running engine actually gets).
 */
describe('schema.pg.ts parity with the migrated SQLite database', () => {
  interface LiteColumn {
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }

  /** Columns the SQLite migrations still carry but schema.ts dropped (see CHANGELOG). */
  const SQLITE_ONLY_COLUMNS = new Set(['workspaces.stripe_customer_id', 'workspaces.stripe_subscription_id']);

  /**
   * SQLite CHECK bodies (normalised) with no textually identical Postgres
   * CHECK, and why the Postgres DDL still enforces them.
   */
  const CHECK_EQUIVALENTS: Record<string, string> = {
    // boolean NOT NULL admits exactly the two values SQLite's 0/1 domain does.
    'message_sessions: start_is_known in(0,1)': 'type:message_sessions.start_is_known boolean not null',
    // Implied by workspaces_usage_classification_source_check: each of its
    // disjuncts restricts both columns to these sets.
    "workspaces: usage_classification in('internal','external','unknown')":
      'implied-by:workspaces_usage_classification_source_check',
    "workspaces: classification_source in('creator','operator','unclassified')and((usage_classification='unknown' and classification_source='unclassified')or(usage_classification in('internal','external')and classification_source in('creator','operator')))":
      'implied-by:workspaces_usage_classification_source_check',
  };

  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  const liteTables = new Map(
    (
      handle.sqlite
        .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'")
        .all() as { name: string; sql: string }[]
    ).map((t) => [
      t.name,
      {
        sql: t.sql,
        columns: handle.sqlite.prepare(`PRAGMA table_info("${t.name}")`).all() as LiteColumn[],
      },
    ]),
  );
  handle.sqlite.close();

  const dialect = new PgDialect();
  const EPOCH_NOW = 'floor(extract(epoch from statement_timestamp()))::bigint';

  /** SQLite dflt_value -> comparable token. */
  function liteDefault(raw: string | null): string | null {
    if (raw === null || /^null$/i.test(raw)) return null;
    const v = raw.replace(/^\((.*)\)$/s, '$1').trim();
    if (/^unixepoch\(\)$/i.test(v)) return 'now';
    if (/^true$/i.test(v)) return '1';
    if (/^false$/i.test(v)) return '0';
    const quoted = /^'((?:[^']|'')*)'$/s.exec(v);
    if (quoted) return `'${quoted[1].replace(/''/g, "'")}'`;
    if (/^-?\d+(\.\d+)?$/.test(v)) return String(Number(v));
    return `expr:${v}`;
  }

  /** drizzle pg column default -> comparable token. */
  function pgDefault(col: PgColumn): string | null {
    const d: unknown = col.default;
    if (d === undefined || d === null) return null;
    if (is(d, SQL)) {
      const text = dialect.sqlToQuery(d).sql;
      return text === EPOCH_NOW ? 'now' : `expr:${text}`;
    }
    if (typeof d === 'boolean') return d ? '1' : '0';
    if (typeof d === 'number') return String(d);
    if (typeof d === 'string') return `'${d}'`;
    return `'${JSON.stringify(d)}'`;
  }

  /** Lower-case, unquote identifiers, collapse whitespace around punctuation. */
  function normaliseCheck(body: string): string {
    return body
      .replace(/"([a-z0-9_]+)"\./gi, '')
      .replace(/"/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*([(),=<>])\s*/g, '$1')
      .replace(/^\((.*)\)$/, '$1')
      .trim()
      .toLowerCase();
  }

  /** Every CHECK (...) body in a SQLite CREATE TABLE statement. */
  function liteChecks(createSql: string): string[] {
    const bodies: string[] = [];
    const re = /\bCHECK\s*\(/gi;
    for (let m = re.exec(createSql); m; m = re.exec(createSql)) {
      let i = m.index + m[0].length;
      const start = i;
      for (let depth = 1; depth > 0; i++) {
        if (createSql[i] === '(') depth++;
        else if (createSql[i] === ')') depth--;
      }
      bodies.push(normaliseCheck(createSql.slice(start, i - 1)));
    }
    return bodies;
  }

  const pgConfigs = Object.values(pgSchema)
    .filter((v): v is PgTable => is(v, PgTable))
    .map((t) => getPgTableConfig(t))
    .sort((a, b) => a.name.localeCompare(b.name));

  it('covers every schema.ts table', () => {
    for (const config of pgConfigs) expect(liteTables.has(config.name), config.name).toBe(true);
  });

  describe.each(pgConfigs.map((c) => [c.name, c] as const))('%s', (name, config) => {
    const lite = liteTables.get(name)!;

    it('has the migrated column defaults and nullability', () => {
      const liteCols = new Map(lite.columns.map((c) => [c.name, c]));
      const actual: Record<string, { default: string | null; notNull: boolean }> = {};
      const expected: typeof actual = {};
      for (const col of config.columns) {
        if (col.name === 'rowid') continue;
        actual[col.name] = { default: pgDefault(col), notNull: col.notNull };
        const l = liteCols.get(col.name);
        if (l) expected[col.name] = { default: liteDefault(l.dflt_value), notNull: l.notnull === 1 || l.pk > 0 };
      }
      for (const l of lite.columns) {
        if (!(l.name in actual)) expect(SQLITE_ONLY_COLUMNS.has(`${name}.${l.name}`), `${name}.${l.name}`).toBe(true);
      }
      expect(actual).toEqual(expected);
    });

    it('enforces every migrated CHECK', () => {
      const pgChecks = new Map(config.checks.map((c) => [normaliseCheck(dialect.sqlToQuery(c.value).sql), c.name]));
      for (const body of liteChecks(lite.sql)) {
        if (pgChecks.has(body)) continue;
        const key = `${name}: ${body}`;
        const equivalent = CHECK_EQUIVALENTS[key];
        expect(equivalent, `no Postgres CHECK for ${key}`).toBeDefined();
        const [kind, ref] = equivalent.split(/:(.*)/s);
        if (kind === 'implied-by') {
          expect(config.checks.map((c) => c.name)).toContain(ref);
        } else {
          const [, colName] = /^\S+\.(\S+) boolean not null$/.exec(ref)!;
          const col = config.columns.find((c) => c.name === colName)!;
          expect(col.getSQLType()).toBe('boolean');
          expect(col.notNull).toBe(true);
        }
      }
    });
  });

  it('documents only SQLite-only columns and CHECK equivalents that still exist', () => {
    for (const key of SQLITE_ONLY_COLUMNS) {
      const [table, column] = key.split('.');
      expect(liteTables.get(table)?.columns.some((c) => c.name === column), key).toBe(true);
    }
    for (const key of Object.keys(CHECK_EQUIVALENTS)) {
      const [table, body] = key.split(/: (.*)/s);
      expect(liteChecks(liteTables.get(table)!.sql), key).toContain(body);
    }
  });
});
