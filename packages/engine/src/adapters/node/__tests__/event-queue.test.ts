import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { getSqliteDb, runMigrations, type SqliteDbHandle } from '../database.js';
import { DurableEventQueue } from '../event-queue.js';
import { createNodeRuntime } from '../index.js';
import { claimDueEvents, enqueueEvent } from '../../../engine/eventQueue.js';
import { deliverEvent, WEBHOOK_RETRY_DELAYS_MS } from '../../../engine/eventDelivery.js';
import { BackgroundTasks } from '../../../__tests__/backgroundTasks.js';
import { pendingEvents, webhookDeliveries, workspaces, eventSubscriptions } from '../../../db/schema.js';
import { verifyStandardWebhook } from '../../../lib/standardWebhook.js';
import { nodeSafeWebhookFetch } from '../ssrf-fetch.js';

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
  opts: {
    secret?: string;
    url?: string;
    signatureScheme?: 'legacy' | 'standard-webhooks';
  } = {},
): Promise<string> {
  const id = `sub_${++seq}`;
  await db.insert(eventSubscriptions).values({
    id,
    workspaceId,
    events: ['*'],
    url: opts.url ?? HOOK_URL,
    secret: opts.secret ?? null,
    signatureScheme: opts.signatureScheme ?? 'legacy',
  });
  return id;
}

async function pendingRows(db: SqliteDbHandle['db']) {
  return db.select().from(pendingEvents);
}

function makeQueue(
  db: SqliteDbHandle['db'],
  opts: ConstructorParameters<typeof DurableEventQueue>[2] = {},
  onError: (err: unknown, ctx: Record<string, unknown>) => void = () => {},
): DurableEventQueue & { settle(): Promise<void> } {
  const testFetch: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init);
  const queue = new DurableEventQueue(db, onError, {
    pollIntervalMs: 0,
    fetch: testFetch,
    ...opts,
  });
  const tasks = new BackgroundTasks();
  const poll = queue.poll.bind(queue);
  queue.poll = () => tasks.track(poll());
  const observed = Object.assign(queue, { settle: () => tasks.drain() });
  queues.push(observed);
  return observed;
}

const queues: Array<DurableEventQueue & { settle(): Promise<void> }> = [];

const handles: SqliteDbHandle[] = [];
function track(handle: SqliteDbHandle): SqliteDbHandle {
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  for (const queue of queues.splice(0)) {
    queue.stop();
    await queue.settle();
  }
  vi.unstubAllGlobals();
  for (const handle of handles.splice(0)) {
    try { handle.sqlite.close(); } catch { /* already closed */ }
  }
});

