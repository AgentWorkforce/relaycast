import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { pendingEvents } from '../../db/tables.js';
import {
  deliverEvent,
  matchesFilter,
  MAX_STORED_WEBHOOK_RECIPIENTS,
  MAX_WEBHOOK_RECIPIENTS,
  withStoredRecipients,
  type WebhookRecipient,
} from '../../engine/eventDelivery.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

const recipient = (i: number): WebhookRecipient => ({
  agent_id: `agt_${i}`, agent_name: `agent-${i}`, delivery_id: `dlv_${i}`, seq: i + 1,
});
const recipients = (n: number) => Array.from({ length: n }, (_, i) => recipient(i));

describe('filter.recipients matching', () => {
  const payload = { channel_name: 'team', text: 'hi', recipients: [recipient(1), recipient(2)] };

  it('matches by agent name or agent id, and not otherwise', () => {
    expect(matchesFilter({ recipients: ['agent-2'] }, payload)).toBe(true);
    expect(matchesFilter({ recipients: ['agt_1'] }, payload)).toBe(true);
    expect(matchesFilter({ recipients: ['nobody', 'agt_2'] }, payload)).toBe(true);
    expect(matchesFilter({ recipients: ['agent-3', 'agt_3'] }, payload)).toBe(false);
  });

  it('never matches an event without a recipient list', () => {
    expect(matchesFilter({ recipients: ['agent-1'] }, { channel_name: 'team', text: 'hi' })).toBe(false);
    expect(matchesFilter({ recipients: ['agent-1'] }, { ...payload, recipients: [] })).toBe(false);
  });

  it('combines with channel and mentions using AND', () => {
    expect(matchesFilter({ channel: 'team', recipients: ['agent-1'] }, payload)).toBe(true);
    expect(matchesFilter({ channel: 'other', recipients: ['agent-1'] }, payload)).toBe(false);
    expect(matchesFilter({ mentions: 'carol', recipients: ['agent-1'] }, payload)).toBe(false);
  });

  it('stores the first 500 plus later filter matches, bounded, and marks truncation', () => {
    const all = recipients(MAX_WEBHOOK_RECIPIENTS + 100);
    expect(withStoredRecipients({}, recipients(3), [], 'message.created')).toEqual({ recipients: recipients(3) });

    const stored = withStoredRecipients({ text: 'x' }, all, [{ events: ['*'], filter: { recipients: ['agent-550'] } }], 'message.created');
    expect(stored.recipients_truncated).toBe(true);
    expect((stored.recipients as WebhookRecipient[]).map((r) => r.agent_name))
      .toEqual([...all.slice(0, MAX_WEBHOOK_RECIPIENTS).map((r) => r.agent_name), 'agent-550']);

    const unknown = withStoredRecipients({}, recipients(MAX_STORED_WEBHOOK_RECIPIENTS + 10), null, 'message.created');
    expect(unknown.recipients).toHaveLength(MAX_STORED_WEBHOOK_RECIPIENTS);
    expect(unknown.recipients_truncated).toBe(true);
  });

  it('keeps the stored slots past 500 for subscriptions that want this event', () => {
    // 2,001 recipients of a channel post. Three dm.received-only filters and a
    // wrong-channel filter name positions 501-2,000; the one channel webhook
    // names the 2,001st, which must still be stored.
    const all = recipients(MAX_STORED_WEBHOOK_RECIPIENTS + 1);
    const names = (from: number, to: number) => all.slice(from, to).map((r) => r.agent_name);
    const matchers = [
      { events: ['dm.received'], filter: { recipients: names(500, 1000) } },
      { events: ['dm.received'], filter: { recipients: names(1000, 1500) } },
      { events: ['dm.received'], filter: { recipients: names(1500, 2000) } },
      { events: ['message.created'], filter: { channel: 'other', recipients: names(500, 1000) } },
      { events: ['message.created'], filter: { channel: 'team', recipients: ['agent-2000'] } },
    ];
    const stored = withStoredRecipients({ channel_name: 'team', text: 'hi' }, all, matchers, 'message.created');
    expect((stored.recipients as WebhookRecipient[]).map((r) => r.agent_name))
      .toEqual([...names(0, MAX_WEBHOOK_RECIPIENTS), 'agent-2000']);
    expect(stored.recipients_truncated).toBe(true);
    // Unknown matchers (failed or over-bound read) still keep everything up to the bound.
    expect(withStoredRecipients({ channel_name: 'team' }, all, null, 'message.created').recipients)
      .toHaveLength(MAX_STORED_WEBHOOK_RECIPIENTS);
  });
});

