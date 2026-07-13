import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { FLEET_DELIVERY_CURSOR_CAPABILITY } from '@relaycast/types';
import {
  makeNodeStack,
  createWorkspace,
  registerAgent,
  FakeSocket,
  attachDirectNodeSocket,
  deliverFramesOfType,
  contextUpdatesOfType,
  type TestStack,
} from './harness.js';
import { agents, deliveries, messages } from '../../db/schema.js';
import * as messageEngine from '../../engine/message.js';
import * as deliveryEngine from '../../engine/delivery.js';
import { ensureDirectNodeForAgent } from '../../engine/node.js';
import { sendNodeDeliveriesToAgents } from '../../engine/nodeDeliver.js';
import type { NodeConnectionRegistry } from '../../ports/realtime.js';
import { pruneExpired } from '../../engine/retention.js';
import { routeDeliveryOutcomes, sweepExpiredDeliveries } from '../../routes/deliveryRouting.js';
import { deliverPendingToNode, handleNodeReconnect } from '../../index.js';

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

  async function waitForAssertion(
    assertion: () => void | Promise<void>,
    timeoutMs = 1_000,
  ) {
    const started = Date.now();
    let lastError: unknown;
    while (Date.now() - started < timeoutMs) {
      try {
        await assertion();
        return;
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw lastError;
  }

  async function enrollAndAttachNode(
    ws: { workspaceKey: string; workspaceId: string },
    opts: { id?: string; name?: string; cursorHandshake?: boolean } = {},
  ) {
    const id = opts.id ?? 'node_mailbox';
    const name = opts.name ?? 'mailbox-node';
    const capabilities = opts.cursorHandshake
      ? [
        { name: 'spawn:claude', kind: 'capacity' },
        { name: FLEET_DELIVERY_CURSOR_CAPABILITY, kind: 'capacity' },
      ]
      : [{ name: 'spawn:claude', kind: 'capacity' }];
    const create = await stack.app.request('/v1/nodes', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({
        node_id: id,
        name,
        capabilities: capabilities.map((capability) => capability.name),
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
      capabilities,
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
      data: { agent_id: string; token: string; name?: string; delivery_ack_seq?: number };
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

    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

    const ackOnce = () => stack.app.request(`/v1/deliveries/${item.id}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });

    expect((await ackOnce()).status).toBe(200);
    // A second ack is a no-op and must not re-emit the event.
    expect((await ackOnce()).status).toBe(200);
    await waitForAssertion(() => {
      expect(contextUpdatesOfType(bobSock, 'delivery.delivered')).toHaveLength(1);
    });
  });

  it('does not re-emit delivery.deferred when re-deferred to the same time', async () => {
    const { ws, bob } = await seed();
    const [item] = await listDeliveries(bob.token);
    const availableAt = new Date(Date.now() + 60_000).toISOString();

    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

    const deferOnce = () => stack.app.request(`/v1/deliveries/${item.id}/defer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${bob.token}` },
      body: JSON.stringify({ available_at: availableAt }),
    });

    expect((await deferOnce()).status).toBe(200);
    // Re-deferring to the identical available_at is a no-op — no second event.
    expect((await deferOnce()).status).toBe(200);
    await waitForAssertion(() => {
      expect(contextUpdatesOfType(bobSock, 'delivery.deferred')).toHaveLength(1);
    });
  });

  it('preserves failure metadata across repeated fail calls (idempotent)', async () => {
    const { ws, bob } = await seed();
    const [item] = await listDeliveries(bob.token);
    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

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
    await waitForAssertion(() => {
      expect(contextUpdatesOfType(bobSock, 'delivery.failed')).toHaveLength(1);
    });
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

  it('returns the authoritative cursor before resumed delivery only to negotiated brokers', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-cursor-handshake');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws, { cursorHandshake: true });
    const bob = await registerViaNode(node, 'bob');

    const initialReply = node.sock.ofType('reply').at(-1) as {
      data: { delivery_ack_seq?: number };
    };
    expect(initialReply.data.delivery_ack_seq).toBe(0);

    const first = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'before broker restart' }),
    });
    expect(first.status).toBe(201);
    await waitForAssertion(() => expect(node.sock.ofType('deliver')).toHaveLength(1));
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: bob.name,
      up_to_seq: 1,
    }));
    await node.handle.handleClose();

    const second = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'after broker restart' }),
    });
    expect(second.status).toBe(201);

    const resumed = await enrollAndAttachNode(ws, {
      id: node.id,
      name: node.name,
      cursorHandshake: true,
    });
    expect(resumed.sock.ofType('deliver')).toHaveLength(0);
    await resumed.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'resume-bob',
      type: 'agent.register',
      name: bob.name,
      resumable: true,
      session_ref: 'sess-bob',
    }));

    const replyIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'reply' && frame.id === 'resume-bob',
    );
    const deliveryIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'deliver' && frame.seq === 2,
    );
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(resumed.sock.received[replyIndex]).toMatchObject({
      data: { agent_id: bob.agentId, delivery_ack_seq: 1 },
    });
    expect(deliveryIndex).toBeGreaterThan(replyIndex);

    const legacy = await enrollAndAttachNode(ws, {
      id: 'node_legacy_cursor',
      name: 'legacy-cursor-node',
    });
    await legacy.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'legacy-register',
      type: 'agent.register',
      name: 'legacy-worker',
    }));
    const legacyReply = legacy.sock.received.find(
      (frame) => frame.type === 'reply' && frame.id === 'legacy-register',
    ) as { data: Record<string, unknown> };
    expect(legacyReply.data).not.toHaveProperty('delivery_ack_seq');
  });

  it('does not replay another negotiated agent before that agent receives its cursor', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-cursor-agent-scope');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws, { cursorHandshake: true });
    const bob = await registerViaNode(node, 'bob');
    const carol = await registerViaNode(node, 'carol');

    const first = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'before multi-agent restart' }),
    });
    expect(first.status).toBe(201);
    await waitForAssertion(() => {
      const deliveredAgents = node.sock.ofType('deliver')
        .filter((frame) => frame.seq === 1)
        .map((frame) => frame.agent)
        .sort();
      expect(deliveredAgents).toEqual(['bob', 'carol']);
    });
    for (const agent of [bob, carol]) {
      await node.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'delivery.ack',
        agent: agent.name,
        up_to_seq: 1,
      }));
    }
    await node.handle.handleClose();

    const second = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'after multi-agent restart' }),
    });
    expect(second.status).toBe(201);

    const resumed = await enrollAndAttachNode(ws, {
      id: node.id,
      name: node.name,
      cursorHandshake: true,
    });
    expect(resumed.sock.ofType('deliver')).toHaveLength(0);

    await resumed.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'resume-bob-first',
      type: 'agent.register',
      name: bob.name,
      resumable: true,
      session_ref: 'sess-bob',
    }));
    const bobReplyIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'reply' && frame.id === 'resume-bob-first',
    );
    const bobDeliveryIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'deliver' && frame.agent === bob.name && frame.seq === 2,
    );
    expect(bobReplyIndex).toBeGreaterThanOrEqual(0);
    expect(bobDeliveryIndex).toBeGreaterThan(bobReplyIndex);
    expect(resumed.sock.ofType('deliver').some((frame) => frame.agent === carol.name)).toBe(false);

    await resumed.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'resume-carol-second',
      type: 'agent.register',
      name: carol.name,
      resumable: true,
      session_ref: 'sess-carol',
    }));
    const carolReplyIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'reply' && frame.id === 'resume-carol-second',
    );
    const carolDeliveryIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'deliver' && frame.agent === carol.name && frame.seq === 2,
    );
    expect(carolReplyIndex).toBeGreaterThan(bobDeliveryIndex);
    expect(carolDeliveryIndex).toBeGreaterThan(carolReplyIndex);
  });

  it('gates live durable and seq-zero delivery until the agent cursor reply is sent', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-cursor-live-gate');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws, { cursorHandshake: true });
    const bob = await registerViaNode(node, 'bob');

    const first = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'establish cursor' }),
    });
    expect(first.status).toBe(201);
    await waitForAssertion(() => {
      expect(node.sock.ofType('deliver').some((frame) => frame.agent === bob.name && frame.seq === 1)).toBe(true);
    });
    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: bob.name,
      up_to_seq: 1,
    }));
    await node.handle.handleClose();

    const resumed = await enrollAndAttachNode(ws, {
      id: node.id,
      name: node.name,
      cursorHandshake: true,
    });
    const live = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'arrives before cursor readiness' }),
    });
    expect(live.status).toBe(201);
    let adapterSendAttempts = 0;
    const recordingRegistry: NodeConnectionRegistry = {
      upgradeNode: async () => new Response(null, { status: 501 }),
      sendToNode: async () => false,
      sendToProvider: async () => {
        adapterSendAttempts++;
        return true;
      },
      isNodeConnected: () => true,
      isProviderConnected: () => true,
      setProviderDeliveryReadiness: () => {},
      markProviderAgentsDeliveryReady: () => {},
      isProviderAgentDeliveryReady: () => false,
      detachProvider: () => {},
      disconnectNode: async () => {},
      drainNode: async () => {},
    };
    await sendNodeDeliveriesToAgents({
      db: stack.runtime.deps.db,
      nodeConnections: recordingRegistry,
      workspaceId: ws.workspaceId,
      environment: 'test',
    }, {
      agentIds: [bob.agentId],
      event: 'message.reacted',
      eventKey: 'adapter-before-cursor-ready',
      data: { message_id: 'msg_adapter_before_cursor', emoji: 'eyes' },
      messageId: 'msg_adapter_before_cursor',
    });
    expect(adapterSendAttempts).toBe(0);

    await sendNodeDeliveriesToAgents({
      db: stack.runtime.deps.db,
      nodeConnections: stack.runtime.deps.nodeConnections,
      workspaceId: ws.workspaceId,
      environment: 'test',
    }, {
      agentIds: [bob.agentId],
      event: 'message.reacted',
      eventKey: 'before-cursor-ready',
      data: { message_id: 'msg_before_cursor', emoji: 'eyes' },
      messageId: 'msg_before_cursor',
    });
    expect(resumed.sock.ofType('deliver')).toHaveLength(0);

    await resumed.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'resume-live-gated-bob',
      type: 'agent.register',
      name: bob.name,
      resumable: true,
      session_ref: 'sess-bob',
    }));
    const replyIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'reply' && frame.id === 'resume-live-gated-bob',
    );
    const durableIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'deliver' && frame.agent === bob.name && frame.seq === 2,
    );
    expect(durableIndex).toBeGreaterThan(replyIndex);

    await sendNodeDeliveriesToAgents({
      db: stack.runtime.deps.db,
      nodeConnections: stack.runtime.deps.nodeConnections,
      workspaceId: ws.workspaceId,
      environment: 'test',
    }, {
      agentIds: [bob.agentId],
      event: 'message.reacted',
      eventKey: 'after-cursor-ready',
      data: { message_id: 'msg_after_cursor', emoji: 'eyes' },
      messageId: 'msg_after_cursor',
    });
    expect(resumed.sock.ofType('deliver').some((frame) => frame.agent === bob.name && frame.seq === 0)).toBe(true);
  });

  it('rejects a mismatched inventory identity without making its agent delivery-ready', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-cursor-inventory-id');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws, { cursorHandshake: true });
    const bob = await registerViaNode(node, 'bob');
    await node.handle.handleClose();

    const resumed = await enrollAndAttachNode(ws, {
      id: node.id,
      name: node.name,
      cursorHandshake: true,
    });
    await resumed.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'inventory-wrong-bob-id',
      type: 'inventory.sync',
      agents: [{ agent_id: 'agt_wrong_bob', name: bob.name, session_ref: 'sess-bob' }],
    }));
    expect(resumed.sock.ofType('error').at(-1)).toMatchObject({
      id: 'inventory-wrong-bob-id',
      code: 'agent_identity_mismatch',
    });

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'must remain gated after bad inventory' }),
    });
    expect(post.status).toBe(201);
    expect(resumed.sock.ofType('deliver')).toHaveLength(0);

    await resumed.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'resume-bob-after-bad-inventory',
      type: 'agent.register',
      name: bob.name,
      resumable: true,
      session_ref: 'sess-bob',
    }));
    const replyIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'reply' && frame.id === 'resume-bob-after-bad-inventory',
    );
    const deliveryIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'deliver' && frame.agent === bob.name && frame.seq === 1,
    );
    expect(deliveryIndex).toBeGreaterThan(replyIndex);
  });

  it('replays only inventoried cursor agents after a transient control reconnect', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-cursor-inventory-scope');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws, { cursorHandshake: true });
    const bob = await registerViaNode(node, 'bob');
    const carol = await registerViaNode(node, 'carol');

    const first = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'before transient reconnect' }),
    });
    expect(first.status).toBe(201);
    await waitForAssertion(() => {
      expect(node.sock.ofType('deliver').filter((frame) => frame.seq === 1)).toHaveLength(2);
    });
    for (const agent of [bob, carol]) {
      await node.handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'delivery.ack',
        agent: agent.name,
        up_to_seq: 1,
      }));
    }
    await node.handle.handleClose();

    const second = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'queued during transport outage' }),
    });
    expect(second.status).toBe(201);

    const resumed = await enrollAndAttachNode(ws, {
      id: node.id,
      name: node.name,
      cursorHandshake: true,
    });
    expect(resumed.sock.ofType('deliver')).toHaveLength(0);
    await resumed.handle.handleMessage(JSON.stringify({
      v: 1,
      id: 'inventory-bob-only',
      type: 'inventory.sync',
      agents: [{ agent_id: bob.agentId, name: bob.name, session_ref: 'sess-bob' }],
    }));

    const replyIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'reply' && frame.id === 'inventory-bob-only',
    );
    const bobDeliveryIndex = resumed.sock.received.findIndex(
      (frame) => frame.type === 'deliver' && frame.agent === bob.name && frame.seq === 2,
    );
    expect(replyIndex).toBeGreaterThanOrEqual(0);
    expect(bobDeliveryIndex).toBeGreaterThan(replyIndex);
    expect(resumed.sock.ofType('deliver').some((frame) => frame.agent === carol.name)).toBe(false);
  });

  it('keeps a legacy provider reconnect from flushing a cursor provider mailbox', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-cursor-provider-scope');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const cursor = await enrollAndAttachNode(ws, { cursorHandshake: true });
    const cursorAgent = await registerViaNode(cursor, 'cursor-agent');

    const attachLegacyProvider = async (instanceId: string) => {
      const sock = new FakeSocket();
      const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, cursor.id, sock);
      await handle.handleMessage(JSON.stringify({
        v: 1,
        id: `register-legacy-${instanceId}`,
        type: 'node.register',
        name: cursor.name,
        node_id: cursor.id,
        provider: { name: 'legacy', instance_id: instanceId },
        capabilities: [{ name: 'spawn:codex', kind: 'capacity' }],
        max_agents: 4,
        tags: ['mailbox-test'],
        version: 'test-node',
        resume_cursor: null,
      }));
      await handle.handleMessage(JSON.stringify({
        v: 1,
        type: 'node.heartbeat',
        provider: { name: 'legacy', instance_id: instanceId },
        load: 0,
        active_agents: 0,
        handlers_live: true,
      }));
      return { id: cursor.id, name: cursor.name, sock, handle };
    };

    const legacy = await attachLegacyProvider('legacy-i1');
    const legacyAgent = await registerViaNode(legacy, 'legacy-agent');
    const first = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'before provider reconnect' }),
    });
    expect(first.status).toBe(201);
    await waitForAssertion(() => {
      expect(cursor.sock.ofType('deliver').some((frame) => frame.agent === cursorAgent.name && frame.seq === 1)).toBe(true);
      expect(legacy.sock.ofType('deliver').some((frame) => frame.agent === legacyAgent.name && frame.seq === 1)).toBe(true);
    });
    await cursor.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: cursorAgent.name,
      up_to_seq: 1,
    }));
    await legacy.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: legacyAgent.name,
      up_to_seq: 1,
    }));
    await cursor.handle.handleClose();
    await legacy.handle.handleClose();

    const second = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'queued for both providers' }),
    });
    expect(second.status).toBe(201);

    const cursorResumed = await enrollAndAttachNode(ws, {
      id: cursor.id,
      name: cursor.name,
      cursorHandshake: true,
    });
    expect(cursorResumed.sock.ofType('deliver')).toHaveLength(0);
    const legacyResumed = await attachLegacyProvider('legacy-i2');
    expect(legacyResumed.sock.ofType('deliver')).toEqual([
      expect.objectContaining({ agent: legacyAgent.name, seq: 2 }),
    ]);
    expect(cursorResumed.sock.ofType('deliver')).toHaveLength(0);
  });

  it('honors recorded route metadata when live binding changes before fanout', async () => {
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

    await ensureDirectNodeForAgent(
      stack.runtime.deps.db,
      ws.workspaceId,
      { id: bob.agentId, name: 'bob', locationNodeId: node.id },
      { force: true, online: true },
    );

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

    expect(node.sock.ofType('deliver')).toHaveLength(1);
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

  it('replays and acknowledges the next sequence after settled history is pruned offline', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-pruned-history');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const first = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'first' }),
    });
    expect(first.status).toBe(201);
    await waitForAssertion(() => {
      expect(deliverFramesOfType(node.sock, 'message.created').map((frame) => frame.seq)).toEqual([1]);
    });

    await node.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'bob',
      up_to_seq: 1,
    }));
    await stack.runtime.deps.db
      .update(deliveries)
      .set({ createdAt: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) })
      .where(eq(deliveries.agentId, bob.agentId));
    expect((await pruneExpired(stack.runtime.deps.db)).deliveries).toBe(1);

    await node.handle.handleClose();
    const second = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'second while offline' }),
    });
    expect(second.status).toBe(201);

    const reconnected = await enrollAndAttachNode(ws, { id: node.id, name: node.name });
    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [{ agent_id: bob.agentId, name: 'bob', session_ref: 'sess-bob' }],
    }));
    await waitForAssertion(() => {
      expect(deliverFramesOfType(reconnected.sock, 'message.created').map((frame) => frame.seq)).toEqual([2]);
    });

    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'bob',
      up_to_seq: 2,
    }));
    const [recipient] = await stack.runtime.deps.db
      .select({ ackSeq: agents.deliveryAckSeq, deliverySeq: agents.deliverySeq })
      .from(agents)
      .where(eq(agents.id, bob.agentId));
    expect(recipient).toEqual({ ackSeq: 2, deliverySeq: 2 });
    expect(await listDeliveries(bob.token)).toHaveLength(0);
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

  it('exports node reconnect delivery replay for adapters that own node.register', async () => {
    expect(deliverPendingToNode).toBeTypeOf('function');

    const ws = await createWorkspace(stack.app, 'mailbox-node-exported-reconnect');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    const post = await stack.app.request('/v1/channels/general/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'external reconnect replay' }),
    });
    expect(post.status).toBe(201);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;
    await waitForAssertion(() => {
      expect(deliverFramesOfType(node.sock, 'message.created')).toHaveLength(1);
    });

    await node.handle.handleClose();

    const replaySock = new FakeSocket();
    const replayHandle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, node.id, replaySock);
    stack.runtime.realtime.attachProvider(
      ws.workspaceId,
      node.id,
      'default',
      'external-adapter-reconnect',
      replayHandle.connectionId!,
    );
    stack.runtime.realtime.setProviderDeliveryReadiness(
      ws.workspaceId,
      node.id,
      'default',
      replayHandle.connectionId,
      'immediate',
    );
    const replayedCount = await handleNodeReconnect(
      stack.runtime.deps.db,
      stack.runtime.deps.nodeConnections,
      ws.workspaceId,
      node.id,
    );

    expect(replayedCount).toBe(1);
    expect(deliverFramesOfType(replaySock, 'message.created')).toEqual([
      expect.objectContaining({
        agent: bob.name,
        msg_id: messageId,
      }),
    ]);
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

  it('delivers thread replies on DM conversations to participants', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-dm-thread-reply');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

    const root = await stack.app.request('/v1/dm', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ to: 'bob', text: 'dm root' }),
    });
    expect(root.status).toBe(201);
    const rootId = ((await root.json()) as { data: { id: string } }).data.id;
    bobSock.received.length = 0;

    const reply = await stack.app.request(`/v1/messages/${rootId}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'dm thread reply' }),
    });
    expect(reply.status).toBe(201);
    const replyId = ((await reply.json()) as { data: { id: string } }).data.id;

    await waitForAssertion(() => {
      expect(deliverFramesOfType(bobSock, 'thread.reply')).toEqual([
        expect.objectContaining({
          type: 'deliver',
          msg_id: replyId,
          payload: expect.objectContaining({
            type: 'thread.reply',
            data: expect.objectContaining({
              id: replyId,
              from_name: 'alice',
              text: 'dm thread reply',
            }),
          }),
        }),
      ]);
    });
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

  it('does not skip a lower-seq queued delivery on node replay after an out-of-order per-delivery ack', async () => {
    const ws = await createWorkspace(stack.app, 'mailbox-node-ooo-single-ack');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollAndAttachNode(ws);
    const bob = await registerViaNode(node, 'bob');

    for (const text of ['first', 'second']) {
      const post = await stack.app.request('/v1/channels/general/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
        body: JSON.stringify({ text }),
      });
      expect(post.status).toBe(201);
    }
    await new Promise((r) => setTimeout(r, 75));
    expect(node.sock.ofType('deliver').map((event) => event.seq)).toEqual([1, 2]);

    // Ack ONLY seq 2 via the per-delivery REST path, out of order — seq 1 stays queued.
    const queued = await listDeliveries(bob.token);
    const seq2 = queued.find((item) => item.seq === 2);
    expect(seq2).toBeDefined();
    const ackRes = await stack.app.request(`/v1/deliveries/${seq2!.id}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(ackRes.status).toBe(200);

    // The cumulative cursor must NOT have advanced past seq 1: on node reconnect the
    // still-queued seq 1 must replay rather than be skipped forever (only seq 2 is acked).
    await node.handle.handleClose();
    const reconnected = await enrollAndAttachNode(ws, { id: node.id, name: node.name });
    await reconnected.handle.handleMessage(JSON.stringify({
      v: 1,
      type: 'inventory.sync',
      agents: [{ agent_id: bob.agentId, name: 'bob', session_ref: 'sess-bob' }],
    }));
    await new Promise((r) => setTimeout(r, 50));

    expect(reconnected.sock.ofType('deliver').map((event) => event.seq)).toEqual([1]);
  });

  it('excludes expired (unswept) rows from the mailbox depth cap', async () => {
    stack.runtime.deps.config!.mailbox = { deliveryTtlMs: 60_000, depthCap: 1 };

    const ws = await createWorkspace(stack.app, 'mailbox-depthcap-expiry');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);

    const createRes = await stack.app.request('/v1/channels', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.workspaceKey}` },
      body: JSON.stringify({ name: 'team-chat' }),
    });
    expect(createRes.status).toBeLessThan(300);
    for (const token of [alice.token, bob.token]) {
      await stack.app.request('/v1/channels/team-chat/join', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    }

    // Fill bob's mailbox to the cap (1), then let that row's TTL lapse WITHOUT
    // sweeping it (no GET/inbox/replay) so it lingers as an expired queued row.
    const first = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'will expire' }),
    });
    expect(first.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50)); // let the delivery row land
    // Deterministically age bob's queued row past its TTL (no wall-clock race on
    // the second-granular unixepoch boundary) without sweeping it — it lingers as
    // an expired-but-present queued row.
    await stack.runtime.deps.db
      .update(deliveries)
      .set({ expiresAt: new Date(Date.now() - 3_600_000) })
      .where(eq(deliveries.agentId, bob.agentId));

    // A new send must not be rejected as depth_cap: the expired row is not active depth.
    const second = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'fresh' }),
    });
    expect(second.status).toBe(201);
    await new Promise((r) => setTimeout(r, 75));

    expect(contextUpdatesOfType(aliceSock, 'delivery.failed').filter((event) => {
      const data = event.data as Record<string, unknown> | undefined;
      return data?.reason === 'depth_cap';
    })).toHaveLength(0);
    const bobQueued = await listDeliveries(bob.token);
    expect(bobQueued.some((item) => (item.message as { text?: string }).text === 'fresh')).toBe(true);
  });

  it('does not dead-letter an acked delivery after TTL expiry', async () => {
    stack.runtime.deps.config!.mailbox = { deliveryTtlMs: 1, depthCap: 1000 };

    const { ws, alice, bob } = await seed();
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    const [item] = await listDeliveries(bob.token);

    await new Promise((r) => setTimeout(r, 5));
    const ackRes = await stack.app.request('/v1/deliveries/' + item.id + '/ack', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + bob.token },
    });
    expect(ackRes.status).toBe(200);
    const expiredRows = await deliveryEngine.expireDueDeliveries(stack.runtime.deps.db, ws.workspaceId);
    expect(expiredRows).toHaveLength(0);
    expect(await listDeliveries(bob.token, '?status=acked')).toHaveLength(1);
    expect(contextUpdatesOfType(aliceSock, 'delivery.failed')).toHaveLength(0);
  });

  it('expires TTL deliveries to dead-letter and notifies the sender', async () => {
    stack.runtime.deps.config!.mailbox = { deliveryTtlMs: 1000, depthCap: 1000 };

    const { ws, alice, bob } = await seed();
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);

    await new Promise((r) => setTimeout(r, 1100));
    expect(await listDeliveries(bob.token)).toHaveLength(0);
    expect(await sweepExpiredDeliveries(stack.runtime.deps, { workspaceId: ws.workspaceId })).toBe(1);
    expect(await listDeliveries(bob.token, '?status=dead_lettered')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 50));
    await waitForAssertion(() => {
      expect(contextUpdatesOfType(aliceSock, 'delivery.failed').map((event) => event.data)).toEqual(expect.arrayContaining([
        expect.objectContaining({ reason: 'ttl_expired', retryable: false }),
      ]));
    });
  });

  it('scheduled expiry drains a large backlog in D1-safe batches without affecting reads', async () => {
    const { ws, alice, bob, messageId } = await seed();
    const charlie = await registerAgent(stack.app, ws.workspaceKey, 'charlie');
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    const [seedMessage] = await stack.runtime.deps.db
      .select({ channelId: messages.channelId })
      .from(messages)
      .where(eq(messages.id, messageId));
    const bobExpiredAt = new Date(Date.now() - 60_000);
    const charlieExpiredAt = new Date(Date.now() - 120_000);
    const extraCount = 120;
    const charlieCount = 60;

    await stack.runtime.deps.db.insert(messages).values(Array.from({ length: extraCount }, (_, index) => ({
      id: `expiry-message-${index}`,
      workspaceId: ws.workspaceId,
      channelId: seedMessage.channelId,
      agentId: alice.agentId,
      body: `expired ${index}`,
    })));
    await stack.runtime.deps.db.insert(deliveries).values(Array.from({ length: extraCount }, (_, index) => ({
      id: `expiry-delivery-${index}`,
      workspaceId: ws.workspaceId,
      messageId: `expiry-message-${index}`,
      agentId: index < charlieCount ? charlie.agentId : bob.agentId,
      status: 'queued',
      seq: index < charlieCount ? index + 1 : index - charlieCount + 2,
      expiresAt: index < charlieCount ? charlieExpiredAt : bobExpiredAt,
    })));
    await stack.runtime.deps.db
      .update(deliveries)
      .set({ expiresAt: bobExpiredAt })
      .where(eq(deliveries.messageId, messageId));

    const expiryPlan = stack.runtime.handle.sqlite
      .prepare(`EXPLAIN QUERY PLAN
        SELECT id FROM deliveries
        WHERE status IN ('queued', 'delivered')
          AND expires_at IS NOT NULL
          AND expires_at <= ?
        ORDER BY expires_at, id
        LIMIT 50`)
      .all(Math.floor(Date.now() / 1000)) as Array<{ detail: string }>;
    expect(expiryPlan.some((step) => step.detail.includes('idx_deliveries_active_expiry'))).toBe(true);

    // Emulate D1's documented ceiling against the real SQL emitted by Drizzle.
    // The regression used to put all 121 delivery IDs in one UPDATE and trip this guard.
    const sqlite = stack.runtime.handle.sqlite;
    const prepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((source: string) => {
      const parameterCount = (source.match(/\?/g) ?? []).length;
      if (parameterCount > 100) {
        throw new Error(`D1_ERROR: too many SQL variables at offset 100 (${parameterCount})`);
      }
      return prepare(source);
    }) as typeof sqlite.prepare;

    const deadLetteredCount = async () => (await stack.runtime.deps.db
      .select({ id: deliveries.id })
      .from(deliveries)
      .where(eq(deliveries.status, 'dead_lettered'))).length;

    const inbox = await stack.app.request('/v1/inbox', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(inbox.status).toBe(200);
    expect(await listDeliveries(bob.token)).toHaveLength(0);
    // Reads filter expired active rows but do not mutate them or depend on cleanup.
    expect(await deadLetteredCount()).toBe(0);

    expect(await sweepExpiredDeliveries(stack.runtime.deps)).toBe(50);
    expect(await deadLetteredCount()).toBe(50);

    expect(await sweepExpiredDeliveries(stack.runtime.deps)).toBe(50);
    // Charlie's remaining 10 rows and Bob's oldest 40 transitioned. Bob's 21
    // still-unswept expired rows must not leak through the active list.
    expect(await listDeliveries(bob.token)).toHaveLength(0);
    expect(await deadLetteredCount()).toBe(100);

    expect(await sweepExpiredDeliveries(stack.runtime.deps)).toBe(21);
    expect(await deadLetteredCount()).toBe(121);

    await waitForAssertion(() => {
      const notices = contextUpdatesOfType(aliceSock, 'delivery.failed')
        .filter((event) => event.data && (event.data as Record<string, unknown>).reason === 'ttl_expired');
      expect(notices).toHaveLength(121);
      expect(new Set(notices.map((event) => (event.data as Record<string, unknown>).delivery_id)).size).toBe(121);
    });

    expect(await sweepExpiredDeliveries(stack.runtime.deps)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(contextUpdatesOfType(aliceSock, 'delivery.failed')
      .filter((event) => event.data && (event.data as Record<string, unknown>).reason === 'ttl_expired')).toHaveLength(121);
  });

  it('keeps inbox and delivery reads available when scheduled expiry fails', async () => {
    const { ws, bob, messageId } = await seed();
    await stack.runtime.deps.db
      .update(deliveries)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(deliveries.messageId, messageId));

    const sqlite = stack.runtime.handle.sqlite;
    const prepare = sqlite.prepare.bind(sqlite);
    sqlite.prepare = ((source: string) => {
      if (source.startsWith('update "deliveries"') && source.includes('"dead_lettered_at"')) {
        throw new Error('simulated scheduled expiry failure');
      }
      return prepare(source);
    }) as typeof sqlite.prepare;

    await expect(sweepExpiredDeliveries(stack.runtime.deps, { workspaceId: ws.workspaceId }))
      .rejects.toThrow('simulated scheduled expiry failure');

    const inbox = await stack.app.request('/v1/inbox', {
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(inbox.status).toBe(200);
    expect(await listDeliveries(bob.token)).toHaveLength(0);
    const [stored] = await stack.runtime.deps.db
      .select({ status: deliveries.status })
      .from(deliveries)
      .where(eq(deliveries.messageId, messageId));
    expect(stored.status).toBe('queued');
  });

  it('rejects new deliveries over the depth cap and sends feedback to the sender', async () => {
    stack.runtime.deps.config!.mailbox = { deliveryTtlMs: 60_000, depthCap: 1 };

    const { ws, alice, bob } = await seed();
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);

    const second = await stack.app.request('/v1/channels/team-chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ text: 'overflow' }),
    });
    expect(second.status).toBe(201);
    const secondMessageId = ((await second.json()) as { data: { id: string } }).data.id;
    await new Promise((r) => setTimeout(r, 75));

    expect(await listDeliveries(bob.token)).toHaveLength(1);
    await waitForAssertion(() => {
      expect(contextUpdatesOfType(aliceSock, 'delivery.failed').map((event) => event.data)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          delivery_id: null,
          message_id: secondMessageId,
          target_agent_name: 'bob',
          reason: 'depth_cap',
          retryable: false,
        }),
      ]));
    });
  });
});
