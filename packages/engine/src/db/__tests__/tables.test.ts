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

  it("fails closed for 'pg' until schema.pg exists, and stays unbound", async () => {
    const { t, schema } = await freshTables();
    expect(() => t.bindSchema('pg')).toThrow(/schema\.pg not available/);
    expect(t.currentSchemaDialect()).toBeUndefined();
    expect(() => t.agents.id).toThrow(/before bindSchema/);
  });

  it('refuses to rebind a process to a different dialect', async () => {
    const { t, schema } = await freshTables();
    t.bindSchema('sqlite');
    expect(() => t.bindSchema('pg')).toThrow(/already bound to 'sqlite'/);
    expect(t.agents).toBe(schema.agents);
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
