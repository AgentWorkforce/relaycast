import { getTableColumns, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { getSqliteDb } from '../../adapters/node/database.js';
import { compileSqliteQuery } from '../../adapters/sqlite-handle.js';
import type { EngineDatabase } from '../../ports/engineDb.js';
import * as pgSchema from '../schema.pg.js';
import * as sqliteSchema from '../schema.js';
import * as sqlx from '../sqlx.js';

// No fixture and no bindSchema: each case passes the dialect's own table
// objects (schema.ts / schema.pg.ts) to the helpers, so the process-global
// binding (SQLite in the vitest setup) is not involved.

const pgDialect = new PgDialect();

/** A select field per insert column, in the insert's key order (shape of the deliveryWrites fan-outs). */
function nullFields(table: Parameters<typeof sqlx.insertColumns>[0]): Record<string, SQL> {
  return Object.fromEntries(Object.keys(sqlx.insertColumns(table)).map((key) => [key, sql`null`]));
}

describe('sqlx.insertSelect on SQLite', () => {
  const handle = getSqliteDb(':memory:');
  const db = handle.db as unknown as EngineDatabase;
  afterAll(() => handle.sqlite.close());

  it('enumerates exactly drizzle\'s columns for deliveries (no identity on SQLite)', () => {
    expect(Object.keys(sqlx.insertColumns(sqliteSchema.deliveries))).toEqual(Object.keys(getTableColumns(sqliteSchema.deliveries)));
  });

  it('is byte-identical to drizzle\'s own insert().select().onConflictDoNothing()', () => {
    const select = (qb: { select(fields: object): { from(table: object): unknown } }) =>
      qb.select(nullFields(sqliteSchema.deliveries)).from(sqliteSchema.agents);
    const drizzleOwn = db.insert(sqliteSchema.deliveries).select(select as never).onConflictDoNothing().toSQL();
    const helper = sqlx.insertSelect(db, sqliteSchema.deliveries, select as never, { onConflictDoNothing: true }).toSQL();
    expect(helper).toEqual(drizzleOwn);
    // The dialect-neutral renderer lays the statement out as drizzle does.
    const rendered = compileSqliteQuery(sqlx.insertSelectSql(
      'sqlite', sqliteSchema.deliveries, select(db) as SQLWrapper, { onConflictDoNothing: true },
    ));
    expect(rendered.sql).toBe(drizzleOwn.sql);
  });
});

describe('sqlx.insertSelect on PostgreSQL', () => {
  const pgColumns = getTableConfig(pgSchema.deliveries).columns.map((column) => column.name);

  it('excludes the rowid identity and nothing else', () => {
    expect(pgColumns).toContain('rowid');
    expect(Object.values(sqlx.insertColumns(pgSchema.deliveries)).map((c) => c.name))
      .toEqual(pgColumns.filter((name) => name !== 'rowid'));
  });

  it('renders insert into deliveries with the non-identity columns, select, and on conflict do nothing', async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const db = { engineDialect: 'pg', execute } as unknown as EngineDatabase;
    const write = sqlx.insertSelect(db, pgSchema.deliveries,
      ((qb: { select(fields: object): { from(table: object): unknown } }) =>
        qb.select(nullFields(pgSchema.deliveries)).from(pgSchema.agents)) as never,
      { onConflictDoNothing: true });
    const { sql: text } = write.toSQL();
    const columns = pgColumns.filter((name) => name !== 'rowid');
    expect(columns).toHaveLength(29);
    expect(text).toBe(
      `insert into "deliveries" (${columns.map((n) => `"${n}"`).join(', ')}) ` +
        `select ${columns.map(() => 'null').join(', ')} from "agents" on conflict do nothing`,
    );
    expect(text).not.toMatch(/rowid/);
    // drizzle's own pg insert lists rowid; ours is exactly that minus "rowid".
    const drizzleOwn = pgDialect.sqlToQuery(pgDialect.buildInsertQuery({
      table: pgSchema.deliveries,
      values: sql.raw(`select ${columns.map(() => 'null').join(', ')} from "agents"`),
      select: true,
      onConflict: sql`do nothing`,
    } as never)).sql;
    expect(drizzleOwn).toContain('"rowid", ');
    expect(text).toBe(drizzleOwn.replace('"rowid", ', ''));
    // Awaiting runs that statement on the handle.
    await write;
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0]).toBe(write.getSQL());
  });

  it('rejects a select whose fields are not the insert columns in order', () => {
    const db = { engineDialect: 'pg', execute: vi.fn() } as unknown as EngineDatabase;
    const fields = nullFields(pgSchema.deliveries);
    expect(() => sqlx.insertSelect(db, pgSchema.deliveries,
      ((qb: { select(fields: object): { from(table: object): unknown } }) =>
        qb.select({ ...fields, rowid: sql`null` }).from(pgSchema.agents)) as never)).toThrow(/selected fields are not the insertable columns/);
  });
});
