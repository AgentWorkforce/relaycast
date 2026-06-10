import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createEngine } from '../../engine.js';
import { createNodeRuntime, type NodeRuntime } from '../../adapters/node/index.js';
import type { EventQueue, QueuedEvent } from '../../ports/event-queue.js';
import type { EngineDb } from '../../ports/database.js';
import { pendingEvents } from '../../db/schema.js';
import { sweepPendingEvents } from '../../engine/eventQueue.js';
import { createWorkspace, registerAgent } from '../../__tests__/conformance/harness.js';
import type { KeyValueStore } from '../../ports/kv.js';

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

interface OutboxStack {
  app: ReturnType<typeof createEngine>;
  runtime: NodeRuntime;
  queue: CapturingQueue;
  db: EngineDb;
}

/** Engine on the Node adapter with the webhook queue swapped for a capturing fake. */
function makeStack(opts: { onKvPut?: (key: string, value: string) => Promise<void> | void } = {}): OutboxStack {
  const runtime = createNodeRuntime({
    dbPath: ':memory:',
    baseUrl: 'http://localhost:0',
    migrate: true,
    config: { environment: 'test' },
    presence: { sweepIntervalMs: 0 },
    eventQueue: { pollIntervalMs: 0 },
  });
  // The real DurableEventQueue would claim + deliver the rows; stop it and
  // inject a fake so the rows stay visible to assertions.
  runtime.webhookQueue.stop();
  const queue = new CapturingQueue(runtime.deps.db);
  runtime.deps.webhookQueue = queue;
  if (opts.onKvPut) {
    runtime.deps.kv = new ObservingKv(runtime.deps.kv, opts.onKvPut);
  }
  const app = createEngine(runtime.deps);
  return { app, runtime, queue, db: runtime.deps.db };
}

const stacks: OutboxStack[] = [];
function track(stack: OutboxStack): OutboxStack {
  stacks.push(stack);
  return stack;
}

afterEach(() => {
  for (const stack of stacks.splice(0)) stack.runtime.close();
});

async function postMessage(stack: OutboxStack, headers: Record<string, string> = {}): Promise<Response> {
  const ws = await createWorkspace(stack.app, 'outbox-ws');
  const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
  return stack.app.request('/v1/channels/general/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}`, ...headers },
    body: JSON.stringify({ text: 'persist me' }),
  });
}

describe('engine send path (persist-first outbox)', () => {
  it('inserts the outbox row before invoking eventQueue.send and passes its id', async () => {
    const stack = track(makeStack());
    const res = await postMessage(stack);
    expect(res.status).toBe(201);

    await new Promise((r) => setTimeout(r, 25)); // let background sends settle

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

    await new Promise((r) => setTimeout(r, 25));

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

    await new Promise((r) => setTimeout(r, 25));

    const [event] = stack.queue.ofType('message.created');
    const swept = await sweepPendingEvents(stack.db, { limit: 100 });
    expect(swept.some((e) => e.id === event.outboxId)).toBe(true);
  });
});
