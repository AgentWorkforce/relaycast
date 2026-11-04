import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachDirectNodeSocket,
  contextUpdatesOfType,
  createWorkspace,
  D1_MAX_BOUND_PARAMETERS,
  deliverFramesOfType,
  enforceD1ParameterLimit,
  FakeSocket,
  makeNodeStack,
  registerAgent,
  type TestStack,
} from './harness.js';
import { fetchDeliveryFanoutRecords } from '../../engine/deliveryWrites.js';
import { notifySenderDeliveryReceipts } from '../../engine/deliveryReceipts.js';
import { buildIdempotencyStorageKey } from '../../middleware/idempotency.js';
import { routeDeliveryOutcomes } from '../../routes/deliveryRouting.js';

type DeliveryReceipt = {
  id: string;
  agent_id: string;
  agent_name: string;
  status: string;
  state: string;
  created_at: string;
  delivered_at: string | null;
  accepted_at: string | null;
  acked_at: string | null;
  replied_at: string | null;
  reply_message_id: string | null;
  dead_lettered_at: string | null;
  error: string | null;
  read_at: string | null;
};

/**
 * Sender-side delivery receipts: the send response names the delivery rows it
 * created, the sender is told when each row is delivered and acked, and
 * `GET /v1/messages/:id/deliveries` reports every recipient's state.
 */