describe('per-subscription data.recipients at delivery', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function deliverTo(
    filters: Record<string, Record<string, unknown> | null>,
    payload: Record<string, unknown>,
    eventsFor: Record<string, string[]> = {},
  ) {
    const ws = await createWorkspace(stack.app, 'recipients-delivery');
    for (const [path, filter] of Object.entries(filters)) {
      const events = eventsFor[path] ?? ['message.created'];
      const res = await stack.app.request('/v1/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ events, url: `https://hooks.example.test/${path}`, filter }),
      });
      expect(res.status).toBe(201);
    }
    const bodies = new Map<string, { data: Record<string, unknown> }>();
    await deliverEvent(stack.runtime.deps.db, ws.workspaceId, 'message.created', payload, {
      fetch: async (input, init) => {
        bodies.set(new URL(String(input)).pathname.slice(1), JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      },
    });
    return bodies;
  }

  it('narrows the list to each filter and leaves unfiltered subscriptions the whole list', async () => {
    const bodies = await deliverTo({
      all: null,
      byName: { recipients: ['agent-1'] },
      byId: { recipients: ['agt_2', 'agent-1'] },
      channelAndRecipient: { channel: 'team', recipients: ['agent-0'] },
      wrongChannel: { channel: 'other', recipients: ['agent-0'] },
      noMatch: { recipients: ['agent-9'] },
    }, { id: 'm1', channel_name: 'team', text: 'hi', recipients: recipients(3) });

    expect([...bodies.keys()].sort()).toEqual(['all', 'byId', 'byName', 'channelAndRecipient']);
    expect(bodies.get('all')!.data.recipients).toEqual(recipients(3));
    expect(bodies.get('byName')!.data.recipients).toEqual([recipient(1)]);
    expect(bodies.get('byId')!.data.recipients).toEqual([recipient(1), recipient(2)]);
    expect(bodies.get('channelAndRecipient')!.data.recipients).toEqual([recipient(0)]);
    for (const body of bodies.values()) expect(body.data.recipients_truncated).toBeUndefined();
  });

  it('caps each body at 500 and flags truncation only where entries were dropped', async () => {
    const all = recipients(MAX_WEBHOOK_RECIPIENTS + 100);
    const matchers = [{ events: ['*'], filter: { recipients: ['agent-550'] } }];
    const stored = withStoredRecipients({ id: 'm1', channel_name: 'team', text: 'hi' }, all, matchers, 'message.created');
    const bodies = await deliverTo({ all: null, late: { recipients: ['agent-550'] } }, stored);

    const unfiltered = bodies.get('all')!.data;
    expect(unfiltered.recipients).toEqual(all.slice(0, MAX_WEBHOOK_RECIPIENTS));
    expect(unfiltered.recipients_truncated).toBe(true);
    // Matched against the full list: the 551st recipient is still found and delivered.
    const late = bodies.get('late')!.data;
    expect(late.recipients).toEqual([recipient(550)]);
    expect(late.recipients_truncated).toBeUndefined();
  });

  it('delivers to the only matching webhook on a large fan-out despite unrelated recipient filters', async () => {
    const all = recipients(MAX_STORED_WEBHOOK_RECIPIENTS + 1);
    const dmOnly = [500, 1000, 1500].map((from) => ({
      events: ['dm.received'], filter: { recipients: all.slice(from, from + 500).map((r) => r.agent_name) },
    }));
    const channel = { channel: 'team', recipients: ['agent-2000'] };
    const stored = withStoredRecipients(
      { id: 'm1', channel_name: 'team', text: 'hi' }, all, [...dmOnly, { events: ['message.created'], filter: channel }], 'message.created',
    );
    const bodies = await deliverTo({ channel }, stored);
    expect(bodies.get('channel')?.data.recipients).toEqual([recipient(2000)]);
  });

  describe('past the storage cap', () => {
    // 2,600 recipients; five filters of 500 names cover entries 100..2,599 in order.
    const all = recipients(2_600);
    const names = (from: number, to: number) => all.slice(from, to).map((r) => r.agent_name);
    const ranges = [[100, 600], [600, 1100], [1100, 1600], [1600, 2100], [2100, 2600]] as const;
    const filters = Object.fromEntries(ranges.map(([from, to], i) => [`sub${i + 1}`, { channel: 'team', recipients: names(from, to) }]));
    const stored = () => withStoredRecipients(
      { id: 'm1', channel_name: 'team', text: 'hi' }, all,
      Object.values(filters).map((filter) => ({ events: ['message.created'], filter })), 'message.created',
    );

    it('delivers to every wanting filtered subscription, with an empty truncated list where all names were cut', async () => {
      const payload = stored();
      expect(payload.recipients).toHaveLength(MAX_STORED_WEBHOOK_RECIPIENTS);
      const bodies = await deliverTo(filters, payload);

      expect([...bodies.keys()].sort()).toEqual(['sub1', 'sub2', 'sub3', 'sub4', 'sub5']);
      expect(bodies.get('sub1')!.data.recipients).toEqual(all.slice(100, 600));
      expect(bodies.get('sub2')!.data.recipients).toEqual(all.slice(600, 1100));
      expect(bodies.get('sub3')!.data.recipients).toEqual(all.slice(1100, 1600));
      // Partly stored: the matches that fit, flagged.
      expect(bodies.get('sub4')!.data.recipients).toEqual(all.slice(1600, MAX_STORED_WEBHOOK_RECIPIENTS));
      expect(bodies.get('sub4')!.data.recipients_truncated).toBe(true);
      // All names cut: still delivered, visibly.
      expect(bodies.get('sub5')!.data.recipients).toEqual([]);
      expect(bodies.get('sub5')!.data.recipients_truncated).toBe(true);
    });

    it('still delivers nothing to a filtered subscription on another channel or event type', async () => {
      const cut = names(2100, 2600);
      const bodies = await deliverTo({
        otherChannel: { channel: 'other', recipients: cut },
        otherEvent: { recipients: cut },
      }, stored(), { otherEvent: ['dm.received'] });
      expect(bodies.size).toBe(0);
    });

    it('delivers nothing under the storage cap when the filter names nobody on the list', async () => {
      const payload = withStoredRecipients(
        { id: 'm1', channel_name: 'team', text: 'hi' }, recipients(600),
        [{ events: ['message.created'], filter: { recipients: ['nobody'] } }], 'message.created',
      );
      expect(payload.recipients_truncated).toBe(true);
      const bodies = await deliverTo({ nobody: { recipients: ['nobody'] } }, payload);
      expect(bodies.size).toBe(0);
    });
  });
});

