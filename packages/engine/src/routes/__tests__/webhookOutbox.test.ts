import { createEngine } from '../../engine.js';
import { BackgroundTasks } from '../../__tests__/backgroundTasks.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EventQueue, QueuedEvent } from '../../ports/event-queue.js';
import type { EngineDb } from '../../ports/database.js';
import { messages, pendingEvents } from '../../db/schema.js';
import { sweepPendingEvents } from '../../engine/eventQueue.js';
import { createWorkspace, registerAgent, makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';
import type { KeyValueStore } from '../../ports/kv.js';
import { buildIdempotencyStorageKey } from '../../middleware/idempotency.js';

/**
 * Captures what the EventQueue port receives from the engine send path, and
 * snapshots the outbox row state at the moment `send` is invoked — proving
 * the row was inserted in the request path BEFORE the adapter saw the event.
 */
class CapturingQueue implements EventQueue {
  readonly sent: QueuedEvent[] = [];
  readonly rowsVisibleAtSend: boolean[] = [];
  failure: Error | undefined;
  rejects = false;

  constructor(private readonly db: EngineDb) {}

  async send(message: QueuedEvent): Promise<void> {
    this.sent.push(message);
    const rows = message.outboxId
      ? await this.db.select().from(pendingEvents).where(eq(pendingEvents.id, message.outboxId))
      : [];
    this.rowsVisibleAtSend.push(rows.length === 1);
    if (this.failure && !this.rejects) throw this.failure; // synchronous-style throw inside async fn
    if (this.failure) await Promise.reject(this.failure);
  }

  ofType(type: string): QueuedEvent[] {
    return this.sent.filter((e) => e.type === type);
  }
}

class ObservingKv implements KeyValueStore {
  constructor(
    private readonly inner: KeyValueStore,
    private readonly onPut: (key: string, value: string) => Promise<void> | void,
  ) {}

  get(key: string): Promise<string | null> {
    return this.inner.get(key);
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    await this.onPut(key, value);
    await this.inner.put(key, value, options);
  }

  delete(key: string): Promise<void> {
    return this.inner.delete(key);
  }

  increment(key: string, delta: number): Promise<number> {
    return this.inner.increment(key, delta);
  }
}

interface OutboxStack extends TestStack {
  queue: CapturingQueue;
  db: EngineDb;
}

/** Engine on the Node adapter with the webhook queue swapped for a capturing fake. */
function makeStack(opts: { onKvPut?: (key: string, value: string) => Promise<void> | void } = {}): OutboxStack {
  const stack = makeNodeStack();
  const { runtime } = stack;
  // The real DurableEventQueue would claim + deliver the rows; stop it and
  // inject a fake so the rows stay visible to assertions.
  runtime.webhookQueue.stop();
  const queue = new CapturingQueue(runtime.deps.db);
  runtime.deps.webhookQueue = queue;
  if (opts.onKvPut) {
    runtime.deps.kv = new ObservingKv(runtime.deps.kv, opts.onKvPut);
  }
  const tasks = new BackgroundTasks();
  const app = createEngine(runtime.deps);
  tasks.bind(app);
  return {
    ...stack, app, queue, db: runtime.deps.db,
    settle: async () => { await tasks.drain(); await stack.settle(); },
    close: async () => {
      try { await tasks.drain(); } finally { await stack.close(); }
    },
  };
}

const stacks: OutboxStack[] = [];
function track(stack: OutboxStack): OutboxStack {
  stacks.push(stack);
  return stack;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(stacks.splice(0).map((stack) => stack.close()));
});

async function postMessage(stack: OutboxStack, headers: Record<string, string> = {}): Promise<Response> {
  const ws = await createWorkspace(stack.app, 'outbox-ws');
  // The outbox path skips workspaces without subscribers entirely; these tests
  // exercise persist-first ordering, so the workspace needs a subscription.
  const subRes = await stack.app.request('/v1/subscriptions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
    body: JSON.stringify({ events: ['*'], url: 'http://127.0.0.1:1/hook' }),
  });
  expect(subRes.status).toBe(201);
  const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
  return stack.app.request('/v1/channels/general/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}`, ...headers },
    body: JSON.stringify({ text: 'persist me' }),
  });
}

