import { createEngine } from '../../engine.js';
import { BackgroundTasks } from '../../__tests__/backgroundTasks.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { EventQueue, QueuedEvent } from '../../ports/event-queue.js';
import type { EngineDb } from '../../ports/database.js';
import { directDmIdempotency, messages, pendingEvents } from '../../db/tables.js';
import { sweepPendingEvents } from '../../engine/eventQueue.js';
import { createWorkspace, registerAgent, makeNodeStack, type TestStack } from '../../__tests__/conformance/harness.js';
import type { KeyValueStore } from '../../ports/kv.js';
import { buildIdempotencyStorageKey } from '../../middleware/idempotency.js';
import { FakeSocket } from '../../__tests__/conformance/harness.js';

// Counts (and can fail) the per-request subscription read of the send-path pre-filter.
const matcherProbe = vi.hoisted(() => ({ calls: 0, fail: false }));
vi.mock('../../engine/eventSubscription.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../engine/eventSubscription.js')>();
  return {
    ...actual,
    listActiveSubscriptionMatchers: async (...args: Parameters<typeof actual.listActiveSubscriptionMatchers>) => {
      matcherProbe.calls += 1;
      if (matcherProbe.fail) throw new Error('subscription read failed');
      return actual.listActiveSubscriptionMatchers(...args);
    },
  };
});

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
  matcherProbe.calls = 0;
  matcherProbe.fail = false;
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
    const [claim] = await stack.db.select().from(directDmIdempotency);
    expect(claim).toBeDefined();
    const claimCreatedAt = claim!.createdAt.getTime();
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

    vi.setSystemTime(claimCreatedAt + 23 * 60 * 60 * 1000);
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

    vi.setSystemTime(claimCreatedAt + 24 * 60 * 60 * 1000 + 1_000);
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

type Recipient = { agent_id: string; agent_name: string; delivery_id?: string; seq?: number };
type Agent = Awaited<ReturnType<typeof registerAgent>>;

function jsonHeaders(token: string, extra: Record<string, string> = {}): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra };
}

async function call<T = Record<string, unknown>>(
  stack: OutboxStack, path: string, token: string, body?: unknown, extra: Record<string, string> = {},
): Promise<{ status: number; data: T }> {
  const res = await stack.app.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: jsonHeaders(token, extra),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({})) as { data: T };
  return { status: res.status, data: json.data };
}

async function subscribe(stack: OutboxStack, workspaceKey: string, body: Record<string, unknown>): Promise<string> {
  const res = await call<{ id: string }>(stack, '/v1/subscriptions', workspaceKey, { url: 'http://127.0.0.1:1/hook', ...body });
  expect(res.status).toBe(201);
  return res.data.id;
}

async function outboxRows(stack: OutboxStack, workspaceId: string, eventType?: string) {
  const rows = await stack.db.select().from(pendingEvents).where(eq(pendingEvents.workspaceId, workspaceId));
  return eventType ? rows.filter((row) => row.eventType === eventType) : rows;
}

/** The recipient's own `GET /v1/deliveries` record of a message. */
async function deliveryOf(stack: OutboxStack, agent: Agent, messageId: string) {
  const res = await call<Array<{ id: string; message_id: string; agent_id: string; seq: number }>>(
    stack, '/v1/deliveries', agent.token,
  );
  const item = res.data.find((d) => d.message_id === messageId);
  expect(item).toBeDefined();
  return item!;
}

async function expectRecipientsMatchDeliveries(
  stack: OutboxStack, recipients: Recipient[], agents: Agent[], messageId: string, opts: { seq: boolean } = { seq: true },
) {
  expect(recipients.map((r) => r.agent_name).sort()).toEqual(agents.map((a) => a.name).sort());
  for (const agent of agents) {
    const delivery = await deliveryOf(stack, agent, messageId);
    const entry = recipients.find((r) => r.agent_id === agent.agentId);
    const expected: Recipient = { agent_id: agent.agentId, agent_name: agent.name, delivery_id: delivery.id };
    if (opts.seq) expected.seq = delivery.seq;
    expect(entry).toEqual(expected);
  }
}

