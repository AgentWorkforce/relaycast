import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  type TestStack,
} from './harness.js';
import { agents } from '../../db/schema.js';
import * as messageEngine from '../../engine/message.js';
import * as deliveryEngine from '../../engine/delivery.js';
import { routeDeliveryOutcomes } from '../../routes/deliveryRouting.js';

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

  async function enrollAndAttachNode(
    ws: { workspaceKey: string; workspaceId: string },
    opts: { id?: string; name?: string } = {},
  ) {
    const id = opts.id ?? 'node_mailbox';
    const name = opts.name ?? 'mailbox-node';
    const create = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: id,
        name,
        capabilities: ['spawn:claude'],
        max_agents: 4,
        tags: ['mailbox-test'],
        version: 'test-node',
      }),
    });
    expect(create.status).toBe(201);

    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, id, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.register',
      name,
      node_id: id,
      capabilities: ['spawn:claude'],
      max_agents: 4,
      tags: ['mailbox-test'],
      version: 'test-node',
      resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'node.heartbeat',
      load: 0,
      active_agents: 0,
      handlers_live: true,
    }));
    return { id, name, sock, handle };
  }

  async function registerViaNode(
    node: Awaited<ReturnType<typeof enrollAndAttachNode>>,
    name: string,
  ) {
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'agent.register',
      name,
      resumable: true,
      session_ref: `sess-${name}`,
    }));
    // The engine answers agent.register with a `reply` frame (the shape the
    // relay broker's node_control client consumes): { ok, data: {agent_id, token, name} }.
    const reply = node.sock.ofType('reply').at(-1) as {
      ok: boolean;
      data: { agent_id: string; token: string; name?: string };
    };
    expect(reply?.ok).toBe(true);
    expect(reply.data).toMatchObject({ name });
    return {
      agentId: reply.data.agent_id,
      token: reply.data.token,
      name,
    };
  }

  function latestDeliverOfType(sock: FakeSocket, eventType: string) {
    const deliveries = sock.ofType('deliver');
    const match = deliveries.findLast((event: { payload?: { type?: string } }) => event.payload?.type === eventType);
    expect(match).toBeDefined();
    return match as { msg_id: string; seq: number; payload: Record<string, unknown> };
  }

  it('lists the queued delivery for a recipient with the message payload', async () => {
    const { bob, messageId } = await seed();

    const items = await listDeliveries(bob.token);
    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.message_id).toBe(messageId);
    expect(['queued', 'delivered']).toContain(item.status);
    expect(item.seq).toBe(1);
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
    expect(ack1Data.status).toBe('acked');
    // channel_id is populated on the transition response, matching the queued item.
    expect(ack1Data.channel_id).toBe(item.channel_id);
    expect(ack1Data.channel_id).not.toBe('');

    // Idempotent: second ack still 200 + acked.
    const ack2 = await stack.app.request(`/v1/deliveries/${deliveryId}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(ack2.status).toBe(200);
    expect(((await ack2.json()) as { data: { status: string } }).data.status).toBe('acked');

    // Acked items drop out of the default (queued+delivered) queue.
    expect(await listDeliveries(bob.token)).toHaveLength(0);
    // But are still listable by explicit status filter.
    expect(await listDeliveries(bob.token, '?status=acked')).toHaveLength(1);
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
    expect(data.status).toBe('queued');
    expect(data.available_at).toBe(availableAt);
    expect(data.reason).toBe('busy');
    expect(data.channel_id).toBe(item.channel_id);

    // Deferred items remain queued for later retry.
    const queued = await listDeliveries(bob.token);
    expect(queued).toHaveLength(1);
    expect(['queued', 'delivered']).toContain(queued[0].status);
  });

  it('does not resurrect an acked (terminal) delivery via defer or fail', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const ack = await stack.app.request(`/v1/deliveries/${item.id}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(ack.status).toBe(200);

    // A late defer must not move an acked record back into the queue.
    const defer = await stack.app.request(`/v1/deliveries/${item.id}/defer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ available_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    expect(defer.status).toBe(200);
    expect(((await defer.json()) as { data: { status: string } }).data.status).toBe('acked');

    // Same for a late fail.
    const fail = await stack.app.request(`/v1/deliveries/${item.id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ error: 'too late' }),
    });
    expect(fail.status).toBe(200);
    expect(((await fail.json()) as { data: { status: string } }).data.status).toBe('acked');

    // Stays out of the default queue.
    expect(await listDeliveries(bob.token)).toHaveLength(0);
  });

  it('allows recovering a failed delivery via ack (retryable failures are not terminal)', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const fail = await stack.app.request(`/v1/deliveries/${item.id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ error: 'transient', retryable: true }),
    });
    expect(fail.status).toBe(200);
    expect(((await fail.json()) as { data: { status: string } }).data.status).toBe('failed');

    // A retry that succeeds can ack the previously-failed delivery.
    const ack = await stack.app.request(`/v1/deliveries/${item.id}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { data: { status: string } }).data.status).toBe('acked');
  });

  it('includes queued deliveries in the agent detail pending_deliveries', async () => {
    const { ws, bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const defer = await stack.app.request(`/v1/deliveries/${item.id}/defer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ available_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    expect(defer.status).toBe(200);

    const res = await stack.app.request('/v1/agents/bob', {
      headers: { authorization: `Bearer ${ws.workspaceKey}` },
    });
    expect(res.status).toBe(200);
    const pending = ((await res.json()) as {
      data: { pending_deliveries: Array<{ id: string; status: string }> };
    }).data.pending_deliveries;
    const queued = pending.find((d) => d.id === item.id);
    expect(queued).toBeDefined();
    expect(queued!.status).toBe('queued');
  });

  it('rejects a malformed JSON fail body with 400 (no state change)', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const res = await stack.app.request(`/v1/deliveries/${item.id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: '{"error": "boom"', // missing closing brace
    });
    expect(res.status).toBe(400);

    // The delivery must remain queued, not flipped to failed.
    const queued = await listDeliveries(bob.token);
    expect(queued).toHaveLength(1);
    expect(['queued', 'delivered']).toContain(queued[0].status);
  });

  it('accepts an empty fail body (optional metadata)', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const res = await stack.app.request(`/v1/deliveries/${item.id}/fail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { status: string } }).data.status).toBe('failed');
  });

  it('does not inherit the acceptance reason when deferring without a reason', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);
    // The queued item carries an acceptance reason (e.g. "message").
    expect(item.reason).toBeTruthy();

    const res = await stack.app.request(`/v1/deliveries/${item.id}/defer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ available_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    expect(res.status).toBe(200);
    const data = ((await res.json()) as { data: { status: string; reason: string | null } }).data;
    expect(data.status).toBe('queued');
    expect(data.reason).toBeNull();
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

  it('emits delivery.delivered once on ack, not on idempotent retries', async () => {
    const { ws, bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const bobSock = new FakeSocket();
    stack.runtime.realtime.attachAgentSocket(ws.workspaceId, bob.agentId, bobSock);

    const ackOnce = () => stack.app.request(`/v1/deliveries/${item.id}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });

    expect((await ackOnce()).status).toBe(200);
    // A second ack is a no-op and must not re-emit the event.
    expect((await ackOnce()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(bobSock.ofType('delivery.delivered')).toHaveLength(1);
  });

  it('does not re-emit delivery.deferred when re-deferred to the same time', async () => {
    const { ws, bob } = await seed();
    const [item] = await listDeliveries(bob.token);
    const availableAt = new Date(Date.now() + 60_000).toISOString();

    const bobSock = new FakeSocket();
    stack.runtime.realtime.attachAgentSocket(ws.workspaceId, bob.agentId, bobSock);

    const deferOnce = () => stack.app.request(`/v1/deliveries/${item.id}/defer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ available_at: availableAt }),
    });

    expect((await deferOnce()).status).toBe(200);
    // Re-deferring to the identical available_at is a no-op — no second event.
    expect((await deferOnce()).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(bobSock.ofType('delivery.deferred')).toHaveLength(1);
  });

  it('preserves failure metadata across repeated fail calls (idempotent)', async () => {
    const { bob } = await seed();
    const [item] = await listDeliveries(bob.token);

    const first = await stack.app.request(`/v1/deliveries/${item.id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ error: 'boom', retryable: true }),
    });
    expect(first.status).toBe(200);

    // A second fail (even with an empty body) must not null out the recorded
    // error/retryable — the first failure is preserved.
    const second = await stack.app.request(`/v1/deliveries/${item.id}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({}),
    });
    expect(second.status).toBe(200);
    const data = ((await second.json()) as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('failed');
    expect(data.error).toBe('boom');
    expect(data.retryable).toBe(true);
  });

  it('clears a queued delivery from the replay queue when the message is read', async () => {
    const { bob, messageId } = await seed();
    const [item] = await listDeliveries(bob.token);

    const defer = await stack.app.request(`/v1/deliveries/${item.id}/defer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ available_at: new Date(Date.now() + 60_000).toISOString() }),
    });
    expect(defer.status).toBe(200);
    expect(await listDeliveries(bob.token)).toHaveLength(1);

    const read = await stack.app.request(`/v1/messages/${messageId}/read`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(read.status).toBe(200);

    // The queued item is now acked and out of the default queue.
    expect(await listDeliveries(bob.token)).toHaveLength(0);
    expect(await listDeliveries(bob.token, '?status=acked')).toHaveLength(1);
  });

  it('routes via-node deliveries over the node control connection and cumulative ack marks them read', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-route');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'node hello' }),
    });
    expect(post.status).toBe(201);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;
    await new Promise((r) => setTimeout(r, 50));

    const delivered = node.sock.ofType('deliver');
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      agent: 'bob',
      msg_id: messageId,
      seq: 1,
      mode: 'wait',
    });

    const inboxBefore = await stack.app.request('/v1/inbox', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(inboxBefore.status).toBe(200);
    expect(((await inboxBefore.json()) as {
      data: { unread_channels: Array<{ channel_name: string; unread_count: number }> };
    }).data.unread_channels).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel_name: 'general', unread_count: 1 }),
    ]));

    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'bob',
      up_to_seq: 1,
    }));

    expect(await listDeliveries(bob.token)).toHaveLength(0);
    expect(await listDeliveries(bob.token, '?status=acked')).toHaveLength(1);
    const inboxAfter = await stack.app.request('/v1/inbox', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(inboxAfter.status).toBe(200);
    expect(((await inboxAfter.json()) as {
      data: { unread_channels: Array<{ channel_name: string; unread_count: number }> };
    }).data.unread_channels).toHaveLength(0);
  });

  it('re-resolves a recipient location before fanout so a transport switch does not drop the delivery', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-reroute');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const create = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    expect(create.status).toBeLessThan(300);
    const channelId = ((await create.json()) as { data: { id: string } }).data.id;

    for (const token of [alice.token, bob.token]) {
      const joinRes = await stack.app.request('/v1/channels/team-chat/join', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(joinRes.status).toBeLessThan(300);
    }

    const result = await messageEngine.postMessage(
      stack.runtime.deps.db,
      ws.workspaceId,
      channelId,
      alice.agentId,
      { text: 'reroute me' },
      { mailbox: { ttlMs: 60_000, depthCap: 1_000 } },
    );

    expect(result._deliveries).toHaveLength(1);
    expect(result._deliveries[0]).toMatchObject({
      agentId: bob.agentId,
      locationType: 'via_node',
      locationNodeId: node.id,
    });

    const bobSock = new FakeSocket();
    stack.runtime.realtime.attachAgentSocket(ws.workspaceId, bob.agentId, bobSock);
    await stack.runtime.deps.db
      .update(agents)
      .set({ locationType: 'self_connected', locationNodeId: null })
      .where(eq(agents.id, bob.agentId));

    const ctx = {
      get(key: string) {
        if (key === 'workspace') return { id: ws.workspaceId };
        if (key === 'db') return stack.runtime.deps.db;
        if (key === 'engine') {
          return {
            nodeConnections: stack.runtime.realtime,
            realtime: stack.runtime.realtime,
          };
        }
        return undefined;
      },
    } as unknown as Parameters<typeof routeDeliveryOutcomes>[0];

    await routeDeliveryOutcomes(ctx, result._deliveries, 'message.created', {
      channel_id: channelId,
      channel_name: 'team-chat',
      from_name: 'alice',
      injection_mode: 'wait',
    });

    expect(node.sock.ofType('deliver')).toHaveLength(0);
    expect(bobSock.ofType('delivery.accepted')).toHaveLength(1);
    expect(await listDeliveries(bob.token)).toHaveLength(1);
    expect(await listDeliveries(bob.token, '?status=delivered')).toHaveLength(1);
  });

  it('does not redeliver acked messages after a node reconnect with inventory sync', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-acked-reconnect');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'ack survives reconnect' }),
    });
    expect(post.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(node.sock.ofType('deliver')).toHaveLength(1);

    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'bob',
      up_to_seq: 1,
    }));
    await node.handle.handleClose();

    const reconnected = await enrollAndAttachNode(ws, { id: node.id, name: node.name });
    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [{ agent_id: bob.agentId, name: 'bob', session_ref: 'sess-bob' }],
    }));
    await new Promise((r) => setTimeout(r, 50));
    expect(reconnected.sock.ofType('deliver')).toHaveLength(0);
  });

  it('redelivers a channel message with the same deliver payload after broker death/reconnect', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-redeliver-message');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
      body: JSON.stringify({ text: 'redeliver me' }),
    });
    expect(post.status).toBe(201);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;
    await new Promise((r) => setTimeout(r, 50));
    const live = latestDeliverOfType(node.sock, 'message.created');
    expect(live).toMatchObject({ msg_id: messageId });

    await node.handle.handleClose();
    const reconnected = await enrollAndAttachNode(ws, { id: node.id, name: node.name });
    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [{ agent_id: bob.agentId, name: 'bob', session_ref: 'sess-bob' }],
    }));
    await new Promise((r) => setTimeout(r, 50));

    const replayed = latestDeliverOfType(reconnected.sock, 'message.created');
    expect(replayed).toMatchObject({ msg_id: messageId });
    expect(replayed.payload).toEqual(live.payload);
  });

  it('redelivers a DM with the same deliver payload after broker death/reconnect', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-redeliver-dm');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const dm = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
      body: JSON.stringify({ to: 'bob', text: 'redeliver dm' }),
    });
    expect(dm.status).toBe(201);
    const messageId = ((await dm.json()) as { data: { id: string } }).data.id;
    await new Promise((r) => setTimeout(r, 50));
    const live = latestDeliverOfType(node.sock, 'dm.received');
    expect(live).toMatchObject({ msg_id: messageId });

    await node.handle.handleClose();
    const reconnected = await enrollAndAttachNode(ws, { id: node.id, name: node.name });
    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [{ agent_id: bob.agentId, name: 'bob', session_ref: 'sess-bob' }],
    }));
    await new Promise((r) => setTimeout(r, 50));

    const replayed = latestDeliverOfType(reconnected.sock, 'dm.received');
    expect(replayed).toMatchObject({ msg_id: messageId });
    expect(replayed.payload).toEqual(live.payload);
  });

  it('redelivers a group DM with the same deliver payload after broker death/reconnect', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-redeliver-group');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const create = await stack.app.request('/v1/dm/group', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
      body: JSON.stringify({ participants: ['bob'] }),
    });
    expect(create.status).toBe(201);
    const conversationId = ((await create.json()) as { data: { id: string } }).data.id;

    const msg = await stack.app.request('/v1/dm/' + conversationId + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
      body: JSON.stringify({ text: 'redeliver group' }),
    });
    expect(msg.status).toBe(201);
    const messageId = ((await msg.json()) as { data: { id: string } }).data.id;
    await new Promise((r) => setTimeout(r, 50));
    const live = latestDeliverOfType(node.sock, 'group_dm.received');
    expect(live).toMatchObject({ msg_id: messageId });

    await node.handle.handleClose();
    const reconnected = await enrollAndAttachNode(ws, { id: node.id, name: node.name });
    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [{ agent_id: bob.agentId, name: 'bob', session_ref: 'sess-bob' }],
    }));
    await new Promise((r) => setTimeout(r, 50));

    const replayed = latestDeliverOfType(reconnected.sock, 'group_dm.received');
    expect(replayed).toMatchObject({ msg_id: messageId });
    expect(replayed.payload).toEqual(live.payload);
  });

  it('redelivers a thread reply with the same deliver payload after broker death/reconnect', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-redeliver-thread');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const root = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
      body: JSON.stringify({ text: 'thread root' }),
    });
    expect(root.status).toBe(201);
    const rootId = ((await root.json()) as { data: { id: string } }).data.id;

    const reply = await stack.app.request('/v1/messages/' + rootId + '/replies', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + alice.token },
      body: JSON.stringify({ text: 'redeliver thread' }),
    });
    expect(reply.status).toBe(201);
    const messageId = ((await reply.json()) as { data: { id: string } }).data.id;
    await new Promise((r) => setTimeout(r, 50));
    const live = latestDeliverOfType(node.sock, 'thread.reply');
    expect(live).toMatchObject({ msg_id: messageId });

    await node.handle.handleClose();
    const reconnected = await enrollAndAttachNode(ws, { id: node.id, name: node.name });
    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [{ agent_id: bob.agentId, name: 'bob', session_ref: 'sess-bob' }],
    }));
    await new Promise((r) => setTimeout(r, 50));

    const replayed = latestDeliverOfType(reconnected.sock, 'thread.reply');
    expect(replayed).toMatchObject({ msg_id: messageId });
    expect(replayed.payload).toEqual(live.payload);
  });
  it('handles out-of-order cumulative acks idempotently', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-out-of-order');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    for (const text of ['one', 'two']) {
      const post = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text }),
      });
      expect(post.status).toBe(201);
    }
    await new Promise((r) => setTimeout(r, 75));
    expect(node.sock.ofType('deliver').map((event) => event.seq)).toEqual([1, 2]);

    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'bob',
      up_to_seq: 2,
    }));
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'bob',
      up_to_seq: 1,
    }));

    expect(await listDeliveries(bob.token)).toHaveLength(0);
    expect(await listDeliveries(bob.token, '?status=acked')).toHaveLength(2);
  });

  it('does not dead-letter an acked delivery when ack and TTL expiry race', async () => {
    stack.runtime.deps.config!.mailbox = { deliveryTtlMs: 1, depthCap: 1000 };

    const { ws, alice, bob } = await seed();
    const aliceSock = new FakeSocket();
    stack.runtime.realtime.attachAgentSocket(ws.workspaceId, alice.agentId, aliceSock);
    const [item] = await listDeliveries(bob.token);

    await new Promise((r) => setTimeout(r, 5));
    const ack = stack.app.request('/v1/deliveries/' + item.id + '/ack', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bob.token },
    });
    const expired = deliveryEngine.expireDueDeliveries(stack.runtime.deps.db, ws.workspaceId);
    const [ackRes, expiredRows] = await Promise.all([ack, expired]);
    expect(ackRes.status).toBe(200);
    expect(expiredRows).toHaveLength(0);
    expect(await listDeliveries(bob.token, '?status=acked')).toHaveLength(1);
    expect(aliceSock.ofType('delivery.failed')).toHaveLength(0);
  });

  it('expires TTL deliveries to dead-letter and notifies the sender', async () => {
    stack.runtime.deps.config!.mailbox = { deliveryTtlMs: 1000, depthCap: 1000 };

    const { ws, alice, bob } = await seed();
    const aliceSock = new FakeSocket();
    stack.runtime.realtime.attachAgentSocket(ws.workspaceId, alice.agentId, aliceSock);

    await new Promise((r) => setTimeout(r, 1100));
    expect(await listDeliveries(bob.token)).toHaveLength(0);
    expect(await listDeliveries(bob.token, '?status=dead_lettered')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(aliceSock.ofType('delivery.failed')).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'ttl_expired', retryable: false }),
    ]));
  });

  it('rejects new deliveries over the depth cap and sends feedback to the sender', async () => {
    stack.runtime.deps.config!.mailbox = { deliveryTtlMs: 60_000, depthCap: 1 };

    const { ws, alice, bob } = await seed();
    const aliceSock = new FakeSocket();
    stack.runtime.realtime.attachAgentSocket(ws.workspaceId, alice.agentId, aliceSock);

    const second = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'overflow' }),
    });
    expect(second.status).toBe(201);
    await new Promise((r) => setTimeout(r, 75));

    expect(await listDeliveries(bob.token)).toHaveLength(1);
    expect(aliceSock.ofType('delivery.failed')).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message_id: ((await second.json()) as { data: { id: string } }).data.id,
        target_agent_name: 'bob',
        reason: 'depth_cap',
        retryable: false,
      }),
    ]));
  });
});
