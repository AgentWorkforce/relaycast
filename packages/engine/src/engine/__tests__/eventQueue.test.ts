import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { pendingEvents, workspaces } from '../../db/schema.js';
import { enqueueEvent, sweepPendingEvents } from '../eventQueue.js';

let seq = 0;

function openDb(): SqliteDbHandle {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  return handle;
}

async function seedWorkspace(db: SqliteDbHandle['db']): Promise<string> {
  const id = `ws_${++seq}`;
  await db.insert(workspaces).values({ id, name: 'test', apiKeyHash: `hash_${id}` });
  return id;
}

const handles: SqliteDbHandle[] = [];
function track(handle: SqliteDbHandle): SqliteDbHandle {
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try { handle.sqlite.close(); } catch { /* already closed */ }
  }
});

describe('sweepPendingEvents', () => {
  it('claims each due row exactly once across concurrent sweepers', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    const ids = await Promise.all(
      Array.from({ length: 5 }, (_, i) => enqueueEvent(db, ws, 'message.created', { n: i })),
    );

    const [a, b] = await Promise.all([
      sweepPendingEvents(db, { limit: 10 }),
      sweepPendingEvents(db, { limit: 10 }),
    ]);

    const claimedIds = [...a, ...b].map((e) => e.id);
    expect(claimedIds).toHaveLength(5); // every row claimed...
    expect(new Set(claimedIds).size).toBe(5); // ...and none claimed twice
    expect(new Set(claimedIds)).toEqual(new Set(ids));
  });

  it('does not re-claim a row while its lease is live, and re-claims after expiry', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    const id = await enqueueEvent(db, ws, 'message.created', { text: 'leased' });

    const first = await sweepPendingEvents(db, { leaseMs: 60_000 });
    expect(first.map((e) => e.id)).toEqual([id]);
    expect(first[0].attempts).toBe(1);

    // Lease still live — a second sweeper sees nothing.
    expect(await sweepPendingEvents(db, { leaseMs: 60_000 })).toHaveLength(0);

    // After the lease expires (sweeper crashed without settling) the row is due again.
    const later = new Date(Date.now() + 61_000);
    const reclaimed = await sweepPendingEvents(db, { leaseMs: 60_000, now: later });
    expect(reclaimed.map((e) => e.id)).toEqual([id]);
    expect(reclaimed[0].attempts).toBe(2);
  });

  it('settle callbacks complete, fail, and reschedule the claimed row', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await enqueueEvent(db, ws, 'a.completed', {});
    await enqueueEvent(db, ws, 'b.failed', {});
    await enqueueEvent(db, ws, 'c.rescheduled', {});

    const swept = await sweepPendingEvents(db, { limit: 10 });
    const byType = Object.fromEntries(swept.map((e) => [e.eventType, e]));

    await byType['a.completed'].complete();
    await byType['b.failed'].fail('terminal');
    const before = Date.now();
    await byType['c.rescheduled'].reschedule('try later', 120_000);

    const rows = await db.select().from(pendingEvents);
    expect(rows.map((r) => r.eventType).sort()).toEqual(['b.failed', 'c.rescheduled']);

    const failed = rows.find((r) => r.eventType === 'b.failed')!;
    expect(failed.status).toBe('failed');
    expect(failed.lastError).toBe('terminal');

    const rescheduled = rows.find((r) => r.eventType === 'c.rescheduled')!;
    expect(rescheduled.status).toBe('pending');
    expect(rescheduled.processAfter.getTime()).toBeGreaterThan(before + 110_000);
  });

  it('never claims settled rows', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    const id = await enqueueEvent(db, ws, 'message.created', {});
    await db.update(pendingEvents).set({ status: 'failed' }).where(eq(pendingEvents.id, id));

    expect(await sweepPendingEvents(db, { limit: 10 })).toHaveLength(0);
  });
});