async function threeAgents(stack: OutboxStack, name: string) {
  const ws = await createWorkspace(stack.app, name);
  const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
  const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
  const carol = await registerAgent(stack.app, ws.workspaceKey, 'carol');
  return { ws, alice, bob, carol };
}

/** `team`: alice (creator) and bob; carol stays out. */
async function teamChannel(stack: OutboxStack, workspaceKey: string, bob: Agent) {
  expect((await call(stack, '/v1/channels', workspaceKey, { name: 'team' })).status).toBeLessThan(300);
  expect((await call(stack, '/v1/channels/team/join', bob.token, {})).status).toBeLessThan(300);
}

describe('webhook data.recipients', () => {
  it('lists delivery id and seq per recipient for the four message events, sender excluded, WS unchanged', async () => {
    const stack = track(makeStack());
    const { ws, alice, bob, carol } = await threeAgents(stack, 'recipients-four');
    await subscribe(stack, ws.workspaceKey, { events: ['*'] });
    expect((await call(stack, '/v1/channels', ws.workspaceKey, { name: 'team' })).status).toBeLessThan(300);
    for (const agent of [alice, bob]) {
      expect((await call(stack, '/v1/channels/team/join', agent.token, {})).status).toBeLessThan(300);
    }
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const post = await call<{ id: string }>(stack, '/v1/channels/team/messages', alice.token, { text: 'hello team' });
    expect(post.status).toBe(201);
    const reply = await call<{ id: string }>(stack, `/v1/messages/${post.data.id}/replies`, bob.token, { text: 'reply' });
    expect(reply.status).toBe(201);
    const group = await call<{ id: string }>(stack, '/v1/dm/group', alice.token, { participants: ['bob', 'carol'] });
    expect(group.status).toBe(201);
    const groupPost = await call<{ id: string }>(stack, `/v1/dm/${group.data.id}/messages`, alice.token, { text: 'group hi' });
    expect(groupPost.status).toBe(201);
    const dm = await call<{ id: string }>(stack, '/v1/dm', alice.token, { to: 'bob', text: 'direct' });
    expect(dm.status).toBe(201);
    await stack.settle();

    const queued = (type: string) => {
      const [event] = stack.queue.ofType(type);
      expect(event).toBeDefined();
      return event!.data.recipients as Recipient[];
    };
    await expectRecipientsMatchDeliveries(stack, queued('message.created'), [bob], post.data.id);
    await expectRecipientsMatchDeliveries(stack, queued('thread.reply'), [alice], reply.data.id);
    await expectRecipientsMatchDeliveries(stack, queued('group_dm.received'), [bob, carol], groupPost.data.id);
    await expectRecipientsMatchDeliveries(stack, queued('dm.received'), [bob], dm.data.id);

    // The outbox row (what the Node consumer delivers) carries the same list.
    const [row] = await outboxRows(stack, ws.workspaceId, 'message.created');
    expect((row!.payload as Record<string, unknown>).recipients).toEqual(queued('message.created'));
    expect((row!.payload as Record<string, unknown>).recipients_truncated).toBeUndefined();

    // WS payloads stay as they were.
    const wsCreated = stream.ofType('message.created');
    expect(wsCreated.length).toBeGreaterThan(0);
    for (const type of ['message.created', 'thread.reply', 'group_dm.received', 'dm.received']) {
      for (const frame of stream.ofType(type)) {
        expect(JSON.stringify(frame)).not.toContain('"recipients"');
      }
    }
  });

  it('stores the committed delivery row, seq included, on the durable keyed DM row and hands afterAdmission the same', async () => {
    const stack = track(makeStack());
    const { ws, alice, bob } = await threeAgents(stack, 'recipients-durable');
    await subscribe(stack, ws.workspaceKey, { events: ['dm.received'], filter: { recipients: ['bob'] } });
    const dm = await call<{ id: string }>(stack, '/v1/dm', alice.token, { to: 'bob', text: 'keyed' }, { 'Idempotency-Key': 'durable-recipients' });
    expect(dm.status).toBe(201);
    await stack.settle();

    const [row] = await outboxRows(stack, ws.workspaceId, 'dm.received');
    expect(row).toBeDefined();
    const recipients = (row!.payload as Record<string, unknown>).recipients as Recipient[];
    await expectRecipientsMatchDeliveries(stack, recipients, [bob], dm.data.id);
    expect(Object.keys(recipients[0]!)).toEqual(['agent_id', 'agent_name', 'delivery_id', 'seq']);
    // The queued event carries exactly what afterAdmission received.
    const [event] = stack.queue.ofType('dm.received');
    expect(event!.outboxId).toBe(row!.id);
    expect(event!.data).toEqual(row!.payload);
  });

  it('stores recipients [] on a depth-cap-rejected durable keyed DM and hands afterAdmission the same', async () => {
    const stack = track(makeStack());
    stack.runtime.deps.config!.mailbox = { deliveryTtlMs: 60_000, depthCap: 1 };
    const { ws, alice, bob } = await threeAgents(stack, 'recipients-depth-cap');
    await subscribe(stack, ws.workspaceKey, { events: ['dm.received'], filter: { recipients: ['bob'] } });
    const first = await call<{ id: string }>(stack, '/v1/dm', alice.token, { to: 'bob', text: 'fills' }, { 'Idempotency-Key': 'depth-cap-1' });
    expect(first.status).toBe(201);
    const second = await call<{ id: string }>(stack, '/v1/dm', alice.token, { to: 'bob', text: 'rejected' }, { 'Idempotency-Key': 'depth-cap-2' });
    expect(second.status).toBe(201);
    await stack.settle();

    const rows = await outboxRows(stack, ws.workspaceId, 'dm.received');
    const firstRow = rows.find((r) => r.id === first.data.id);
    const rejectedRow = rows.find((r) => r.id === second.data.id);
    expect(firstRow).toBeDefined();
    expect(rejectedRow).toBeDefined();
    await expectRecipientsMatchDeliveries(stack, (firstRow!.payload as Record<string, unknown>).recipients as Recipient[], [bob], first.data.id);
    expect((rejectedRow!.payload as Record<string, unknown>).recipients).toEqual([]);

    const events = stack.queue.ofType('dm.received');
    const rejectedEvent = events.find((e) => e.outboxId === second.data.id);
    expect(rejectedEvent).toBeDefined();
    expect(rejectedEvent!.data).toEqual(rejectedRow!.payload);
    expect(events.find((e) => e.outboxId === first.data.id)!.data).toEqual(firstRow!.payload);
  });
});

