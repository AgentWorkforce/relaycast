import { is } from 'drizzle-orm';
import { getTableConfig as getPgTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { getTableConfig as getSqliteTableConfig, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
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
