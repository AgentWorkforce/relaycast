import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable, getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as sqliteSchema from '../../../db/schema.js';
import { SKIPPED_TABLES, migrationPlan } from '../plan.js';

const schemaTables = Object.values(sqliteSchema).filter((value) => is(value, SQLiteTable)) as SQLiteTable[];

describe('migration plan', () => {
  it('covers every engine table exactly once, except the documented skips', () => {
    const planned = migrationPlan().map((table) => table.name);
    expect(new Set(planned).size).toBe(planned.length);
    const all = schemaTables.map((table) => getTableName(table)).sort();
    expect([...planned, ...Object.keys(SKIPPED_TABLES)].sort()).toEqual(all);
  });

  it('orders parents before children along every foreign key', () => {
    const position = new Map(migrationPlan().map((table, index) => [table.name, index]));
    for (const table of schemaTables) {
      const config = getTableConfig(table);
      if (!position.has(config.name)) continue;
      for (const fk of config.foreignKeys) {
        const parent = getTableName(fk.reference().foreignTable);
        if (parent === config.name || !position.has(parent)) continue;
        expect(position.get(parent), `${parent} before ${config.name}`).toBeLessThan(position.get(config.name)!);
      }
    }
  });

  it('scopes every table to one workspace', () => {
    const plan = migrationPlan();
    const byName = new Map(plan.map((table) => [table.name, table]));
    for (const table of plan) {
      if (table.scope.kind === 'parent') expect(byName.has(table.scope.parent), table.name).toBe(true);
    }
    expect(byName.get('channel_members')?.scope).toMatchObject({ kind: 'parent' });
    expect(byName.get('file_cleanup_queue')?.scope).toEqual({ kind: 'storage-key-prefix', column: 'storage_key' });
  });
});
