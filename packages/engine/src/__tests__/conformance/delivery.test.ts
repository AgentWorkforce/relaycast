import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  type TestStack,
} from './harness.js';

/**
 * Durable delivery API conformance: listing the queued inbox, and the
 * idempotent ack / fail / defer transitions over the public engine routes.
 */
describe('durable delivery api', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  /** Stand up a workspace + channel with alice and bob joined, alice posts one message. */
  async function seed() {
    const ws = await createWorkspace(stack.app, 'delivery-ws');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const createRes = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    expect(createRes.status).toBeLessThan(300);
    for (const token of [alice.token, bob.token]) {
      const joinRes = await stack.app.request('/v1/channels/team-chat/join', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(joinRes.status).toBeLessThan(300);
    }

    const postRes = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'hello bob' }),
    });
    expect(postRes.status).toBeLessThan(300);
    const messageId = ((await postRes.json()) as { data: { id: string } }).data.id;

    return { ws, alice, bob, messageId };
  }

  async function listDeliveries(token: string, query = '') {
    const res = await stack.app.request(`/v1/deliveries${query}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: Array<Record<string, unknown>> }).data;
  }

  it('lists the queued delivery for a recipient with the message payload', async () => {
    const { bob, messageId } = await seed();

    const items = await listDeliveries(bob.token);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.message_id).toBe(messageId);
    expect(item.status).toBe('accepted');
    expect(item.agent_id).toBe(bob.agentId);
    expect((item.message as { text: string }).text).toBe('hello bob');
    expect((item.message as { agent_name: string }).agent_name).toBe('alice');
  });

  it('does not expose deliveries to non-recipients', async () => {
    const { alice } = await seed();
    // alice is the sender, so she has no delivery row of her own
    const items = await listDeliveries(alice.token);
    expect(items).toHaveLength(0);
  });

  it('acks a delivery idempotently and removes it from the default queue', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);
    const deliveryId = item.id as string;

    const ack1 = await stack.app.request(`/v1/deliveries/${deliveryId}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(ack1.status).toBe(200);
    const ack1Data = ((await ack1.json()) as { data: { status: string; channel_id: string } }).data;
    expect(ack1Data.status).toBe('delivered');
    // channel_id is populated on the transition response, matching the queued item.
    expect(ack1Data.channel_id).toBe(item.channel_id);
    expect(ack1Data.channel_id).not.toBe('');

    // Idempotent: second ack still 200 + delivered.
    const ack2 = await stack.app.request(`/v1/deliveries/${deliveryId}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(ack2.status).toBe(200);
    expect(((await ack2.json()) as { data: { status: string } }).data.status).toBe('delivered');

    // Delivered items drop out of the default (accepted+deferred) queue.
    expect(await listDeliveries(bob.token)).toHaveLength(0);
    // But are still listable by explicit status filter.
    expect(await listDeliveries(bob.token, '?status=delivered')).toHaveLength(1);
  });

  it('records a failed delivery with error text and retryability', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const res = await stack.app.request(`/v1/deliveries/${item.id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ error: 'handler threw', retryable: true }),
    });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('failed');
    expect(data.error).toBe('handler threw');
    expect(data.retryable).toBe(true);
    expect(data.channel_id).toBe(item.channel_id);
  });

  it('defers a delivery with available_at and keeps it in the queue', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);
    // Timestamps are stored at second precision (unixepoch), so align to the second.
    const availableAt = new Date(Math.floor((Date.now() + 60_000) / 1000) * 1000).toISOString();

    const res = await stack.app.request(`/v1/deliveries/${item.id}/defer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ available_at: availableAt, reason: 'busy' }),
    });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('deferred');
    expect(data.available_at).toBe(availableAt);
    expect(data.reason).toBe('busy');
    expect(data.channel_id).toBe(item.channel_id);

    // Deferred items remain in the default queue for later retry.
    const queued = await listDeliveries(bob.token);
    expect(queued).toHaveLength(1);
    expect(queued[0].status).toBe('deferred');
  });

  it('rejects an invalid defer payload', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);
    const res = await stack.app.request(`/v1/deliveries/${item.id}/defer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ available_at: 'not-a-date' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown or unowned delivery', async () => {
    const { alice } = await seed();
    const res = await stack.app.request('/v1/deliveries/del_does_not_exist/ack', {
      method: 'POST',
      headers: { authorization: `Bearer ${alice.token}` },
    });
    expect(res.status).toBe(404);
  });

  it('emits delivery.delivered to the recipient on ack', async () => {
    const { ws, bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const bobSock = new FakeSocket();
    stack.runtime.realtime.attachAgentSocket(ws.workspaceId, bob.agentId, bobSock);

    const res = await stack.app.request(`/v1/deliveries/${item.id}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(bobSock.ofType('delivery.delivered').length).toBeGreaterThanOrEqual(1);
  });
});