describe('sender-side delivery receipts', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  const authed = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

  async function sendDm(token: string, to: string, text: string) {
    const res = await stack.app.request('/v1/dm', authed(token, { method: 'POST', body: JSON.stringify({ to, text }) }));
    expect(res.status).toBe(201);
    return ((await res.json()) as {
      data: { id: string; delivery: { id: string; status: string; expires_at: string | null } | null };
    }).data;
  }

  async function messageDeliveries(token: string, messageId: string) {
    const res = await stack.app.request(`/v1/messages/${messageId}/deliveries`, authed(token));
    const body = (await res.json()) as {
      ok: boolean;
      data?: { message_id: string; deliveries: DeliveryReceipt[] };
      error?: { code: string };
    };
    return { status: res.status, body };
  }

  async function enrollBrokerNode(ws: { workspaceKey: string; workspaceId: string }, id = 'node_receipts') {
    const create = await stack.app.request('/v1/nodes', authed(ws.workspaceKey, {
      method: 'POST',
      body: JSON.stringify({ node_id: id, name: id, capabilities: ['spawn:claude'], max_agents: 4, tags: ['test'], version: 'v0' }),
    }));
    expect(create.status).toBe(201);
    const token = ((await create.json()) as { data: { token: string } }).data.token;
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, id, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name: id, node_id: id,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: ['test'], version: 'v0', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true }));
    return { id, token, sock, handle };
  }

  async function registerViaNode(node: { sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void> } }, name: string) {
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.register', name, resumable: true }));
    const reply = node.sock.ofType('reply').at(-1) as { ok: boolean; data: { agent_id: string; token: string } };
    expect(reply?.ok).toBe(true);
    return { agentId: reply.data.agent_id, token: reply.data.token, name };
  }

  /** Insert `count` online members of #general straight into SQLite (no per-agent HTTP round trips). */
  function seedGeneralMembers(workspaceId: string, count: number, prefix: string): string[] {
    const sqlite = stack.runtime.handle.sqlite;
    const { id: channelId } = sqlite.prepare(
      `SELECT id FROM channels WHERE workspace_id = ? AND name = 'general'`,
    ).get(workspaceId) as { id: string };
    const insertAgent = sqlite.prepare(`
      INSERT INTO agents (id, workspace_id, name, token_hash, status)
      VALUES (?, ?, ?, ?, 'online')
    `);
    const insertMember = sqlite.prepare(`
      INSERT INTO channel_members (channel_id, agent_id) VALUES (?, ?)
    `);
    const ids: string[] = [];
    sqlite.transaction(() => {
      for (let index = 0; index < count; index += 1) {
        const id = `agent_${prefix}_${String(index).padStart(3, '0')}`;
        ids.push(id);
        insertAgent.run(id, workspaceId, `${prefix}-${index}`, `token-${prefix}-${index}`);
        insertMember.run(channelId, id);
      }
    })();
    return ids;
  }

  it('tells the DM sender when its delivery is queued, delivered, then acked, and lists the receipts', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-dm');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const sent = await sendDm(alice.token, 'bob', 'did you get this?');
    expect(sent.delivery).toEqual({ id: expect.any(String), status: 'queued', state: 'queued', accepted_at: null, replied_at: null, reply_message_id: null, error: null, expires_at: expect.any(String) });
    expect(sent.delivery).not.toHaveProperty('agent_id');
    const deliveryId = sent.delivery!.id;

    await stack.settle();
    expect(deliverFramesOfType(bobSock, 'dm.received')).toHaveLength(1);

    // queued -> delivered: the sender hears it on the workspace stream and on
    // its own node; the recipient hears nothing yet.
    const delivered = { delivery_id: deliveryId, message_id: sent.id, agent_id: bob.agentId, agent_name: 'bob', status: 'delivered', at: expect.any(String) };
    expect(stream.ofType('delivery.delivered')).toEqual([expect.objectContaining(delivered)]);
    expect(contextUpdatesOfType(aliceSock, 'delivery.delivered').map((frame) => frame.data)).toEqual([expect.objectContaining(delivered)]);
    expect(contextUpdatesOfType(bobSock, 'delivery.delivered')).toHaveLength(0);

    let receipts = await messageDeliveries(alice.token, sent.id);
    expect(receipts.status).toBe(200);
    expect(receipts.body.data).toEqual({
      message_id: sent.id,
      deliveries: [{
        id: deliveryId, agent_id: bob.agentId, agent_name: 'bob', status: 'delivered', state: 'queued',
        created_at: expect.any(String), delivered_at: expect.any(String), accepted_at: null, acked_at: null,
        replied_at: null, reply_message_id: null, dead_lettered_at: null, error: null, read_at: null,
      }],
    });

    // delivered -> acked: the recipient keeps its compat `delivery.delivered`;
    // the sender gets `delivery.acked`. A repeated ack re-emits nothing.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const ack = await stack.app.request(`/v1/deliveries/${deliveryId}/ack`, authed(bob.token, { method: 'POST' }));
      expect(ack.status).toBe(200);
    }
    await stack.settle();
    const acked = { delivery_id: deliveryId, message_id: sent.id, agent_id: bob.agentId, agent_name: 'bob', status: 'acked', at: expect.any(String) };
    expect(stream.ofType('delivery.acked')).toEqual([expect.objectContaining(acked)]);
    expect(contextUpdatesOfType(aliceSock, 'delivery.acked').map((frame) => frame.data)).toEqual([expect.objectContaining(acked)]);
    expect(contextUpdatesOfType(bobSock, 'delivery.delivered')).toHaveLength(1);
    expect(contextUpdatesOfType(bobSock, 'delivery.acked')).toHaveLength(0);
    // The stream carries both audiences: the one sender-side `delivered`
    // (with `status`) and the recipient's compat `{ delivery_id, message_id }`.
    const streamed = stream.ofType('delivery.delivered');
    expect(streamed.filter((event) => event.status === 'delivered')).toHaveLength(1);
    expect(streamed.filter((event) => !('status' in event))).toEqual([
      expect.objectContaining({ delivery_id: deliveryId, message_id: sent.id }),
    ]);
    expect(streamed).toHaveLength(2);

    // Acking consumes the message, so the ack also records the read.
    receipts = await messageDeliveries(alice.token, sent.id);
    expect(receipts.body.data!.deliveries).toEqual([expect.objectContaining({
      status: 'acked', delivered_at: expect.any(String), acked_at: expect.any(String), read_at: expect.any(String),
    })]);
  });

  it('carries the same delivery on an idempotent replay, whether KV or the durable claim answers it', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-dm-replay');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    for (const replayPath of ['kv', 'durable'] as const) {
      const key = `receipt-replay-${replayPath}`;
      const send = () => stack.app.request('/v1/dm', authed(alice.token, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ to: 'bob', text: `replayed from ${replayPath}` }),
      }));
      const first = await send();
      expect(first.status).toBe(201);
      const original = (await first.json()) as {
        data: { id: string; delivery: { id: string; status: string; expires_at: string | null } | null };
      };
      expect(original.data.delivery).toEqual({ id: expect.any(String), status: 'queued', state: 'queued', accepted_at: null, replied_at: null, reply_message_id: null, error: null, expires_at: expect.any(String) });
      await stack.settle();

      // Lose the KV record and its lock (an eviction or outage after the
      // commit): the replay must then come from the durable direct-DM claim,
      // which carries the receipt the admission batch stamped onto it.
      const evictKv = async () => {
        const stored = await buildIdempotencyStorageKey(ws.workspaceId, alice.agentId, 'dm:direct', key);
        await Promise.all([stack.runtime.deps.kv.delete(stored), stack.runtime.deps.kv.delete(`${stored}:lock`)]);
      };
      if (replayPath === 'durable') await evictKv();
      const replay = await send();
      expect(replay.status).toBe(201);
      expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
      expect(await replay.json()).toEqual(original);
      await stack.settle();

      // The replayed handle is the one row the send created, not a second one.
      const receipts = await messageDeliveries(alice.token, original.data.id);
      expect(receipts.body.data!.deliveries).toEqual([
        expect.objectContaining({ id: original.data.delivery!.id, agent_id: bob.agentId, status: 'queued' }),
      ]);

      if (replayPath === 'durable') {
        // The stamped receipt outlives the row: once the delivery is settled and
        // pruned, the durable replay still repeats the original handle.
        stack.runtime.handle.sqlite.prepare('DELETE FROM deliveries WHERE id = ?').run(original.data.delivery!.id);
        await evictKv();
        const afterPrune = await send();
        expect(afterPrune.status).toBe(201);
        expect(afterPrune.headers.get('Idempotency-Replayed')).toBe('true');
        expect(await afterPrune.json()).toEqual(original);
      }
    }
  });

  it('reports read_at once the recipient marks the message read', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-read');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const sent = await sendDm(alice.token, 'bob', 'read me');
    let receipts = await messageDeliveries(alice.token, sent.id);
    expect(receipts.body.data!.deliveries).toEqual([expect.objectContaining({ status: 'queued', read_at: null })]);

    const read = await stack.app.request(`/v1/messages/${sent.id}/read`, authed(bob.token, { method: 'POST' }));
    expect(read.status).toBe(200);
    const readAt = ((await read.json()) as { data: { read_at: string } }).data.read_at;

    receipts = await messageDeliveries(alice.token, sent.id);
    expect(receipts.body.data!.deliveries).toEqual([expect.objectContaining({ status: 'acked', read_at: readAt })]);
  });

  it('shows the receipts only to the sender, a workspace key, or an admitted observer', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-auth');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const carol = await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const sent = await sendDm(alice.token, 'bob', 'private');

    for (const token of [bob.token, carol.token]) {
      const denied = await messageDeliveries(token, sent.id);
      expect(denied.status).toBe(404);
      expect(denied.body.error?.code).toBe('message_not_found');
    }
    expect((await messageDeliveries(alice.token, 'msg_does_not_exist')).status).toBe(404);

    const byKey = await messageDeliveries(ws.workspaceKey, sent.id);
    expect(byKey.status).toBe(200);
    expect(byKey.body.data!.deliveries).toEqual([expect.objectContaining({ agent_name: 'bob' })]);

    const node = await enrollBrokerNode(ws);
    const byNode = await messageDeliveries(node.token, sent.id);
    expect(byNode.status).toBe(401);
    expect(byNode.body.error?.code).toBe('node_token_forbidden');

    let minted = 0;
    const mint = async (scopes: string[], filters?: Record<string, unknown>) => {
      minted += 1;
      const res = await stack.app.request('/v1/observer-tokens', authed(ws.workspaceKey, {
        method: 'POST', body: JSON.stringify({ name: `obs-${minted}`, scopes, ...(filters ? { filters } : {}) }),
      }));
      expect(res.status).toBe(201);
      return ((await res.json()) as { data: { token: string } }).data.token;
    };
    // A DM needs `dms:read` plus `include_dms`; a `messages:read`-only
    // observer, like `GET /v1/messages/:id`, cannot see it.
    expect((await messageDeliveries(await mint(['dms:read'], { include_dms: true }), sent.id)).status).toBe(200);
    expect((await messageDeliveries(await mint(['dms:read'], { include_dms: false }), sent.id)).status).toBe(404);
    expect((await messageDeliveries(await mint(['messages:read']), sent.id)).status).toBe(404);
    expect((await messageDeliveries(await mint(['stream:read']), sent.id)).status).toBe(403);
  });

  it('names every recipient delivery in a channel post response, capped at 50', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-channel');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const small = await stack.app.request('/v1/channels/general/messages', authed(alice.token, {
      method: 'POST', body: JSON.stringify({ text: 'hello all' }),
    }));
    expect(small.status).toBe(201);
    const smallBody = ((await small.json()) as {
      data: { id: string; deliveries: Array<Record<string, unknown>>; deliveries_truncated: boolean };
    }).data;
    expect(smallBody.deliveries).toEqual([
      { id: expect.any(String), agent_id: bob.agentId, status: 'queued', state: 'queued', accepted_at: null, replied_at: null, reply_message_id: null, error: null, expires_at: expect.any(String) },
    ]);
    expect(smallBody.deliveries_truncated).toBe(false);

    seedGeneralMembers(ws.workspaceId, 60, 'crowd');
    const large = await stack.app.request('/v1/channels/general/messages', authed(alice.token, {
      method: 'POST', body: JSON.stringify({ text: 'hello crowd' }),
    }));
    expect(large.status).toBe(201);
    const largeBody = ((await large.json()) as {
      data: { id: string; deliveries: Array<{ agent_id: string }>; deliveries_truncated: boolean };
    }).data;
    expect(largeBody.deliveries).toHaveLength(50);
    expect(largeBody.deliveries_truncated).toBe(true);
    expect(largeBody.deliveries.map((d) => d.agent_id)).not.toContain(alice.agentId);

    // The full list is still one read away for the sender.
    const receipts = await messageDeliveries(alice.token, largeBody.id);
    expect(receipts.body.data!.deliveries).toHaveLength(61);
  });

  it('lists a wide fanout under the D1 bound-parameter cap', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-d1');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    seedGeneralMembers(ws.workspaceId, 150, 'bulk');

    const post = await stack.app.request('/v1/channels/general/messages', authed(alice.token, {
      method: 'POST', body: JSON.stringify({ text: 'wide fanout' }),
    }));
    expect(post.status).toBe(201);
    const messageId = ((await post.json()) as { data: { id: string } }).data.id;
    await stack.settle();

    const guard = enforceD1ParameterLimit(stack);
    try {
      const receipts = await messageDeliveries(alice.token, messageId);
      expect(receipts.status).toBe(200);
      expect(receipts.body.data!.deliveries).toHaveLength(150);
      expect(guard.maxObserved()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    } finally {
      guard.restore();
    }
  });

  it('tells the sender when a node delivers and cumulatively acks a channel message', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-node-ack');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws);
    const bob = await registerViaNode(node, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const post = await stack.app.request('/v1/channels/general/messages', authed(alice.token, {
      method: 'POST', body: JSON.stringify({ text: 'node hello' }),
    }));
    expect(post.status).toBe(201);
    const posted = ((await post.json()) as { data: { id: string; deliveries: Array<{ id: string }> } }).data;
    await stack.settle();
    expect(node.sock.ofType('deliver')).toHaveLength(1);
    expect(stream.ofType('delivery.delivered')).toEqual([expect.objectContaining({
      delivery_id: posted.deliveries[0]!.id, message_id: posted.id, agent_id: bob.agentId, agent_name: 'bob', status: 'delivered',
    })]);

    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    expect(stream.ofType('delivery.acked')).toEqual([expect.objectContaining({
      delivery_id: posted.deliveries[0]!.id, message_id: posted.id, agent_id: bob.agentId, agent_name: 'bob', status: 'acked', at: expect.any(String),
    })]);

    // A repeated cumulative ack settles nothing and tells the sender nothing.
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    expect(stream.ofType('delivery.acked')).toHaveLength(1);

    const receipts = await messageDeliveries(alice.token, posted.id);
    expect(receipts.body.data!.deliveries).toEqual([expect.objectContaining({
      agent_name: 'bob', status: 'acked', delivered_at: expect.any(String), acked_at: expect.any(String),
    })]);
  });

  it('does not re-report delivered to the sender when a live route resends a row another path already settled', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-stale-delivered');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws, 'node_stale');
    const bob = await registerViaNode(node, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const post = await stack.app.request('/v1/channels/general/messages', authed(alice.token, {
      method: 'POST', body: JSON.stringify({ text: 'race me' }),
    }));
    expect(post.status).toBe(201);
    const posted = ((await post.json()) as { data: { id: string; deliveries: Array<{ id: string }> } }).data;
    await stack.settle();
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    expect(stream.ofType('delivery.delivered')).toHaveLength(1);
    expect(stream.ofType('delivery.acked')).toHaveLength(1);

    // A concurrent live route (or sweep) that sends the same row after it was
    // settled elsewhere must not tell the sender `delivered` again, which would
    // land after `acked` and roll the sender's view back.
    const records = await fetchDeliveryFanoutRecords(stack.runtime.deps.db, posted.id);
    expect(records).toHaveLength(1);
    const ctx = {
      get(key: string) {
        if (key === 'workspace') return { id: ws.workspaceId };
        if (key === 'db') return stack.runtime.deps.db;
        if (key === 'engine') return stack.runtime.deps;
        return undefined;
      },
    } as unknown as Parameters<typeof routeDeliveryOutcomes>[0];
    await routeDeliveryOutcomes(ctx, records, 'message.created', { id: posted.id, channel_name: 'general', from_name: 'alice' });
    await stack.settle();
    expect(node.sock.ofType('deliver')).toHaveLength(2);
    expect(stream.ofType('delivery.delivered')).toHaveLength(1);
    expect(stream.ofType('delivery.acked')).toHaveLength(1);

    const receipts = await messageDeliveries(alice.token, posted.id);
    expect(receipts.body.data!.deliveries).toEqual([expect.objectContaining({ agent_name: 'bob', status: 'acked' })]);
  });

  it('keeps a cumulative ack wider than one IN-list chunk under the D1 cap while notifying the sender', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-bulk-ack');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws, 'node_bulk_ack');
    const bob = await registerViaNode(node, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const count = 120;
    const sqlite = stack.runtime.handle.sqlite;
    const { id: channelId } = sqlite.prepare(
      `SELECT id FROM channels WHERE workspace_id = ? AND name = 'general'`,
    ).get(ws.workspaceId) as { id: string };
    const insertMessage = sqlite.prepare(`INSERT INTO messages (id, workspace_id, channel_id, agent_id, body) VALUES (?, ?, ?, ?, ?)`);
    const insertDelivery = sqlite.prepare(`
      INSERT INTO deliveries (id, workspace_id, message_id, agent_id, status, seq, location_type, location_node_id)
      VALUES (?, ?, ?, ?, 'delivered', ?, 'via_node', ?)
    `);
    sqlite.transaction(() => {
      for (let seq = 1; seq <= count; seq += 1) {
        const messageId = `msg_bulk_${String(seq).padStart(3, '0')}`;
        insertMessage.run(messageId, ws.workspaceId, channelId, alice.agentId, `bulk ${seq}`);
        insertDelivery.run(`del_bulk_${seq}`, ws.workspaceId, messageId, bob.agentId, seq, node.id);
      }
      sqlite.prepare('UPDATE agents SET delivery_seq = ? WHERE id = ?').run(count, bob.agentId);
    })();

    const guard = enforceD1ParameterLimit(stack);
    try {
      await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: count }));
      await stack.settle();
      expect(guard.maxObserved()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
    } finally {
      guard.restore();
    }
    const acked = stream.ofType('delivery.acked');
    expect(acked).toHaveLength(count);
    expect(new Set(acked.map((event) => event.delivery_id)).size).toBe(count);
  });

  it('drops a late delivered receipt for a row the recipient acked before the routing batch was reported', async () => {
    const ws = await createWorkspace(stack.app, 'receipts-late-delivered');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws, 'node_late_delivered');
    const bob = await registerViaNode(node, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const post = await stack.app.request('/v1/channels/general/messages', authed(alice.token, {
      method: 'POST', body: JSON.stringify({ text: 'ack fast' }),
    }));
    expect(post.status).toBe(201);
    const posted = ((await post.json()) as { data: { id: string; deliveries: Array<{ id: string }> } }).data;
    await stack.settle();
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    expect(stream.ofType('delivery.delivered')).toHaveLength(1);
    expect(stream.ofType('delivery.acked')).toHaveLength(1);

    // A routing pass reports the rows it moved `queued` -> `delivered` only
    // after every recipient in the batch settles (an `http_push` sibling can
    // hold that for seconds). If the recipient acked meanwhile, the batch must
    // not tell the sender `delivered` after it already heard `acked`.
    await notifySenderDeliveryReceipts(
      { db: stack.runtime.deps.db, engine: stack.runtime.deps },
      ws.workspaceId,
      [posted.deliveries[0]!.id],
      'delivered',
    );
    await stack.settle();
    expect(stream.ofType('delivery.delivered')).toHaveLength(1);
    expect(stream.ofType('delivery.acked')).toHaveLength(1);
  });
});
