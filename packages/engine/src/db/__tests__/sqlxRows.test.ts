import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { brandSqliteEngineDb } from '../../adapters/sqlite-handle.js';
import * as sqlx from '../sqlx.js';

function handle(rows: unknown[]) {
  // A proxy driver like the workspace actor's: drizzle hands raw reads its rows as is.
  return brandSqliteEngineDb(drizzle(async () => ({ rows: rows as unknown[][] })));
}

describe('sqlx.all on positional rows', () => {
  it('turns named positional rows into plain objects and passes objects through', async () => {
    const named = Object.assign(['ops', 1], { channel_name: 'ops', unread_count: 1 });
    expect(await sqlx.all(handle([named, { a: 1 }]), sql`select 1`)).toEqual([{ channel_name: 'ops', unread_count: 1 }, { a: 1 }]);
  });

  it('refuses a positional row that carries no column names', async () => {
    await expect(sqlx.all(handle([['ops', 1]]), sql`select 1`)).rejects.toThrow(/positional row without column names/);
  });
});