describe('DurableEventQueue', () => {
  it('fails closed when a host omits its SSRF-safe fetch implementation', () => {
    const { db } = track(openDb());
    expect(() => new DurableEventQueue(db, undefined, { pollIntervalMs: 0 }))
      .toThrow(/SSRF-safe fetch/);
  });

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

    try {
      // The row is durable as soon as send resolves, while delivery is still in flight.
      const rows = await pendingRows(db);
      expect(rows).toHaveLength(1);
      expect(rows[0].eventType).toBe('message.created');
      expect(rows[0].status).toBe('pending');
    } finally {
      release();
      await queue.settle();
    }
    const [settled] = await pendingRows(db);
    expect(settled).toMatchObject({ status: 'completed' });
    expect(settled.completedAt).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('send with a pre-inserted outbox row (outboxId) does not double-insert', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    // The engine send path (routes/webhookOutbox.ts) inserted the row already.
    const data = { text: 'pre-inserted' };
    const outboxId = await enqueueEvent(db, ws, 'message.created', data);
    expect(await pendingRows(db)).toHaveLength(1);

    const queue = makeQueue(db);
    await queue.send({ type: 'message.created', workspaceId: ws, data, outboxId });

    await queue.settle();
    expect(await pendingRows(db)).toHaveLength(1);
    expect((await pendingRows(db))[0]).toMatchObject({ id: outboxId, status: 'completed' });
    // Exactly one delivery — a second row would have produced a second fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('successful delivery retains bounded health history and signs the payload', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws, { secret: 'shh' });

    const fetchMock = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = makeQueue(db);
    await enqueueEvent(db, ws, 'message.created', { text: 'hello' });
    await queue.poll();

    const [event] = await pendingRows(db);
    expect(event).toMatchObject({ status: 'completed' });
    expect(event.completedAt).not.toBeNull();
    const [delivery] = await db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ status: 'succeeded', attempts: 1, lastStatus: 200 });
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

    const queue = makeQueue(db);
    await enqueueEvent(db, ws, 'message.created', { text: 'retry me' });
    const before = Date.now();
    await queue.poll();

    const [row] = await pendingRows(db);
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/Retryable webhook delivery failures/);
    // The first per-subscriber retry uses the fixed 30s schedule.
    expect(row.processAfter.getTime()).toBeGreaterThan(before + 20_000);

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

  it('settles redirects as terminal without retrying them', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'https://other.example.test/hook' },
    }));
    const queue = makeQueue(db, { fetch: fetchMock as typeof globalThis.fetch });
    await enqueueEvent(db, ws, 'message.created', { text: 'do not follow' });

    await queue.poll();

    const [delivery] = await db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ status: 'failed', attempts: 1, lastStatus: 302 });
    expect((await pendingRows(db))[0]).toMatchObject({ status: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats a missing durable parent as an already-settled queue replay', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));

    const summary = await deliverEvent(db, ws, 'message.created', { text: 'stale replay' }, {
      eventId: 'evt_already_pruned',
      fetch: fetchMock as typeof globalThis.fetch,
    });

    expect(summary).toMatchObject({ attempted: 0, succeeded: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('retries only the failed subscriber and never re-sends to a successful one', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    const successfulUrl = 'https://hooks.example.test/success';
    const retryingUrl = 'https://hooks.example.test/retry';
    await seedSubscription(db, ws, { url: successfulUrl });
    await seedSubscription(db, ws, { url: retryingUrl });

    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      new Response(String(url) === successfulUrl ? null : '', {
        status: String(url) === successfulUrl ? 204 : 503,
      }));
    vi.stubGlobal('fetch', fetchMock);

    const queue = makeQueue(db);
    const eventId = await enqueueEvent(db, ws, 'message.created', { text: 'fanout' });
    await queue.poll();

    let deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries.map((row) => row.status).sort()).toEqual(['pending', 'succeeded']);
    expect(fetchMock.mock.calls.map(([url]) => String(url)).sort())
      .toEqual([retryingUrl, successfulUrl].sort());

    const due = new Date(Date.now() - 1_000);
    await db.update(webhookDeliveries)
      .set({ nextAttemptAt: due })
      .where(eq(webhookDeliveries.status, 'pending'));
    await db.update(pendingEvents).set({ processAfter: due }).where(eq(pendingEvents.id, eventId));
    await queue.poll();

    deliveries = await db.select().from(webhookDeliveries);
    expect(deliveries.find((row) => row.status === 'succeeded')?.attempts).toBe(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === successfulUrl)).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url) === retryingUrl)).toHaveLength(2);
  });

  it('uses a stable Standard Webhooks delivery id and valid signature across retries', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    const secret = 'whsec_MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
    await seedSubscription(db, ws, { secret, signatureScheme: 'standard-webhooks' });

    const attempts: Array<{ headers: Record<string, string>; body: string }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      attempts.push({ headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return new Response(attempts.length === 1 ? '' : null, { status: attempts.length === 1 ? 503 : 204 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const queue = makeQueue(db);
    const eventId = await enqueueEvent(db, ws, 'message.created', { text: 'signed' });
    await queue.poll();
    const due = new Date(Date.now() - 1_000);
    await db.update(webhookDeliveries).set({ nextAttemptAt: due });
    await db.update(pendingEvents).set({ processAfter: due }).where(eq(pendingEvents.id, eventId));
    await queue.poll();

    expect(attempts).toHaveLength(2);
    expect(attempts[0].headers['webhook-id']).toBe(attempts[1].headers['webhook-id']);
    for (const attempt of attempts) {
      await expect(verifyStandardWebhook(
        secret,
        attempt.headers['webhook-id'],
        attempt.headers['webhook-timestamp'],
        attempt.body,
        attempt.headers['webhook-signature'],
      )).resolves.toBe(true);
      expect(attempt.headers['X-Relay-Signature']).toBeUndefined();
    }
  });

  it('uses the exact retry schedule then dead-letters attempt seven', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    await seedSubscription(db, ws);
    const eventId = await enqueueEvent(db, ws, 'message.created', { text: 'dead letter' });
    const [event] = await db.select().from(pendingEvents).where(eq(pendingEvents.id, eventId));
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    let now = new Date(Math.ceil(Date.now() / 1000) * 1000 + 60 * 60_000);

    for (const delay of WEBHOOK_RETRY_DELAYS_MS) {
      await expect(deliverEvent(db, ws, event.eventType, event.payload as Record<string, unknown>, {
        eventId,
        eventTimestamp: event.createdAt,
        fetch: fetchMock as typeof globalThis.fetch,
        now,
      })).rejects.toMatchObject({ code: 'event_delivery_retryable_failure' });
      const [delivery] = await db.select().from(webhookDeliveries);
      expect(delivery.nextAttemptAt.getTime()).toBe(now.getTime() + delay);
      now = delivery.nextAttemptAt;
    }

    const summary = await deliverEvent(db, ws, event.eventType, event.payload as Record<string, unknown>, {
      eventId,
      eventTimestamp: event.createdAt,
      fetch: fetchMock as typeof globalThis.fetch,
      now,
    });
    expect(summary).toMatchObject({ failed: 1, deadLettered: 1, retryableFailures: 0 });
    const [delivery] = await db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({ status: 'dead_letter', attempts: 7, lastStatus: 503 });
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('dead-letters an expired final delivery lease without sending attempt eight', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    const subscriptionId = await seedSubscription(db, ws);
    const eventId = await enqueueEvent(db, ws, 'message.created', { text: 'leased final attempt' });
    const [event] = await db.select().from(pendingEvents).where(eq(pendingEvents.id, eventId));
    await db.update(pendingEvents)
      .set({ webhookInitialized: true })
      .where(eq(pendingEvents.id, eventId));
    await db.insert(webhookDeliveries).values({
      id: 'whd_expired_final_attempt',
      eventId,
      subscriptionId,
      attempts: 7,
      nextAttemptAt: new Date(Date.now() - 1_000),
    });
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));

    const summary = await deliverEvent(db, ws, event.eventType, event.payload as Record<string, unknown>, {
      eventId,
      eventTimestamp: event.createdAt,
      fetch: fetchMock as typeof globalThis.fetch,
      now: new Date(),
    });

    expect(summary).toMatchObject({ attempted: 1, failed: 1, deadLettered: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    const [delivery] = await db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({
      status: 'dead_letter',
      attempts: 7,
      lastError: 'attempts exhausted after delivery lease expired',
    });
  });

  it('settles a due delivery when its subscription becomes inactive', async () => {
    const { db } = track(openDb());
    const ws = await seedWorkspace(db);
    const subscriptionId = await seedSubscription(db, ws);
    const fetchMock = vi.fn(async () => new Response('', { status: 503 }));
    const queue = makeQueue(db, { fetch: fetchMock as typeof globalThis.fetch });
    const eventId = await enqueueEvent(db, ws, 'message.created', { text: 'disable target' });
    await queue.poll();

    const due = new Date(Date.now() - 1_000);
    await db.update(eventSubscriptions)
      .set({ isActive: false })
      .where(eq(eventSubscriptions.id, subscriptionId));
    await db.update(webhookDeliveries).set({ nextAttemptAt: due });
    await db.update(pendingEvents).set({ processAfter: due }).where(eq(pendingEvents.id, eventId));
    await queue.poll();

    const [delivery] = await db.select().from(webhookDeliveries);
    expect(delivery).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'subscription inactive or no longer matches this event',
    });
    const [event] = await pendingRows(db);
    expect(event).toMatchObject({ status: 'failed' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      const startup = vi.spyOn(DurableEventQueue.prototype, 'poll');
      const runtime = createNodeRuntime({
        dbPath,
        baseUrl: 'http://localhost:0',
        config: { environment: 'test' },
        presence: { sweepIntervalMs: 0 },
        eventQueue: { pollIntervalMs: 0 },
      });
      const startupWork = startup.mock.results.map((result) => result.value);
      startup.mockRestore();
      try {
        await Promise.all(startupWork);
        expect(await pendingRows(runtime.deps.db)).toHaveLength(1);
        expect((await pendingRows(runtime.deps.db))[0]).toMatchObject({ status: 'completed' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally {
        await Promise.all(startupWork);
        runtime.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves an explicit engine retention boundary over the local pruner default', async () => {
    const startup = vi.spyOn(DurableEventQueue.prototype, 'poll');
    const runtime = createNodeRuntime({
      dbPath: ':memory:',
      baseUrl: 'http://localhost:0',
      config: { retention: { messageTtlDays: 45 } },
      presence: { sweepIntervalMs: 0 },
      eventQueue: {
        pollIntervalMs: 0,
        retention: { defaults: { messageTtlDays: 7 } },
      },
    });
    const startupWork = startup.mock.results.map((result) => result.value);
    startup.mockRestore();
    try {
      expect(runtime.deps.config?.retention).toEqual({ messageTtlDays: 45 });
      // Vitest sets its own environment marker; only an explicit engine test
      // environment may downgrade the production DNS-pinning transport.
      expect(runtime.deps.config?.outboundWebhookFetch).toBe(nodeSafeWebhookFetch);
    } finally {
      await Promise.all(startupWork);
      runtime.close();
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
