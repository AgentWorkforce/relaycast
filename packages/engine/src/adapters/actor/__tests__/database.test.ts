import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createActorEngineDb } from '../database.js';
import { applyActorMigrations } from '../migrations.js';
import { FakeActorDatabase } from './fakeActor.js';
import { channels, messages, workspaces } from '../../../db/schema.js';
import { desc, eq } from 'drizzle-orm';
import { appendWorkspaceEventBatch } from '../../../engine/workspaceEvents.js';

function engineDb(fake: FakeActorDatabase) {
  return createActorEngineDb(fake);
}

describe('actor engine database', () => {
  it('maps rows positionally and by name, keeping the first of a repeated name', async () => {
    const fake = new FakeActorDatabase();
    // exec alone collapses a repeated column name; query keeps both values.
    expect(fake.exec('SELECT 1 AS id, 2 AS id')).toEqual([{ id: 2 }]);
    const db = engineDb(fake);
    const [row] = await db.all<unknown[] & { id: number }>(sql`SELECT 1 AS id, 2 AS id, 3 AS "0", 4 AS length`);
    expect([...row]).toEqual([1, 2, 3, 4]);
    expect(row.id).toBe(1);
    // Integer-like names and `length` stay positional only.
    expect(row[0]).toBe(1);
    expect(row.length).toBe(4);
  });

  it('runs writes, RETURNING and CTE writes as they are', async () => {
    const fake = new FakeActorDatabase();
    fake.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
    const db = engineDb(fake);
    const inserted = await db.all<{ id: number; name: string }>(sql`INSERT INTO t (name) VALUES ('a') RETURNING id, name`);
    expect(inserted.map((row) => [row.id, row.name])).toEqual([[1, 'a']]);
    await db.run(sql`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 3) DELETE FROM t WHERE id IN n`);
    expect(fake.exec('SELECT COUNT(*) AS n FROM t')).toEqual([{ n: 0 }]);
  });

  it('rolls back a failed write group alone and goes on', async () => {
    const fake = new FakeActorDatabase();
    fake.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
    const failures: unknown[] = [];
    let groups = 0;
    const db = createActorEngineDb(fake, { onGroupStart: () => { groups += 1; }, onGroupFailure: (error) => failures.push(error) });
    await fake.atomic(async () => {
      await db.run(sql`INSERT INTO t (name) VALUES ('kept')`);
      await expect(db.withTransaction(async (tx) => {
        await tx.run(sql`INSERT INTO t (name) VALUES ('rolled back')`);
        await tx.run(sql`INSERT INTO t (name) VALUES ('kept')`);
      })).rejects.toMatchObject({ cause: { code: 'SQLITE_CONSTRAINT_UNIQUE' } });
      await db.withTransaction((tx) => tx.run(sql`INSERT INTO t (name) VALUES ('after')`));
    });
    expect(fake.exec('SELECT name FROM t ORDER BY id')).toEqual([{ name: 'kept' }, { name: 'after' }]);
    expect(groups).toBe(2);
    expect(failures).toHaveLength(1);
  });

  it('appends a workspace event batch (a CTE INSERT ... RETURNING) through the actor database', async () => {
    const fake = new FakeActorDatabase();
    applyActorMigrations(fake);
    const db = engineDb(fake);
    await db.insert(workspaces).values({ id: 'w1', name: 'w', apiKeyHash: 'h' });
    const seqs = await appendWorkspaceEventBatch(db, [
      { workspaceId: 'w1', input: { type: 'delivery.failed', payload: { n: 1 } } },
      { workspaceId: 'w1', input: { type: 'delivery.failed', payload: { n: 2 } } },
    ]);
    expect(seqs).toEqual([1, 2]);
    expect(fake.exec('SELECT seq, type FROM workspace_events ORDER BY seq')).toEqual([
      { seq: 1, type: 'delivery.failed' },
      { seq: 2, type: 'delivery.failed' },
    ]);
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
  it('carry the code engine classifiers read', async () => {
    const fake = new FakeActorDatabase();
    fake.exec('CREATE TABLE u (id TEXT PRIMARY KEY, name TEXT UNIQUE)');
    fake.exec("INSERT INTO u VALUES ('1', 'a')");
    let raw: unknown;
    try { fake.exec("INSERT INTO u VALUES ('2', 'a')"); } catch (error) { raw = error; }
    expect((raw as { code?: string }).code).toBeUndefined();
    await expect(engineDb(fake).run(sql`INSERT INTO u VALUES ('2', 'a')`)).rejects.toMatchObject({
      cause: { code: 'SQLITE_CONSTRAINT_UNIQUE', message: expect.stringContaining('UNIQUE constraint failed: u.name') },
    });
  });
});
