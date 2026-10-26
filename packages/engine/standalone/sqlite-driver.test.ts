/**
 * Pins the better-sqlite3 behaviour the bun:sqlite facade must reproduce.
 * Run with `bun test standalone` (bun:sqlite only exists in the Bun runtime).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import * as bunDriver from './sqlite-driver.js';
import { BunSqliteDatabase, splitSqlChunks, sqliteDriver } from './sqlite-driver.js';

// Apply the standalone build's driver swap, then load the shared adapter.
mock.module('../src/adapters/node/sqlite-driver.js', () => bunDriver);
const { getSqliteDb, runMigrations } = await import('../src/adapters/node/database.js');

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'relaycast-bun-sqlite-'));
  dirs.push(dir);
  return join(dir, 'test.db');
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('splitSqlChunks', () => {
  it('splits only on top-level semicolons', () => {
    const chunks = splitSqlChunks(
      `INSERT INTO t VALUES ('a;b', "c;d", [e;f], \`g;h\`); -- x; y\n/* z; */ SELECT 1;  \n`,
    );
    expect(chunks.map((c) => c.text)).toEqual([
      `INSERT INTO t VALUES ('a;b', "c;d", [e;f], \`g;h\`);`,
      ` -- x; y\n/* z; */ SELECT 1;`,
      `  \n`,
    ]);
    expect(chunks.map((c) => c.hasCode)).toEqual([true, true, false]);
  });

  it('handles doubled quotes inside literals', () => {
    expect(splitSqlChunks(`SELECT 'it''s; fine'; SELECT 2`).map((c) => c.text)).toEqual([
      `SELECT 'it''s; fine';`,
      ` SELECT 2`,
    ]);
  });
});

describe('BunSqliteDatabase.exec', () => {
  it('throws on a failing statement that is followed by more SQL (bun:sqlite swallows it)', () => {
    const db = new BunSqliteDatabase();
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, o TEXT CHECK (o IN ('a')));`);
    expect(() => db.exec(`\n  INSERT INTO t VALUES ('1', 'zzz');\n`)).toThrow(/CHECK constraint failed/);
    expect(() => db.exec(`INSERT INTO t VALUES ('2', 'zzz'); INSERT INTO t VALUES ('3', 'a');`)).toThrow(
      /CHECK constraint failed/,
    );
    // Stops at the first error, like sqlite3_exec / better-sqlite3.
    expect(db.prepare('SELECT id FROM t').all()).toEqual([]);
  });

  it('runs trigger bodies containing semicolons as one statement', () => {
    const db = new BunSqliteDatabase();
    db.exec(`
      CREATE TABLE t (a);
      CREATE TABLE log (b);
      CREATE TRIGGER tr AFTER INSERT ON t BEGIN
        INSERT INTO log VALUES (NEW.a);
        INSERT INTO log VALUES (NEW.a * 10);
      END;
      INSERT INTO t VALUES (1);
    `);
    expect(db.prepare('SELECT b FROM log ORDER BY b').all()).toEqual([{ b: 1 }, { b: 10 }]);
  });

  it('reports an incomplete trailing statement', () => {
    const db = new BunSqliteDatabase();
    db.exec('CREATE TABLE t (a)');
    expect(() => db.exec('CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1;')).toThrow(/incomplete input/);
  });
});

describe('BunSqliteDatabase.prepare', () => {
  it('rejects multiple statements instead of silently dropping the tail', () => {
    const db = new BunSqliteDatabase();
    db.exec('CREATE TABLE t (a)');
    expect(() => db.prepare('INSERT INTO t VALUES (1); INSERT INTO t VALUES (2)')).toThrow(RangeError);
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
  });

  it('returns undefined from get() when there is no row', () => {
    const db = new BunSqliteDatabase();
    expect(db.prepare('SELECT 1 WHERE 0').get()).toBeUndefined();
  });

  it('binds named parameters without a sigil and rejects missing ones', () => {
    const db = new BunSqliteDatabase();
    expect(db.prepare('SELECT $a + :b AS n').get({ a: 1, b: 2 })).toEqual({ n: 3 });
    expect(() => db.prepare('SELECT $a AS n').get({})).toThrow();
  });

  it('reports the statement\'s own changes and insert rowid, not FK/trigger side effects', () => {
    const db = new BunSqliteDatabase();
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE p (id TEXT PRIMARY KEY);
      CREATE TABLE c (id INTEGER PRIMARY KEY, p TEXT REFERENCES p(id) ON DELETE CASCADE);
      CREATE TABLE log (id INTEGER PRIMARY KEY, x);
      CREATE TRIGGER tr AFTER DELETE ON p BEGIN INSERT INTO log (x) VALUES (1); END;
    `);
    expect(db.prepare(`INSERT INTO p VALUES ('a')`).run()).toEqual({ changes: 1, lastInsertRowid: 1 });
    for (let i = 0; i < 3; i++) db.prepare(`INSERT INTO c (p) VALUES ('a')`).run();
    const deleted = db.prepare(`DELETE FROM p WHERE id = 'a'`).run();
    expect(deleted.changes).toBe(1);
    expect(db.prepare(`DELETE FROM p WHERE id = 'missing'`).run().changes).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM c').get()).toEqual({ n: 0 });
  });

  it('supports raw mode and values()', () => {
    const db = new BunSqliteDatabase();
    const stmt = db.prepare('SELECT 1 AS a, 2 AS b');
    expect(stmt.values()).toEqual([[1, 2]]);
    expect(stmt.all()).toEqual([{ a: 1, b: 2 }]);
    expect(stmt.raw().all()).toEqual([[1, 2]]);
    expect(stmt.raw(false).get()).toEqual({ a: 1, b: 2 });
  });

  it('binds BigInt and reads int64 as a number, like better-sqlite3 without safeIntegers', () => {
    const db = new BunSqliteDatabase();
    db.exec('CREATE TABLE t (n INTEGER)');
    db.prepare('INSERT INTO t VALUES (?)').run(2n ** 53n + 1n);
    db.prepare('INSERT INTO t VALUES (?)').run(1_700_000_000_000);
    expect(db.prepare('SELECT n FROM t').all()).toEqual([{ n: 2 ** 53 }, { n: 1_700_000_000_000 }]);
  });

  it('surfaces extended constraint codes the engine matches on', () => {
    const db = new BunSqliteDatabase();
    db.exec('CREATE TABLE t (id TEXT PRIMARY KEY)');
    db.prepare(`INSERT INTO t VALUES ('a')`).run();
    let caught: unknown;
    try {
      db.prepare(`INSERT INTO t VALUES ('a')`).run();
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ code: 'SQLITE_CONSTRAINT_PRIMARYKEY' });
    expect((caught as Error).message).toContain('UNIQUE constraint failed: t.id');
  });
});

