import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pendingEvents } from '../../db/tables.js';
import { deliverEvent, matchesFilter } from '../../engine/eventDelivery.js';
import { createWorkspace, makeNodeStack, registerAgent, type TestStack } from './harness.js';

/**
 * A message an inbound webhook posts carries text from whoever holds the
 * webhook URL. `mentions` subscriptions (how cloud agents learn they were
 * addressed) must not fire for it; every other filter still applies.
 */
describe('inbound webhook messages and mention subscriptions', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack(); });
  afterEach(() => stack.close());

  const webhookPayload = (text: string) => ({
    id: 'm1',
    channel_name: 'hook-chan',
    text,
    from_name: 'webhook',
    metadata: { __relaycast_origin: 'inbound_webhook', __relaycast_webhook_id: 'wh_1' },
  });

  it('matchesFilter: a webhook message matches no mentions filter, an agent message still does', () => {
    expect(matchesFilter({ mentions: 'bob' }, webhookPayload('hi @bob'))).toBe(false);
    expect(matchesFilter({ mentions: 'bob' }, { text: 'hi @bob', metadata: {} })).toBe(true);
    expect(matchesFilter({ mentions: 'bob' }, { text: 'hi @bob' })).toBe(true);
    expect(matchesFilter({ channel: 'hook-chan' }, webhookPayload('hi @bob'))).toBe(true);
    expect(matchesFilter(null, webhookPayload('hi @bob'))).toBe(true);
  });

  it('an inbound webhook post naming an agent is queued with its origin and reaches no mention subscriber', async () => {
    const ws = await createWorkspace(stack.app, 'webhook-mentions');
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` };
    const owner = await registerAgent(stack.app, ws.workspaceKey, 'owner');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const channel = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: 'hook-chan' }),
    });
    expect(channel.status).toBeLessThan(300);
    for (const filter of [{ mentions: 'bob' }, { channel: 'hook-chan' }]) {
      const sub = await stack.app.request('/v1/subscriptions', {
        method: 'POST',
        headers: auth,
        body: JSON.stringify({ events: ['message.created'], url: `https://hooks.example.test/${Object.keys(filter)[0]}`, filter }),
      });
      expect(sub.status).toBe(201);
    }
    const created = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ channel: 'hook-chan' }),
    });
    const hook = (await created.json()) as { data: { webhook_id: string; token: string } };
    const post = await stack.app.request(`/v1/hooks/${hook.data.webhook_id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.data.token}` },
      // A payload makes the route emit message.created (as events-shim's forwards do).
      body: JSON.stringify({ text: 'please look @bob', source: 'webhook', author: 'webhook', payload: { ref: 'r1' } }),
    });
    expect(post.status).toBe(201);

    const queued = (await stack.runtime.handle.db.select().from(pendingEvents))
      .filter((row) => row.eventType === 'message.created');
    expect(queued).toHaveLength(1);
    const payload = queued[0]!.payload as Record<string, unknown>;
    expect(payload.text).toBe('please look @bob');
    expect(payload.metadata).toEqual({ ref: 'r1', __relaycast_origin: 'inbound_webhook' });

    const urls: string[] = [];
    const summary = await deliverEvent(stack.runtime.handle.db, ws.workspaceId, 'message.created', payload, {
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(null, { status: 202 });
      },
    });
    expect(urls).toEqual(['https://hooks.example.test/channel']);
    expect(summary.attempted).toBe(1);
  });

  async function workspaceWithMentionSub(name: string) {
    const ws = await createWorkspace(stack.app, name);
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` };
    const owner = await registerAgent(stack.app, ws.workspaceKey, 'owner');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');
    await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ name: 'hook-chan' }),
    });
    const sub = await stack.app.request('/v1/subscriptions', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ events: ['message.created'], url: 'https://hooks.example.test/m', filter: { mentions: 'bob' } }),
    });
    expect(sub.status).toBe(201);
    return { ws, auth, owner };
  }

  const queuedMessages = async () => (await stack.runtime.handle.db.select().from(pendingEvents))
    .filter((row) => row.eventType === 'message.created')
    .map((row) => row.payload as Record<string, unknown>);

  it('a webhook poster cannot replace or remove the origin through its payload', async () => {
    const { auth } = await workspaceWithMentionSub('webhook-origin-spoof');
    const created = await stack.app.request('/v1/webhooks', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ channel: 'hook-chan' }),
    });
    const hook = (await created.json()) as { data: { webhook_id: string; token: string } };
    for (const spoof of ['x', null, 'inbound_webhook ']) {
      await stack.app.request(`/v1/hooks/${hook.data.webhook_id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${hook.data.token}` },
        body: JSON.stringify({ text: 'hi @bob', payload: { __relaycast_origin: spoof, ref: 'r' } }),
      });
    }
    const queued = await queuedMessages();
    expect(queued).toHaveLength(3);
    for (const payload of queued) {
      expect(payload.metadata).toEqual({ ref: 'r', __relaycast_origin: 'inbound_webhook' });
      expect(matchesFilter({ mentions: 'bob' }, payload)).toBe(false);
    }
  });

  it('an agent cannot mark its own channel post as webhook-posted to dodge mention subscribers', async () => {
    const { owner } = await workspaceWithMentionSub('agent-origin-spoof');
    const post = await stack.app.request('/v1/channels/hook-chan/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${owner.token}` },
      body: JSON.stringify({ text: 'hi @bob', metadata: { __relaycast_origin: 'inbound_webhook', ref: 'r' } }),
    });
    expect(post.status).toBeLessThan(300);
    const queued = await queuedMessages();
    expect(queued).toHaveLength(1);
    expect((queued[0]!.metadata as Record<string, unknown> | undefined)?.__relaycast_origin).toBeUndefined();
    expect(matchesFilter({ mentions: 'bob' }, queued[0]!)).toBe(true);
  });
});

