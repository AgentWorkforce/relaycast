import { getTableName, is, Table } from 'drizzle-orm';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as sqliteSchema from '../schema.js';

// The harness binds 'sqlite' in setupFiles; each test here imports fresh,
// unbound copies of the modules to observe the fail-closed behaviour.
type Tables = typeof import('../tables.js');
// tables.js (its namespace, so the live bindings stay live) and the schema.js
// copy it binds from, both from the same fresh module graph.
const freshTables = async (): Promise<{ t: Tables; schema: typeof sqliteSchema }> => ({
  t: await import('../tables.js'),
  schema: await import('../schema.js'),
});

describe('db/tables binding', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('throws on any table or alias access before bindSchema', async () => {
    const { t, schema } = await freshTables();
    expect(t.currentSchemaDialect()).toBeUndefined();
    expect(() => t.agents.id).toThrow(/'agents' read before bindSchema/);
    expect(() => is(t.workspaces, Table)).toThrow(/'workspaces' read before bindSchema/);
    expect(() => Object.keys(t.channels)).toThrow(/before bindSchema/);
    expect(() => t.alias(sqliteSchema.workspaces, 'w')).toThrow(/'alias' read before bindSchema/);
  });

  it("binds every table to schema.ts for 'sqlite', idempotently", async () => {
    const { t, schema } = await freshTables();
    t.bindSchema('sqlite');
    t.bindSchema('sqlite');
    expect(t.currentSchemaDialect()).toBe('sqlite');
    const tableNames = Object.entries(sqliteSchema).filter(([, v]) => is(v, Table)).map(([k]) => k);
    expect(tableNames.length).toBeGreaterThan(40);
    for (const name of tableNames) {
      expect((t as unknown as Record<string, unknown>)[name], name).toBe(
        (schema as unknown as Record<string, unknown>)[name],
      );
    }
    expect(getTableName(t.alias(t.workspaces, 'other_workspace'))).toBe('other_workspace');
  });

  it("binds every table to schema.pg.ts for 'pg', schema-qualified, idempotently", async () => {
    const { t } = await freshTables();
    const pgSchema = await import('../schema.pg.js');
    const { getTableConfig, PgTable } = await import('drizzle-orm/pg-core');
    t.bindSchema('pg');
    t.bindSchema('pg');
    expect(t.currentSchemaDialect()).toBe('pg');
    const sqliteNames = Object.entries(sqliteSchema).filter(([, v]) => is(v, Table)).map(([k]) => k).sort();
    const pgNames = Object.entries(pgSchema).filter(([, v]) => is(v, Table)).map(([k]) => k).sort();
    expect(pgNames).toEqual(sqliteNames);
    for (const name of pgNames) {
      const bound = (t as unknown as Record<string, unknown>)[name];
      expect(bound, name).toBe((pgSchema as unknown as Record<string, unknown>)[name]);
      expect(is(bound, PgTable), name).toBe(true);
      // Every query names "relaycast"."<table>": nothing depends on search_path.
      expect(getTableConfig(bound as InstanceType<typeof PgTable>).schema, name).toBe('relaycast');
    }
    const other = t.alias(t.workspaces, 'other_workspace');
    expect(is(other, PgTable)).toBe(true);
    expect(getTableName(other)).toBe('other_workspace');
  });

  it('alias refuses a table from the other dialect', async () => {
    const { t } = await freshTables();
    t.bindSchema('pg');
    expect(() => t.alias(sqliteSchema.workspaces, 'w')).toThrow(/not a PostgreSQL table/);
  });

  it('refuses to rebind a process to a different dialect', async () => {
    const { t, schema } = await freshTables();
    t.bindSchema('sqlite');
    expect(() => t.bindSchema('pg')).toThrow(/already bound to 'sqlite'/);
    expect(t.agents).toBe(schema.agents);
  });

  it("refuses to bind 'sqlite' after 'pg', leaving the pg tables bound", async () => {
    const { t } = await freshTables();
    const pgSchema = await import('../schema.pg.js');
    t.bindSchema('pg');
    expect(() => t.bindSchema('sqlite')).toThrow(/already bound to 'pg'/);
    expect(t.currentSchemaDialect()).toBe('pg');
    expect(t.agents).toBe(pgSchema.agents);
    const { brandSqliteEngineDb } = await import('../../adapters/sqlite-handle.js');
    expect(() => brandSqliteEngineDb(drizzle(new Database(':memory:')))).toThrow(/already bound to 'pg'/);
  });

  it('brandSqliteEngineDb binds sqlite in an unbound process', async () => {
    const { t, schema } = await freshTables();
    const { brandSqliteEngineDb } = await import('../../adapters/sqlite-handle.js');
    const db = brandSqliteEngineDb(drizzle(new Database(':memory:')));
    expect(db.engineDialect).toBe('sqlite');
    expect(t.currentSchemaDialect()).toBe('sqlite');
    expect(t.agents).toBe(schema.agents);
  });
});