describe('webhook body size cap with data.recipients', () => {
  const MAX_BODY = 256 * 1024;
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  // Multi-byte names: the cap counts UTF-8 bytes, not string length.
  const wide = (i: number): WebhookRecipient => ({
    agent_id: `agt_${i}`, agent_name: `agénte-名前-${i}`, delivery_id: `dlv_${i}`, seq: i + 1,
  });
  const bytes = (text: string) => new TextEncoder().encode(text).byteLength;

  async function deliver(payloadFor: (workspaceId: string) => Record<string, unknown>) {
    const ws = await createWorkspace(stack.app, 'recipients-size');
    const res = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ events: ['message.created'], url: 'https://hooks.example.test/all' }),
    });
    expect(res.status).toBe(201);
    const sent: string[] = [];
    const summary = await deliverEvent(stack.runtime.deps.db, ws.workspaceId, 'message.created', payloadFor(ws.workspaceId), {
      fetch: async (_input, init) => {
        sent.push(String(init?.body));
        return new Response(null, { status: 202 });
      },
    });
    return { sent, summary };
  }

  /** A payload whose full webhook body (500 wide recipients) is `MAX_BODY + over` bytes. */
  function sized(workspaceId: string, over: number): Record<string, unknown> {
    const list = Array.from({ length: MAX_WEBHOOK_RECIPIENTS }, (_, i) => wide(i));
    const bodyOf = (text: string) => JSON.stringify({
      type: 'message.created', workspace_id: workspaceId, timestamp: new Date().toISOString(),
      data: { id: 'm1', channel_name: 'team', text, recipients: list },
    });
    const text = 'a'.repeat(MAX_BODY + over - bytes(bodyOf('')));
    expect(bytes(bodyOf(text))).toBe(MAX_BODY + over);
    return { id: 'm1', channel_name: 'team', text, recipients: list };
  }

  it('sends a body of exactly the cap whole', async () => {
    const { sent } = await deliver((id) => sized(id, 0));
    expect(sent).toHaveLength(1);
    expect(bytes(sent[0]!)).toBe(MAX_BODY);
    const data = JSON.parse(sent[0]!).data;
    expect(data.recipients).toHaveLength(MAX_WEBHOOK_RECIPIENTS);
    expect(data.recipients_truncated).toBeUndefined();
  });

  it('drops trailing recipients to fit a body one byte over the cap, and flags it', async () => {
    const { sent } = await deliver((id) => sized(id, 1));
    expect(sent).toHaveLength(1);
    expect(bytes(sent[0]!)).toBeLessThanOrEqual(MAX_BODY);
    const data = JSON.parse(sent[0]!).data;
    // Dropping one entry frees more than the byte plus the flag.
    expect(data.recipients).toEqual(Array.from({ length: MAX_WEBHOOK_RECIPIENTS - 1 }, (_, i) => wide(i)));
    expect(data.recipients_truncated).toBe(true);
  });

  it('fits a large message that 500 recipients would push over the cap', async () => {
    const { sent } = await deliver(() => ({
      id: 'm1', channel_name: 'team', text: 'a'.repeat(220 * 1024),
      recipients: Array.from({ length: MAX_WEBHOOK_RECIPIENTS }, (_, i) => wide(i)),
    }));
    expect(sent).toHaveLength(1);
    expect(bytes(sent[0]!)).toBeLessThanOrEqual(MAX_BODY);
    const data = JSON.parse(sent[0]!).data;
    expect(data.recipients.length).toBeGreaterThan(0);
    expect(data.recipients.length).toBeLessThan(MAX_WEBHOOK_RECIPIENTS);
    expect(data.recipients_truncated).toBe(true);
  });

  it('still fails terminally when the body without recipients is over the cap', async () => {
    const { sent, summary } = await deliver(() => ({
      id: 'm1', channel_name: 'team', text: 'a'.repeat(MAX_BODY), recipients: [wide(0)],
    }));
    expect(sent).toHaveLength(0);
    expect(summary).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
  });
});