describe('send-path subscription pre-filter', () => {
  it('writes no outbox row for events a dm.received-only subscription never delivers', async () => {
    const stack = track(makeStack());
    const { ws, alice, bob } = await threeAgents(stack, 'prefilter-types');
    await subscribe(stack, ws.workspaceKey, { events: ['dm.received'] });
    await teamChannel(stack, ws.workspaceKey, bob);
    await stack.settle();
    stack.queue.sent.length = 0;
    const before = (await outboxRows(stack, ws.workspaceId)).length;
    expect(before).toBe(0);

    const post = await call<{ id: string }>(stack, '/v1/channels/team/messages', alice.token, { text: 'not wanted' });
    expect(post.status).toBe(201);
    expect((await call(stack, `/v1/messages/${post.data.id}/reactions`, bob.token, { emoji: 'thumbsup' })).status).toBeLessThan(300);
    const upload = await call<{ id: string; upload_url: string }>(stack, '/v1/files/upload', alice.token, {
      filename: 'a.txt', content_type: 'text/plain', size_bytes: 12,
    });
    expect(upload.status).toBe(201);
    const put = await stack.runtime.fileHandler(new Request(upload.data.upload_url, {
      method: 'PUT', headers: { 'content-type': 'text/plain' }, body: 'hello world\n',
    }));
    expect(put.status).toBe(200);
    expect((await call(stack, `/v1/files/${upload.data.id}/complete`, alice.token, {})).status).toBe(200);
    await stack.settle();
    expect(await outboxRows(stack, ws.workspaceId)).toHaveLength(0);
    expect(stack.queue.sent).toHaveLength(0);

    expect((await call(stack, '/v1/dm', alice.token, { to: 'bob', text: 'wanted' })).status).toBe(201);
    await stack.settle();
    const rows = await outboxRows(stack, ws.workspaceId);
    expect(rows.map((row) => row.eventType)).toEqual(['dm.received']);
  });

  it('skips a DM to someone else under a recipients filter, on both DM paths', async () => {
    const stack = track(makeStack());
    const { ws, alice } = await threeAgents(stack, 'prefilter-recipients');
    await subscribe(stack, ws.workspaceKey, { events: ['dm.received'], filter: { recipients: ['carol'] } });

    expect((await call(stack, '/v1/dm', alice.token, { to: 'bob', text: 'plain' })).status).toBe(201);
    expect((await call(stack, '/v1/dm', alice.token, { to: 'bob', text: 'keyed' }, { 'Idempotency-Key': 'skip-keyed' })).status).toBe(201);
    await stack.settle();
    expect(await outboxRows(stack, ws.workspaceId)).toHaveLength(0);
    expect(stack.queue.ofType('dm.received')).toHaveLength(0);

    expect((await call(stack, '/v1/dm', alice.token, { to: 'carol', text: 'plain' })).status).toBe(201);
    expect((await call(stack, '/v1/dm', alice.token, { to: 'carol', text: 'keyed' }, { 'Idempotency-Key': 'want-keyed' })).status).toBe(201);
    await stack.settle();
    expect(await outboxRows(stack, ws.workspaceId, 'dm.received')).toHaveLength(2);
  });

  it('fails open and enqueues when the subscription read errors', async () => {
    const stack = track(makeStack());
    const { ws, alice, bob } = await threeAgents(stack, 'prefilter-fail-open');
    await subscribe(stack, ws.workspaceKey, { events: ['dm.received'] });
    await teamChannel(stack, ws.workspaceKey, bob);
    matcherProbe.fail = true;

    expect((await call(stack, '/v1/channels/team/messages', alice.token, { text: 'fail open' })).status).toBe(201);
    expect((await call(stack, '/v1/dm', alice.token, { to: 'bob', text: 'keyed' }, { 'Idempotency-Key': 'fail-open' })).status).toBe(201);
    await stack.settle();
    const types = (await outboxRows(stack, ws.workspaceId)).map((row) => row.eventType);
    expect(types).toContain('message.created');
    expect(types).toContain('dm.received');
  });

  it('reads subscriptions at most once per request that emits several events', async () => {
    const stack = track(makeStack());
    const ws = await createWorkspace(stack.app, 'prefilter-once');
    const owner = await registerAgent(stack.app, ws.workspaceKey, 'owner');
    await subscribe(stack, ws.workspaceKey, { events: ['*'] });
    expect((await call(stack, '/v1/channels', owner.token, { name: 'hook-chan' })).status).toBeLessThan(300);
    const hook = await call<{ webhook_id: string; token: string }>(stack, '/v1/webhooks', ws.workspaceKey, { channel: 'hook-chan' });
    await stack.settle();
    stack.queue.sent.length = 0;
    matcherProbe.calls = 0;

    const post = await call(stack, `/v1/hooks/${hook.data.webhook_id}`, hook.data.token, {
      text: 'two events', source: 'webhook', author: 'webhook', payload: { ref: 'r1' },
    });
    expect(post.status).toBe(201);
    await stack.settle();
    expect(stack.queue.sent.map((e) => e.type).sort()).toEqual(['message.created', 'webhook.received']);
    expect(matcherProbe.calls).toBe(1);
  });

  it('stops enqueueing for a subscription PATCHed inactive', async () => {
    const stack = track(makeStack());
    const { ws, alice } = await threeAgents(stack, 'prefilter-inactive');
    const id = await subscribe(stack, ws.workspaceKey, { events: ['dm.received'] });
    const patched = await stack.app.request(`/v1/subscriptions/${id}`, {
      method: 'PATCH', headers: jsonHeaders(ws.workspaceKey), body: JSON.stringify({ is_active: false }),
    });
    expect(patched.status).toBe(200);

    expect((await call(stack, '/v1/dm', alice.token, { to: 'bob', text: 'plain' })).status).toBe(201);
    expect((await call(stack, '/v1/dm', alice.token, { to: 'bob', text: 'keyed' }, { 'Idempotency-Key': 'inactive' })).status).toBe(201);
    await stack.settle();
    expect(await outboxRows(stack, ws.workspaceId)).toHaveLength(0);
  });
});
