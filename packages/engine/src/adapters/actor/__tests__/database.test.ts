import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createActorEngineDb, execPositional, isReadStatement } from '../database.js';
import { applyActorMigrations } from '../migrations.js';
import { FakeActorDatabase } from './fakeActor.js';
import { channels, messages, workspaces } from '../../../db/schema.js';
import { desc, eq } from 'drizzle-orm';

function engineDb(fake: FakeActorDatabase) {
  return createActorEngineDb(fake, { runGroup: (body) => body() });
}

describe('actor SQL shim', () => {
  it('keeps both values of a repeated result column', () => {
    const fake = new FakeActorDatabase();
    // The runtime contract the shim exists for: exec alone collapses the pair.
    expect(fake.exec('SELECT 1 AS id, 2 AS id')).toEqual([{ id: 2 }]);
    const [row] = execPositional(fake, 'SELECT 1 AS id, 2 AS id', []);
    expect([...row]).toEqual([1, 2]);
    expect((row as unknown as { id: number }).id).toBe(1);
  });

  it('recovers column order around integer-named columns', () => {
    const fake = new FakeActorDatabase();
    // JS enumerates the "0" key first; the result order is id, name, 0.
    fake.exec('CREATE TABLE t (id TEXT, name TEXT)');
    fake.exec("INSERT INTO t VALUES ('a', 'alice'), ('b', 'bob')");
    const statement = 'select "id", "name", 0 from "t" order by "id" desc';
    expect(Object.keys(fake.exec(statement)[0])).toEqual(['0', 'id', 'name']);
    expect(execPositional(fake, statement, []).map((row) => [...row])).toEqual([['b', 'bob', 0], ['a', 'alice', 0]]);
    // Once seen, the statement runs positionally from the start.
    const before = fake.statements;
    expect(execPositional(fake, statement, []).map((row) => [...row])).toEqual([['b', 'bob', 0], ['a', 'alice', 0]]);
    expect(fake.statements - before).toBe(1);
    // A CTE read with integer-named columns nests inside the positional wrapper.
    expect([...execPositional(fake, 'WITH x AS (SELECT 5 AS v) SELECT v, 7 FROM x', [])[0]]).toEqual([5, 7]);
    expect([...execPositional(fake, 'SELECT 1', [])[0]]).toEqual([1]);
  });

  it('runs writes and RETURNING unwrapped', () => {
    const fake = new FakeActorDatabase();
    fake.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    expect(isReadStatement('INSERT INTO t (name) VALUES (?) RETURNING id, name')).toBe(false);
    const rows = execPositional(fake, 'INSERT INTO t (name) VALUES (?) RETURNING id, name', ['a']);
    expect(rows.map((row) => [...row])).toEqual([[1, 'a']]);
  });

  it('classifies reads behind comments and CTEs', () => {
    expect(isReadStatement('  -- note\n/* x */ with page AS (SELECT 1) SELECT * FROM page')).toBe(true);
    expect(isReadStatement('select 1')).toBe(true);
    expect(isReadStatement('UPDATE t SET a = 1')).toBe(false);
  });

  it('keeps the order of ordered engine queries, joins, and CTE pages', async () => {
    const fake = new FakeActorDatabase();
    applyActorMigrations(fake);
    const db = engineDb(fake);
    await db.insert(workspaces).values({ id: 'w1', name: 'w', apiKeyHash: 'h' });
    await db.insert(channels).values({ id: 'c1', workspaceId: 'w1', name: 'general' });
    fake.exec("INSERT INTO agents (id, workspace_id, name, token_hash) VALUES ('a1', 'w1', 'alice', 't')");
    const ids = ['m03', 'm01', 'm05', 'm02', 'm04'];
    for (const id of ids) {
      await db.insert(messages).values({ id, workspaceId: 'w1', channelId: 'c1', agentId: 'a1', body: id });
    }

    const ordered = await db.select({ id: messages.id }).from(messages).orderBy(desc(messages.id)).limit(4);
    expect(ordered.map((row) => row.id)).toEqual(['m05', 'm04', 'm03', 'm02']);

    // A join that repeats `id` and `name`: builder mapping is positional.
    const joined = await db
      .select({ channelId: channels.id, channelName: channels.name, workspaceId: workspaces.id, workspaceName: workspaces.name })
      .from(channels)
      .innerJoin(workspaces, eq(channels.workspaceId, workspaces.id));
    expect(joined).toEqual([{ channelId: 'c1', channelName: 'general', workspaceId: 'w1', workspaceName: 'w' }]);

    // The engine's retention pages: a raw CTE read by column name, in order.
    const page = await db.all<{ id: string; body: string }>(sql`
      WITH page AS MATERIALIZED (SELECT id, body FROM messages ORDER BY id DESC LIMIT 3)
      SELECT id, body FROM page ORDER BY id`);
    expect(page.map((row) => row.id)).toEqual(['m03', 'm04', 'm05']);
  });
});

describe('bundled actor migrations', () => {
  it('match src/db/migrations', async () => {
    const generator = new URL('../../../../scripts/generate-actor-migrations.mjs', import.meta.url);
    const { renderActorMigrations } = await import(fileURLToPath(generator)) as { renderActorMigrations: () => string };
    const generated = readFileSync(fileURLToPath(new URL('../migrations.generated.ts', import.meta.url)), 'utf8');
    expect(generated).toBe(renderActorMigrations());
  });

  it('apply one statement at a time, once', () => {
    const fake = new FakeActorDatabase();
    const first = applyActorMigrations(fake);
    expect(first.applied.length).toBeGreaterThan(70);
    const triggers = fake.exec("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'") as { n: number }[];
    expect(triggers[0].n).toBeGreaterThan(20);
    const before = fake.statements;
    expect(applyActorMigrations(fake).applied).toEqual([]);
    expect(fake.statements - before).toBe(2);
  });
});

describe('actor constraint errors', () => {
  it('carry the code engine classifiers read', () => {
    const fake = new FakeActorDatabase();
    fake.exec('CREATE TABLE u (id TEXT PRIMARY KEY, name TEXT UNIQUE)');
    fake.exec("INSERT INTO u VALUES ('1', 'a')");
    let raw: unknown;
    try { fake.exec("INSERT INTO u VALUES ('2', 'a')"); } catch (error) { raw = error; }
    expect((raw as { code?: string }).code).toBeUndefined();
    expect(() => execPositional(fake, "INSERT INTO u VALUES ('2', 'a')", [])).toThrow(
      expect.objectContaining({ code: 'SQLITE_CONSTRAINT_UNIQUE', message: expect.stringContaining('UNIQUE constraint failed: u.name') }),
    );
  });
});
