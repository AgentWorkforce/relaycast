import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../../adapters/node/database.js';
import { workspaceEvents, workspaces } from '../../db/schema.js';
import {
  appendAndPublishWorkspaceEvent,
  appendWorkspaceEvents,
  appendWorkspaceEvent,
  listWorkspaceEvents,
} from '../workspaceEvents.js';
import { pruneExpired } from '../retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function openDb(): SqliteDbHandle {
  const handle = getSqliteDb(':memory:');
  runMigrations(handle);
  return handle;
}

const handles: SqliteDbHandle[] = [];
function track(handle: SqliteDbHandle): SqliteDbHandle {
  handles.push(handle);
  return handle;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const handle of handles.splice(0)) {
    try { handle.sqlite.close(); } catch { /* already closed */ }
  }
});

describe('appendWorkspaceEvent', () => {
  it('assigns per-workspace monotonic seq starting at 1', async () => {
    const { db } = track(openDb());

    expect(await appendWorkspaceEvent(db, 'ws_a', { type: 'message.created', channelId: 'ch_1', payload: { type: 'message.created', n: 1 } })).toBe(1);
    expect(await appendWorkspaceEvent(db, 'ws_a', { type: 'agent.status.active', payload: { type: 'agent.status.active', n: 2 } })).toBe(2);
    expect(await appendWorkspaceEvent(db, 'ws_a', { type: 'message.created', channelId: 'ch_1', payload: { type: 'message.created', n: 3 } })).toBe(3);
    // Independent counter per workspace.
    expect(await appendWorkspaceEvent(db, 'ws_b', { type: 'message.created', payload: { type: 'message.created' } })).toBe(1);

    const rows = await db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, 'ws_a'));
    expect(rows.map((r) => r.seq).sort()).toEqual([1, 2, 3]);
    expect(rows.find((r) => r.seq === 1)?.channelId).toBe('ch_1');
    expect(rows.find((r) => r.seq === 2)?.channelId).toBeNull();
    // Stored payload is the exact frame, without seq.
    expect(JSON.parse(rows.find((r) => r.seq === 1)!.payload)).toEqual({ type: 'message.created', n: 1 });
  });

  it('is best-effort: returns null and warns instead of throwing when the insert fails', async () => {
    const handle = track(openDb());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle.sqlite.exec('DROP TABLE workspace_events');

    await expect(
      appendWorkspaceEvent(handle.db, 'ws_a', { type: 'message.created', payload: { type: 'message.created' } }),
    ).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('appends large event sets in D1-safe chunks with contiguous sequence numbers', async () => {
    const { db } = track(openDb());
    await appendWorkspaceEvent(db, 'ws_a', { type: 'seed', payload: { n: 0 } });

    const seqs = await appendWorkspaceEvents(
      db,
      'ws_a',
      Array.from({ length: 65 }, (_, index) => ({
        type: 'delivery.failed',
        payload: { type: 'delivery.failed', n: index + 1 },
      })),
    );

    expect(seqs).toEqual(Array.from({ length: 65 }, (_, index) => index + 2));
    const rows = await db
      .select()
      .from(workspaceEvents)
      .where(eq(workspaceEvents.workspaceId, 'ws_a'));
    expect(rows).toHaveLength(66);
    expect(new Set(rows.map((row) => row.seq)).size).toBe(66);
  });
});