// Dialect-neutral (runs in the PostgreSQL conformance config too): HTTP through
// `stack.app` plus `runtime.deps.db`, never `runtime.handle`. The durable keyed
// DM builds `data.recipients` in SQL inside the outbox INSERT.
describe('durable keyed DM outbox data.recipients', () => {
  const headers = (token: string, extra: Record<string, string> = {}) => ({
    'content-type': 'application/json', authorization: `Bearer ${token}`, ...extra,
  });

  async function setup(stack: TestStack, name: string) {
    const ws = await createWorkspace(stack.app, name);
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const sub = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: headers(ws.workspaceKey),
      body: JSON.stringify({ events: ['dm.received'], url: 'https://hooks.example.test/dm', filter: { recipients: ['bob'] } }),
    });
    expect(sub.status).toBe(201);
    return { ws, alice, bob };
  }

  async function keyedDm(stack: TestStack, token: string, key: string, text: string): Promise<string> {
    const res = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: headers(token, { 'Idempotency-Key': key }),
      body: JSON.stringify({ to: 'bob', text }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  }

  async function storedRecipients(stack: TestStack, workspaceId: string, messageId: string) {
    const [row] = await stack.runtime.deps.db.select({ payload: pendingEvents.payload }).from(pendingEvents)
      .where(and(eq(pendingEvents.workspaceId, workspaceId), eq(pendingEvents.id, messageId)));
    expect(row).toBeDefined();
    return (row!.payload as Record<string, unknown>).recipients;
  }

  async function deliveryOf(stack: TestStack, token: string, messageId: string) {
    const res = await stack.app.request('/v1/deliveries', { headers: headers(token) });
    expect(res.status).toBe(200);
    const items = ((await res.json()) as { data: Array<{ id: string; message_id: string; agent_id: string; seq: number }> }).data;
    const item = items.find((d) => d.message_id === messageId);
    expect(item).toBeDefined();
    return item!;
  }

  it('stores one entry equal to the recipient delivery record, seq included', async () => {
    const stack = makeNodeStack();
    const { ws, alice, bob } = await setup(stack, 'durable-dm-recipients');
    const messageId = await keyedDm(stack, alice.token, 'durable-dm-1', 'keyed');
    await stack.settle();

    const delivery = await deliveryOf(stack, bob.token, messageId);
    // toEqual ignores key order (jsonb reorders keys on PostgreSQL).
    expect(await storedRecipients(stack, ws.workspaceId, messageId)).toEqual([{
      agent_id: bob.agentId, agent_name: 'bob', delivery_id: delivery.id, seq: delivery.seq,
    }]);
    expect(delivery.agent_id).toBe(bob.agentId);
  });

  it('stores recipients [] when the mailbox depth cap rejects the delivery', async () => {
    const stack = makeNodeStack({ mailbox: { deliveryTtlMs: 60_000, depthCap: 1 } });
    const { ws, alice, bob } = await setup(stack, 'durable-dm-depth-cap');
    const first = await keyedDm(stack, alice.token, 'depth-cap-1', 'fills');
    const rejected = await keyedDm(stack, alice.token, 'depth-cap-2', 'rejected');
    await stack.settle();

    const delivery = await deliveryOf(stack, bob.token, first);
    expect(await storedRecipients(stack, ws.workspaceId, first)).toEqual([{
      agent_id: bob.agentId, agent_name: 'bob', delivery_id: delivery.id, seq: delivery.seq,
    }]);
    expect(await storedRecipients(stack, ws.workspaceId, rejected)).toEqual([]);
  });
});
