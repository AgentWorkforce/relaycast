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
    expect(withStoredRecipients({}, recipients(3), [])).toEqual({ recipients: recipients(3) });

    const stored = withStoredRecipients({ text: 'x' }, all, [{ events: ['*'], filter: { recipients: ['agent-550'] } }]);
    expect(stored.recipients_truncated).toBe(true);
    expect((stored.recipients as WebhookRecipient[]).map((r) => r.agent_name))
      .toEqual([...all.slice(0, MAX_WEBHOOK_RECIPIENTS).map((r) => r.agent_name), 'agent-550']);

    const unknown = withStoredRecipients({}, recipients(MAX_STORED_WEBHOOK_RECIPIENTS + 10), null);
    expect(unknown.recipients).toHaveLength(MAX_STORED_WEBHOOK_RECIPIENTS);
    expect(unknown.recipients_truncated).toBe(true);
  });
});

describe('per-subscription data.recipients at delivery', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  async function deliverTo(
    filters: Record<string, Record<string, unknown> | null>,
    payload: Record<string, unknown>,
  ) {
    const ws = await createWorkspace(stack.app, 'recipients-delivery');
    for (const [path, filter] of Object.entries(filters)) {
      const res = await stack.app.request('/v1/subscriptions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
        body: JSON.stringify({ events: ['message.created'], url: `https://hooks.example.test/${path}`, filter }),
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
    const stored = withStoredRecipients({ id: 'm1', channel_name: 'team', text: 'hi' }, all, matchers);
    const bodies = await deliverTo({ all: null, late: { recipients: ['agent-550'] } }, stored);

    const unfiltered = bodies.get('all')!.data;
    expect(unfiltered.recipients).toEqual(all.slice(0, MAX_WEBHOOK_RECIPIENTS));
    expect(unfiltered.recipients_truncated).toBe(true);
    // Matched against the full list: the 551st recipient is still found and delivered.
    const late = bodies.get('late')!.data;
    expect(late.recipients).toEqual([recipient(550)]);
    expect(late.recipients_truncated).toBeUndefined();
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