describe('BunSqliteDatabase connection surface', () => {
  it('applies WAL, foreign keys, and busy timeout pragmas on a file database', () => {
    const db = new BunSqliteDatabase(tempDb());
    expect(db.pragma('journal_mode = WAL')).toEqual([{ journal_mode: 'wal' }]);
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    db.close();
  });

  it('tracks transactions and rolls back a throwing transaction function', () => {
    const db = new BunSqliteDatabase();
    db.exec('CREATE TABLE t (a)');
    expect(db.inTransaction).toBe(false);
    db.exec('BEGIN IMMEDIATE');
    expect(db.inTransaction).toBe(true);
    db.exec('ROLLBACK');
    const tx = db.transaction(() => {
      db.prepare('INSERT INTO t VALUES (1)').run();
      throw new Error('boom');
    });
    expect(() => tx()).toThrow('boom');
    expect(db.prepare('SELECT count(*) AS n FROM t').get()).toEqual({ n: 0 });
  });

  it('reports open/closed and closes idempotently', () => {
    const db = new BunSqliteDatabase();
    expect(db.open).toBe(true);
    db.close();
    db.close();
    expect(db.open).toBe(false);
  });

  it('backs up to a file that reopens with the same rows', async () => {
    const path = tempDb();
    const db = new BunSqliteDatabase(path);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE t (a); INSERT INTO t VALUES (42);`);
    const copy = `${path}.bak`;
    await db.backup(copy);
    expect(new BunSqliteDatabase(copy).prepare('SELECT a FROM t').get()).toEqual({ a: 42 });
  });
});

describe('engine adapter over bun:sqlite', () => {
  it('uses the bun driver for the swapped seam', () => {
    expect(sqliteDriver.name).toBe('bun:sqlite');
  });

  it('migrates a file database idempotently and serializes file-backed transactions', async () => {
    const path = tempDb();
    const handle = getSqliteDb(path);
    expect(handle.sqlite).toBeInstanceOf(BunSqliteDatabase);
    const first = runMigrations(handle);
    expect(first.applied.length).toBeGreaterThan(50);
    expect(runMigrations(handle).applied).toEqual([]);
    expect(handle.sqlite.pragma('foreign_key_check')).toEqual([]);

    const { db } = handle;
    const result = await db.withTransaction((tx) => tx.all<{ n: number }>(sql`SELECT 7 AS n`));
    expect(result).toEqual([{ n: 7 }]);
    handle.sqlite.close();
  });
});