describe('listWorkspaceEvents', () => {
  it('returns events after the cursor in ascending seq order with latestSeq', async () => {
    const { db } = track(openDb());
    for (let n = 1; n <= 5; n++) {
      await appendWorkspaceEvent(db, 'ws_a', { type: 'message.created', channelId: 'ch_1', payload: { type: 'message.created', n } });
    }
    await appendWorkspaceEvent(db, 'ws_b', { type: 'message.created', payload: { type: 'message.created' } });

    const page = await listWorkspaceEvents(db, 'ws_a', { since: 2, limit: 2 });
    expect(page.latestSeq).toBe(5);
    expect(page.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(page.events[0]).toMatchObject({
      type: 'message.created',
      channel_id: 'ch_1',
      payload: { type: 'message.created', n: 3 },
    });
    expect(typeof page.events[0].created_at).toBe('string');

    const caughtUp = await listWorkspaceEvents(db, 'ws_a', { since: 5 });
    expect(caughtUp.events).toEqual([]);
    expect(caughtUp.latestSeq).toBe(5);

    const empty = await listWorkspaceEvents(db, 'ws_missing', {});
    expect(empty.events).toEqual([]);
    expect(empty.latestSeq).toBe(0);
  });
});

describe('appendAndPublishWorkspaceEvent', () => {
  function capturingRealtime() {
    const published: Array<{ workspaceId: string; event: Record<string, unknown> }> = [];
    return {
      published,
      realtime: {
        publishToWorkspaceStream: async (args: { workspaceId: string; event: Record<string, unknown> }) => {
          published.push(args);
        },
      },
    };
  }

  it('appends first and stamps the assigned seq onto the published frame', async () => {
    const { db } = track(openDb());
    const { published, realtime } = capturingRealtime();

    await appendAndPublishWorkspaceEvent({ db, realtime }, 'ws_a', {
      type: 'message.created',
      channelId: 'ch_1',
      payload: { type: 'message.created', message: { text: 'hi' } },
    });
    await appendAndPublishWorkspaceEvent({ db, realtime }, 'ws_a', {
      type: 'message.created',
      payload: { type: 'message.created', message: { text: 'again' } },
    });

    expect(published.map((p) => p.event.seq)).toEqual([1, 2]);
    // Stored payload stays unstamped; seq lives in the column.
    const rows = await db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, 'ws_a'));
    for (const row of rows) {
      expect(JSON.parse(row.payload)).not.toHaveProperty('seq');
    }
  });

  it('still publishes (unstamped) when the append fails, and reports publish errors without throwing', async () => {
    const handle = track(openDb());
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    handle.sqlite.exec('DROP TABLE workspace_events');
    const { published, realtime } = capturingRealtime();

    await appendAndPublishWorkspaceEvent({ db: handle.db, realtime }, 'ws_a', {
      type: 'message.created',
      payload: { type: 'message.created', message: { text: 'hi' } },
    });
    expect(published).toHaveLength(1);
    expect(published[0].event).not.toHaveProperty('seq');

    const publishErrors: unknown[] = [];
    await expect(appendAndPublishWorkspaceEvent(
      {
        db: handle.db,
        realtime: { publishToWorkspaceStream: async () => { throw new Error('stream down'); } },
      },
      'ws_a',
      { type: 'message.created', payload: { type: 'message.created' } },
      (err) => publishErrors.push(err),
    )).resolves.toBeUndefined();
    expect(publishErrors).toHaveLength(1);
  });
});

describe('workspace event retention', () => {
  it('prunes rows older than the 30-day default and honors per-workspace overrides', async () => {
    const { db } = track(openDb());
    const now = new Date();
    await db.insert(workspaces).values({ id: 'ws_default', name: 'default', apiKeyHash: 'hash_default' });
    await db.insert(workspaces).values({
      id: 'ws_keep',
      name: 'keep',
      apiKeyHash: 'hash_keep',
      retention: { workspace_event_ttl_days: null },
    });

    await db.insert(workspaceEvents).values([
      { workspaceId: 'ws_default', seq: 1, type: 't', payload: '{}', createdAt: new Date(now.getTime() - 40 * DAY_MS) },
      { workspaceId: 'ws_default', seq: 2, type: 't', payload: '{}', createdAt: new Date(now.getTime() - 1 * DAY_MS) },
      { workspaceId: 'ws_keep', seq: 1, type: 't', payload: '{}', createdAt: new Date(now.getTime() - 40 * DAY_MS) },
    ]);

    const result = await pruneExpired(db, { now });
    expect(result.workspaceEvents).toBe(1);

    const remainingDefault = await db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, 'ws_default'));
    expect(remainingDefault.map((r) => r.seq)).toEqual([2]);
    // Explicit null disables pruning for that workspace.
    const remainingKeep = await db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, 'ws_keep'));
    expect(remainingKeep).toHaveLength(1);
  });

  it('always retains the highest-seq row so the sequence never resets across pruning', async () => {
    const { db } = track(openDb());
    const now = new Date();
    await db.insert(workspaces).values({ id: 'ws_idle', name: 'idle', apiKeyHash: 'hash_idle' });

    // Every row is past the TTL — an idle workspace.
    await db.insert(workspaceEvents).values([
      { workspaceId: 'ws_idle', seq: 1, type: 't', payload: '{}', createdAt: new Date(now.getTime() - 90 * DAY_MS) },
      { workspaceId: 'ws_idle', seq: 2, type: 't', payload: '{}', createdAt: new Date(now.getTime() - 80 * DAY_MS) },
      { workspaceId: 'ws_idle', seq: 3, type: 't', payload: '{}', createdAt: new Date(now.getTime() - 70 * DAY_MS) },
    ]);

    const result = await pruneExpired(db, { now });
    expect(result.workspaceEvents).toBe(2);

    // The high-water row survives...
    const remaining = await db.select().from(workspaceEvents).where(eq(workspaceEvents.workspaceId, 'ws_idle'));
    expect(remaining.map((r) => r.seq)).toEqual([3]);

    // ...so the next event continues the sequence instead of resetting to 1,
    // keeping persisted observer cursors (e.g. since=3) valid.
    const seq = await appendWorkspaceEvent(db, 'ws_idle', { type: 't', payload: {} });
    expect(seq).toBe(4);
  });
});
