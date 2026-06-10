import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../database.js';
import { DurableEventQueue } from '../event-queue.js';
import { createNodeRuntime } from '../index.js';
import { claimDueEvents, enqueueEvent } from '../../../engine/eventQueue.js';
import { pendingEvents, workspaces, eventSubscriptions } from '../../../db/schema.js';

const HOOK_URL = 'https://hooks.example.test/relay';

let seq = 0;

function openDb(path = ':memory:'): SqliteDbHandle {
  const handle = getSqliteDb(path);
  runMigrations(handle);
  return handle;
}

async function seedWorkspace(db: SqliteDbHandle['db']): Promise<string> {
  const id = `ws_${++seq}`;
  await db.insert(workspaces).values({ id, name: 'test', apiKeyHash: `hash_${id}` });
  return id;
}

async function seedSubscription(
  db: SqliteDbHandle['db'],
  workspaceId: string,
  opts: { secret?: string } = {},
): Promise<void> {
  await db.insert(eventSubscriptions).values({
    id: `sub_${++seq}`,
    workspaceId,
    events: ['*'],
    url: HOOK_URL,
    secret: opts.secret ?? null,
  });
}

async function pendingRows(db: SqliteDbHandle['db']) {
  return db.select().from(pendingEvents);
}

async function waitFor(cond: () => Promise<boolean> | boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function makeQueue(
  db: SqliteDbHandle['db'],
  opts: ConstructorParameters<typeof DurableEventQueue>[2] = {},
  onError: (err: unknown, ctx: Record<string, unknown>) => void = () => {},
): DurableEventQueue {
  return new DurableEventQueue(db, onError, { pollIntervalMs: 0, ...opts });
}

const handles: SqliteDbHandle[] = [];
function track(handle: SqliteDbHandle): SqliteDbHandle {
  handles.push(handle);
  return handle;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const handle of handles.splice(0)) {
    try { handle.sqlite.close(); } catch { /* already closed */ }
  }
});

describe('DurableEventQueue', () => {
  it('send persists the outbox row before delivery completes', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response('ok', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const queue = makeQueue(db);
    await queue.send({ type: 'message.created', workspaceId: ws, data: { text: 'hi' } });

    // The row is durable as soon as send resolves, while delivery is still in flight.
    const rows = await pendingRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('message.created');
    expect(rows[0].status).toBe('pending');

    release();
    await waitFor(async () => (await pendingRows(db)).length === 0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('successful delivery deletes the row and signs the payload', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws, { secret: 'shh' });

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = makeQueue(db);
    await enqueueEvent(db, ws, 'message.created', { text: 'hello' });
    await queue.poll();

    expect(await pendingRows(db)).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(HOOK_URL);
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Relay-Event']).toBe('message.created');
    expect(headers['X-Relay-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('retryable failure keeps the row pending with attempts++ and backoff', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);

    const fetchMock = vi.fn(async () => new Response('boom', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = makeQueue(db, { baseBackoffMs: 60_000 });
    await enqueueEvent(db, ws, 'message.created', { text: 'retry me' });
    const before = Date.now();
    await queue.poll();

    const [row] = await pendingRows(db);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/Retryable webhook delivery failures/);
    // processAfter pushed out by the 60s backoff (well beyond the claim lease).
    expect(row.processAfter.getTime()).toBeGreaterThan(before + 50_000);

    // Not due yet — a second poll claims nothing and sends nothing new.
    const callsAfterFirstPoll = fetchMock.mock.calls.length;
    await queue.poll();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirstPoll);
  });

  it('terminal 4xx settles the row as failed without retrying', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);

    const fetchMock = vi.fn(async () => new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = makeQueue(db);
    await enqueueEvent(db, ws, 'message.created', { text: 'never valid' });
    await queue.poll();

    const [row] = await pendingRows(db);
    expect(row.status).toBe('failed');
    expect(row.completedAt).not.toBeNull();
    expect(row.lastError).toMatch(/terminal delivery failure/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 400 is not retried inline either

    await queue.poll();
    expect(fetchMock).toHaveBeenCalledTimes(1); // settled rows are never reclaimed
  });

  it('exhausting maxAttempts settles the row as failed', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));

    const errors: Record<string, unknown>[] = [];
    const queue = makeQueue(db, {}, (_err, ctx) => errors.push(ctx));
    const id = await enqueueEvent(db, ws, 'message.created', { text: 'doomed' });
    await db.update(pendingEvents).set({ maxAttempts: 1 }).where(eq(pendingEvents.id, id));
    await queue.poll();

    const [row] = await pendingRows(db);
    expect(row.status).toBe('failed');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/attempts exhausted/);
    expect(errors).toContainEqual(expect.objectContaining({ settled: 'failed' }));
  });

  it('settles an expired final-attempt lease after a crash', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const id = await enqueueEvent(db, ws, 'message.created', { text: 'leased' });
    await db.update(pendingEvents).set({ maxAttempts: 1 }).where(eq(pendingEvents.id, id));

    const [claimed] = await claimDueEvents(db, { leaseMs: 60_000 });
    expect(claimed.id).toBe(id);
    expect(claimed.attempts).toBe(1);

    await db
      .update(pendingEvents)
      .set({ processAfter: new Date(Date.now() - 1_000) })
      .where(eq(pendingEvents.id, id));

    const queue = makeQueue(db);
    await queue.poll();

    const [row] = await pendingRows(db);
    expect(row.status).toBe('failed');
    expect(row.completedAt).not.toBeNull();
    expect(row.lastError).toMatch(/lease expired/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resumes pending deliveries after a restart over the same database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'relaycast-outbox-'));
    const dbPath = join(dir, 'engine.db');
    try {
      // First process: persist an event, then "crash" before delivering it.
      const first = openDb(dbPath);
      const ws = await seedWorkspace(first.db);
      await seedSubscription(first.db, ws);
      await enqueueEvent(first.db, ws, 'message.created', { text: 'survive me' });
      first.sqlite.close();

      const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      // Second process: a fresh runtime over the same file resumes the outbox.
      const runtime = createNodeRuntime({
        dbPath,
        baseUrl: 'http://localhost:0',
        presence: { sweepIntervalMs: 0 },
        eventQueue: { pollIntervalMs: 0 },
      });
      try {
        await waitFor(async () => (await pendingRows(runtime.deps.db)).length === 0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        runtime.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes settled rows older than 24h on the poll cadence', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);

    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db.insert(pendingEvents).values([
      {
        id: 'evt_old',
        workspaceId: ws,
        eventType: 'message.created',
        payload: {},
        status: 'failed',
        createdAt: old,
        completedAt: old,
      },
      {
        id: 'evt_fresh',
        workspaceId: ws,
        eventType: 'message.created',
        payload: {},
        status: 'failed',
        completedAt: new Date(),
      },
    ]);

    const queue = makeQueue(db, { cleanupIntervalMs: 0 });
    await queue.poll();

    const rows = await pendingRows(db);
    expect(rows.map((r) => r.id)).toEqual(['evt_fresh']);
  });
});
