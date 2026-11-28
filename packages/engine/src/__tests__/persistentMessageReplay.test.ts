import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { getSqliteDb, runMigrations } from '../adapters/node/database.js';
import { compileSqliteQuery } from '../adapters/sqlite-handle.js';
import * as sqlx from '../db/sqlx.js';
import { agents, workspaces } from '../db/tables.js';
import { sendDm } from '../engine/dm.js';
import { postReply } from '../engine/thread.js';
import * as atomic from '../ports/database.js';

const options = { workspaceDeliveryPolicy: { cap: 100, reserve: 0 } };

async function produce(
  body: string, selected: boolean, rollback: boolean, send: () => Promise<{ id: string }>,
) {
  const run = atomic.runAtomicWrites;
  let groups = 0;
  const spy = vi.spyOn(atomic, 'runAtomicWrites').mockImplementation(async (db, input, opts) => {
    if (typeof input !== 'function') return run(db, input, opts);
    let appended = false;
    const results = await run(db, tx => {
      const writes = input(tx);
      if (!writes.some(write => /^insert into "messages" /i.test(compileSqliteQuery(write.getSQL()).sql))) {
        return writes;
      }
      groups++;
      expect(opts?.requireAtomic).toBe(true);
      expect(tx).not.toBe(db);
      if (!selected) return writes;

      // Bodies are unique in this fixture. Use the real message ID as the
      // replay key, and require that its row already exists on this connection.
      const insert = sql`INSERT INTO fixture_outbox (message_id)
        VALUES ((SELECT id FROM messages WHERE body = ${body}))`;
      const enqueue: atomic.AtomicWrite = {
        getSQL: () => insert,
        then(resolve, reject) {
          return sqlx.run(tx, insert).then(() => {
            if (rollback) throw new Error('fixture rollback after enqueue');
          }).then(resolve, reject);
        },
      };
      appended = true;
      return [...writes, enqueue];
    }, opts);
    // The engine indexes results from both ends of its own statement list.
    return appended ? results.slice(0, -1) : results;
  });
  try {
    const result = await send();
    expect(groups).toBe(1);
    return result.id;
  } finally {
    spy.mockRestore();
  }
}

it.each(['sendDm', 'postReply'] as const)('%s replays a committed sink write across restart', async path => {
  const dir = mkdtempSync(join(tmpdir(), 'engine-message-replay-'));
  const producerPath = join(dir, 'producer.db');
  const sinkPath = join(dir, 'sink.db');
  let producer = getSqliteDb(producerPath);
  let sink = new Database(sinkPath);
  function restart() {
    producer.sqlite.close();
    sink.close();
    producer = getSqliteDb(producerPath);
    sink = new Database(sinkPath);
  }
  function deliver(ack: boolean) {
    const pending = producer.sqlite.prepare<[], { message_id: string }>(
      'SELECT message_id FROM fixture_outbox WHERE acked = 0 ORDER BY message_id',
    ).all();
    for (const { message_id } of pending) {
      sink.prepare('INSERT INTO items VALUES (?) ON CONFLICT(message_id) DO NOTHING').run(message_id);
      if (ack) producer.sqlite.prepare('UPDATE fixture_outbox SET acked = 1 WHERE message_id = ?').run(message_id);
    }
    return pending.map(row => row.message_id);
  }
  const items = () => sink.prepare<[], { message_id: string }>(
    'SELECT message_id FROM items ORDER BY message_id',
  ).all().map(row => row.message_id);
  const outbox = () => producer.sqlite.prepare('SELECT * FROM fixture_outbox ORDER BY message_id').all();
  try {
    runMigrations(producer);
    producer.sqlite.exec(`CREATE TABLE fixture_outbox (
      message_id TEXT NOT NULL PRIMARY KEY REFERENCES messages(id), acked INTEGER NOT NULL DEFAULT 0
    )`);
    sink.exec('CREATE TABLE items (message_id TEXT NOT NULL PRIMARY KEY)');
    const db = producer.db;
    await db.insert(workspaces).values({ id: 'ws', name: 'test', apiKeyHash: 'ws-hash' });
    for (const name of ['alice', 'bob']) {
      await db.insert(agents).values({ id: name, name, canonicalName: name, workspaceId: 'ws', tokenHash: name });
    }
    const dm = (text: string) => sendDm(db, 'ws', 'alice', { to: 'bob', text }, options);
    const parent = path === 'postReply' ? await dm('thread root') : undefined;
    const send = (text: string, selected: boolean, rollback = false) => produce(text, selected, rollback,
      () => parent ? postReply(db, 'ws', parent.id, 'bob', { text }, options) : dm(text));

    const unselected = await send('unselected', false);
    expect(outbox()).toEqual([]);
    const messages = () => producer.sqlite.prepare('SELECT id, body FROM messages ORDER BY id').all();
    const deliveries = () => producer.sqlite.prepare('SELECT * FROM deliveries ORDER BY id').all();
    const before = { messages: messages(), deliveries: deliveries() };
    expect(before.messages).toContainEqual({ id: unselected, body: 'unselected' });
    await expect(send('rolled back', true, true)).rejects.toThrow('fixture rollback after enqueue');
    expect(messages()).toEqual(before.messages);
    expect(deliveries()).toEqual(before.deliveries);
    expect(outbox()).toEqual([]);

    const keys = [await send('first selected', true), await send('second selected', true)].sort();
    const rows = (acked: number) => keys.map(message_id => ({ message_id, acked }));
    expect(outbox()).toEqual(rows(0));
    expect(deliver(false)).toEqual(keys);
    restart();
    expect(items()).toEqual(keys);
    expect(outbox()).toEqual(rows(0));
    expect(deliver(true)).toEqual(keys);
    restart();
    expect(outbox()).toEqual(rows(1));
    expect(deliver(true)).toEqual([]);
    expect(items()).toEqual(keys);
  } finally {
    if (producer.sqlite.open) producer.sqlite.close();
    if (sink.open) sink.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