async function postKeyedDm(stack: OutboxStack, subscribed: boolean, key: string) {
  const ws = await createWorkspace(stack.app, `dm-outbox-${key}`);
  if (subscribed) {
    const subRes = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ events: ['*'], url: 'http://127.0.0.1:1/hook' }),
    });
    expect(subRes.status).toBe(201);
  }
  const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
  await registerAgent(stack.app, ws.workspaceKey, 'bob');
  stack.queue.sent.length = 0;
  stack.queue.rowsVisibleAtSend.length = 0;
  const response = await stack.app.request('/v1/dm', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${alice.token}`,
      'Idempotency-Key': key,
    },
    body: JSON.stringify({ to: 'bob', text: 'persist exactly once' }),
  });
  return { ws, alice, response };
}

describe('engine send path (persist-first outbox)', () => {
  it('skips the keyed DM outbox row and queue send without subscribers', async () => {
    const stack = track(makeStack());
    const { ws, response } = await postKeyedDm(stack, false, 'no-subscriber-dm');
    expect(response.status).toBe(201);
    await stack.settle();

    expect(stack.queue.ofType('dm.received')).toHaveLength(0);
    const rows = await stack.db.select().from(pendingEvents).where(and(
      eq(pendingEvents.workspaceId, ws.workspaceId),
      eq(pendingEvents.eventType, 'dm.received'),
    ));
    expect(rows).toHaveLength(0);
  });

  it('persists and queues a keyed DM outbox row when a subscriber exists', async () => {
    const stack = track(makeStack());
    const { ws, response } = await postKeyedDm(stack, true, 'subscribed-dm');
    expect(response.status).toBe(201);
    await stack.settle();

    const [event] = stack.queue.ofType('dm.received');
    expect(event?.outboxId).toBeDefined();
    const rows = await stack.db.select().from(pendingEvents).where(and(
      eq(pendingEvents.workspaceId, ws.workspaceId),
      eq(pendingEvents.eventType, 'dm.received'),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(event!.outboxId);
    const idx = stack.queue.sent.indexOf(event!);
    expect(stack.queue.rowsVisibleAtSend[idx]).toBe(true);
  });

  it('marks a direct claim-table replay when the KV cache is unavailable', async () => {
    const stack = track(makeStack());
    stack.runtime.deps.kv.get = async () => { throw new Error('KV unavailable'); };
    const first = await postKeyedDm(stack, false, 'claim-replay-header');
    expect(first.response.status).toBe(201);
    expect(first.response.headers.get('Idempotency-Replayed')).toBeNull();

    const replay = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${first.alice.token}`,
        'Idempotency-Key': 'claim-replay-header',
      },
      body: JSON.stringify({ to: 'bob', text: 'persist exactly once' }),
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    await expect(replay.json()).resolves.not.toHaveProperty('data._idempotency_replayed');

    const rows = await stack.db.select().from(messages).where(eq(messages.workspaceId, first.ws.workspaceId));
    expect(rows).toHaveLength(1);
  });

  it('refills a lost KV receipt only for the SQL claim remaining lifetime', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const acceptedAt = new Date('2026-10-02T00:00:00.000Z');
    vi.setSystemTime(acceptedAt);
    const stack = track(makeStack());
    const idempotencyKey = 'claim-remaining-ttl';
    const first = await postKeyedDm(stack, false, idempotencyKey);
    expect(first.response.status).toBe(201);
    const firstBody = await first.response.json() as { data: { id: string } };
    const storageKey = await buildIdempotencyStorageKey(
      first.ws.workspaceId, first.alice.agentId, 'dm:direct', idempotencyKey,
    );
    await stack.runtime.deps.kv.delete(storageKey);

    const recordTtls: number[] = [];
    const originalPut = stack.runtime.deps.kv.put.bind(stack.runtime.deps.kv);
    stack.runtime.deps.kv.put = async (key, value, options) => {
      if (key === storageKey && options?.expirationTtl !== undefined) {
        recordTtls.push(options.expirationTtl);
      }
      await originalPut(key, value, options);
    };

    vi.setSystemTime(acceptedAt.getTime() + 23 * 60 * 60 * 1000);
    const replay = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${first.alice.token}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ to: 'bob', text: 'persist exactly once' }),
    });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(recordTtls).toEqual([60 * 60]);
    const replayRecord = JSON.parse((await stack.runtime.deps.kv.get(storageKey))!) as { data: Record<string, unknown> };
    expect(replayRecord.data).not.toHaveProperty('_idempotency_replayed');
    expect(replayRecord.data).not.toHaveProperty('_idempotency_ttl_seconds');

    vi.setSystemTime(acceptedAt.getTime() + 24 * 60 * 60 * 1000 + 1_000);
    const fresh = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${first.alice.token}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({ to: 'bob', text: 'persist exactly once' }),
    });
    expect(fresh.status).toBe(201);
    expect(fresh.headers.get('Idempotency-Replayed')).toBeNull();
    const freshBody = await fresh.json() as { data: { id: string } };
    expect(freshBody.data.id).not.toBe(firstBody.data.id);
    const rows = await stack.db.select().from(messages).where(eq(messages.workspaceId, first.ws.workspaceId));
    expect(rows).toHaveLength(2);
  });

  it('inserts the outbox row before invoking eventQueue.send and passes its id', async () => {
    const stack = track(makeStack());
    const res = await postMessage(stack);
    expect(res.status).toBe(201);

    await stack.settle();

    const [event] = stack.queue.ofType('message.created');
    expect(event).toBeDefined();
    expect(event.outboxId).toBeDefined();
    // The row was already durable when the adapter received the event.
    const idx = stack.queue.sent.indexOf(event);
    expect(stack.queue.rowsVisibleAtSend[idx]).toBe(true);

    const rows = await stack.db.select().from(pendingEvents).where(eq(pendingEvents.id, event.outboxId!));
    expect(rows).toHaveLength(1);
    expect(rows[0].eventType).toBe('message.created');
    expect(rows[0].status).toBe('pending');
  });

  it('inserts the outbox row before storing an idempotent success record', async () => {
    let stack!: OutboxStack;
    const rowsVisibleAtIdempotencyPut: boolean[] = [];
    stack = track(makeStack({
      onKvPut: async (key) => {
        if (!key.startsWith('idem:v1:') || key.endsWith(':lock')) return;
        const rows = await stack.db.select().from(pendingEvents);
        rowsVisibleAtIdempotencyPut.push(rows.some((row) =>
          row.eventType === 'message.created' && row.status === 'pending',
        ));
      },
    }));

    const res = await postMessage(stack, { 'Idempotency-Key': 'idem-outbox-order' });
    expect(res.status).toBe(201);

    expect(rowsVisibleAtIdempotencyPut).toEqual([true]);
  });

  it('keeps the row sweepable when the queue send throws synchronously', async () => {
    const stack = track(makeStack());
    stack.queue.failure = new Error('queue exploded');

    const res = await postMessage(stack);
    expect(res.status).toBe(201); // a dead queue never fails the mutation

    await stack.settle();

    const [event] = stack.queue.ofType('message.created');
    expect(event.outboxId).toBeDefined();
    const swept = await sweepPendingEvents(stack.db, { limit: 100 });
    const row = swept.find((e) => e.id === event.outboxId);
    expect(row).toBeDefined();
    expect(row!.eventType).toBe('message.created');
  });

  it('keeps the row sweepable when the queue send rejects asynchronously', async () => {
    const stack = track(makeStack());
    stack.queue.failure = new Error('queue outage');
    stack.queue.rejects = true;

    const res = await postMessage(stack);
    expect(res.status).toBe(201);

    await stack.settle();

    const [event] = stack.queue.ofType('message.created');
    const swept = await sweepPendingEvents(stack.db, { limit: 100 });
    expect(swept.some((e) => e.id === event.outboxId)).toBe(true);
  });
});
