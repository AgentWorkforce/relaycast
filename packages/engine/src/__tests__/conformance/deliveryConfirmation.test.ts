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
import { DELIVERY_REPLY_MARK_MAX } from '../../engine/delivery.js';
import { createEngine } from '../../engine.js';

type SentDelivery = {
  id: string;
  agent_id?: string;
  status: string;
  state: string;
  accepted_at: string | null;
  error: string | null;
  expires_at: string | null;
};

type Receipt = Record<string, unknown> & { id: string; state: string };

/**
 * Trustworthy, bounded delivery confirmation: the receiving software's
 * `delivery.accepted` frame is the authoritative `delivered`, `delivery.ack`
 * is `consumed`, a DM back is `replied`, and a send may park a short budget
 * (`wait_ms`) for the acceptance before answering with the row's state.
 */
describe('delivery confirmation', () => {
  let stack: TestStack;
  beforeEach(() => { stack = makeNodeStack({ ttlMs: 60_000 }); });
  afterEach(() => stack.close());

  const authed = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });

  async function sendDm(token: string, body: Record<string, unknown>, query = '') {
    const res = await stack.app.request(`/v1/dm${query}`, authed(token, { method: 'POST', body: JSON.stringify(body) }));
    const json = (await res.json()) as { data: { id: string; conversation_id: string; delivery: SentDelivery | null }; error?: { code: string; message: string } };
    return { status: res.status, data: json.data, error: json.error, replayed: res.headers.get('Idempotency-Replayed') };
  }

  async function receipts(token: string, messageId: string): Promise<Receipt[]> {
    const res = await stack.app.request(`/v1/messages/${messageId}/deliveries`, authed(token));
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { deliveries: Receipt[] } }).data.deliveries;
  }

  async function enrollBrokerNode(ws: { workspaceKey: string; workspaceId: string }, id = 'node_confirm') {
    const create = await stack.app.request('/v1/nodes', authed(ws.workspaceKey, {
      method: 'POST',
      body: JSON.stringify({ node_id: id, name: id, capabilities: ['spawn:claude'], max_agents: 4, tags: ['test'], version: 'v0' }),
    }));
    expect(create.status).toBe(201);
    const sock = new FakeSocket();
    const handle = stack.runtime.realtime.attachNodeSocket(ws.workspaceId, id, sock);
    await handle.handleMessage(JSON.stringify({
      v: 1, type: 'node.register', name: id, node_id: id,
      capabilities: [{ name: 'spawn:claude', kind: 'capacity' }],
      max_agents: 4, tags: ['test'], version: 'v0', resume_cursor: null,
    }));
    await handle.handleMessage(JSON.stringify({ v: 1, type: 'node.heartbeat', load: 0, active_agents: 0, handlers_live: true }));
    return { id, sock, handle };
  }

  async function registerViaNode(node: { sock: FakeSocket; handle: { handleMessage(raw: string): Promise<void> } }, name: string) {
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'agent.register', name, resumable: true }));
    const reply = node.sock.ofType('reply').at(-1) as { ok: boolean; data: { agent_id: string; token: string } };
    expect(reply?.ok).toBe(true);
    return { agentId: reply.data.agent_id, token: reply.data.token, name };
  }

  /** Poll (bounded) until `count` deliver frames of `type` reached `sock`. */
  async function untilDelivered(sock: FakeSocket, type: string, count = 1): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const frames = deliverFramesOfType(sock, type);
      if (frames.length >= count) return frames;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`no ${type} deliver frame reached the socket`);
  }

  it('treats the receiver acceptance frame as the authoritative delivered, then ack as consumed', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-accept');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    const { sock: bobSock, handle: bobHandle } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const sent = await sendDm(alice.token, { to: 'bob', text: 'confirm me' });
    expect(sent.status).toBe(201);
    expect(sent.data.delivery).toEqual({ id: expect.any(String), status: 'queued', state: 'queued', accepted_at: null, error: null, expires_at: expect.any(String) });
    const deliveryId = sent.data.delivery!.id;
    await stack.settle();
    const [frame] = deliverFramesOfType(bobSock, 'dm.received');
    expect(frame).toMatchObject({ delivery_id: deliveryId, seq: 1 });

    // The host's socket write: delivered, but not accepted.
    expect(stream.ofType('delivery.delivered')).toEqual([expect.objectContaining({ delivery_id: deliveryId, status: 'delivered', accepted: false })]);
    expect((await receipts(alice.token, sent.data.id))[0]).toMatchObject({ status: 'delivered', state: 'delivered', accepted_at: null });

    // The receiving software holds it: the authoritative delivered (accepted: true).
    await bobHandle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    const accepted = { delivery_id: deliveryId, message_id: sent.data.id, agent_id: bob.agentId, agent_name: 'bob', status: 'delivered', accepted: true, at: expect.any(String) };
    expect(stream.ofType('delivery.delivered')).toEqual([expect.objectContaining({ accepted: false }), expect.objectContaining(accepted)]);
    expect(contextUpdatesOfType(aliceSock, 'delivery.delivered').map((f) => f.data)).toEqual([expect.objectContaining({ accepted: false }), expect.objectContaining(accepted)]);
    let [receipt] = await receipts(alice.token, sent.data.id);
    expect(receipt).toMatchObject({ status: 'delivered', state: 'delivered', delivered_at: expect.any(String), accepted_at: expect.any(String), acked_at: null, replied_at: null, reply_message_id: null });

    // Repeating the acceptance changes and reports nothing.
    await bobHandle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', delivery_id: deliveryId }));
    await stack.settle();
    expect(stream.ofType('delivery.delivered')).toHaveLength(2);

    // Consumed: the recipient's ack after acceptance.
    await bobHandle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    expect(stream.ofType('delivery.acked')).toEqual([expect.objectContaining({ delivery_id: deliveryId, status: 'acked' })]);
    [receipt] = await receipts(alice.token, sent.data.id);
    expect(receipt).toMatchObject({ status: 'acked', state: 'consumed', accepted_at: expect.any(String), acked_at: expect.any(String) });
    // A late acceptance for a consumed row is a no-op.
    await bobHandle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    expect(stream.ofType('delivery.delivered')).toHaveLength(2);
  });

  it('accepts a single row by delivery_id, and a frame for an unhosted agent or an unknown row changes nothing', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-single');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws);
    const bob = await registerViaNode(node, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const first = await sendDm(alice.token, { to: 'bob', text: 'one' });
    const second = await sendDm(alice.token, { to: 'bob', text: 'two' });
    await stack.settle();
    expect(node.sock.ofType('deliver')).toHaveLength(2);

    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', delivery_id: second.data.delivery!.id }));
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'carol', up_to_seq: 2 }));
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', delivery_id: 'del_missing' }));
    await stack.settle();
    expect(stream.ofType('delivery.delivered').filter((event) => event.accepted === true)).toEqual([
      expect.objectContaining({ delivery_id: second.data.delivery!.id, agent_id: bob.agentId }),
    ]);
    expect((await receipts(alice.token, first.data.id))[0]).toMatchObject({ state: 'delivered', accepted_at: null });
    expect((await receipts(alice.token, second.data.id))[0]).toMatchObject({ state: 'delivered', accepted_at: expect.any(String) });
    expect(node.sock.ofType('error')).toHaveLength(0);
  });

  it('marks a DM replied when the recipient answers, naming the reply', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const question = await sendDm(alice.token, { to: 'bob', text: 'free at 3?' });
    const followUp = await sendDm(alice.token, { to: 'bob', text: 'or 4?' });
    await stack.settle();

    const answer = await sendDm(bob.token, { to: 'alice', text: 'yes, 3' });
    expect(answer.status).toBe(201);
    await stack.settle();

    const replied = (deliveryId: string, messageId: string) => expect.objectContaining({
      delivery_id: deliveryId, message_id: messageId, agent_id: bob.agentId, agent_name: 'bob',
      status: 'replied', reply_message_id: answer.data.id, at: expect.any(String),
    });
    const expected = [replied(followUp.data.delivery!.id, followUp.data.id), replied(question.data.delivery!.id, question.data.id)];
    expect(stream.ofType('delivery.replied')).toHaveLength(2);
    expect(stream.ofType('delivery.replied')).toEqual(expect.arrayContaining(expected));
    expect(contextUpdatesOfType(aliceSock, 'delivery.replied').map((f) => f.data)).toEqual(expect.arrayContaining(expected));
    expect((await receipts(alice.token, question.data.id))[0]).toMatchObject({
      status: 'queued', state: 'replied', replied_at: expect.any(String), reply_message_id: answer.data.id,
    });
    // Bob's reply to alice (host-delivered to her socket) is itself unanswered;
    // alice's later DM answers it, and only it.
    expect((await receipts(bob.token, answer.data.id))[0]).toMatchObject({ state: 'delivered', accepted_at: null, replied_at: null });
    const thanks = await sendDm(alice.token, { to: 'bob', text: 'great' });
    await stack.settle();
    expect(stream.ofType('delivery.replied')).toHaveLength(3);
    expect((await receipts(bob.token, answer.data.id))[0]).toMatchObject({ state: 'replied', reply_message_id: thanks.data.id });
    expect((await receipts(alice.token, thanks.data.id))[0]).toMatchObject({ state: 'queued', replied_at: null });
  });

  it('keeps reply marking under the D1 bound-parameter cap across a wide unanswered backlog', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-d1');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const opener = await sendDm(bob.token, { to: 'alice', text: 'opener' });
    await stack.settle();

    const sqlite = stack.runtime.handle.sqlite;
    const { channel_id: channelId } = sqlite.prepare('SELECT channel_id FROM dm_conversations WHERE id = ?').get(opener.data.conversation_id) as { channel_id: string };
    const insertMessage = sqlite.prepare('INSERT INTO messages (id, workspace_id, channel_id, agent_id, body) VALUES (?, ?, ?, ?, ?)');
    const insertDelivery = sqlite.prepare(`
      INSERT INTO deliveries (id, workspace_id, message_id, agent_id, status, seq, location_type)
      VALUES (?, ?, ?, ?, 'delivered', ?, 'self_connected')
    `);
    const count = 150;
    sqlite.transaction(() => {
      for (let seq = 2; seq <= count + 1; seq += 1) {
        const messageId = `msg_bulk_${String(seq).padStart(3, '0')}`;
        insertMessage.run(messageId, ws.workspaceId, channelId, bob.agentId, `bulk ${seq}`);
        insertDelivery.run(`del_bulk_${seq}`, ws.workspaceId, messageId, alice.agentId, seq);
      }
      sqlite.prepare('UPDATE agents SET delivery_seq = ? WHERE id = ?').run(count + 1, alice.agentId);
    })();
    expect(count + 1).toBeLessThanOrEqual(DELIVERY_REPLY_MARK_MAX);

    const guard = enforceD1ParameterLimit(stack);
    try {
      const reply = await sendDm(alice.token, { to: 'bob', text: 'answering everything' });
      expect(reply.status).toBe(201);
      await stack.settle();
      expect(guard.maxObserved()).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
      const marked = sqlite.prepare('SELECT count(*) AS n FROM deliveries WHERE agent_id = ? AND replied_at IS NOT NULL AND reply_message_id = ?')
        .get(alice.agentId, reply.data.id) as { n: number };
      expect(marked.n).toBe(count + 1);
    } finally {
      guard.restore();
    }
  });

  it('answers a DM send with delivered once the receiver accepts within the wait budget', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-wait-hit');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: bobSock, handle: bobHandle } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

    const started = Date.now();
    const sending = sendDm(alice.token, { to: 'bob', text: 'are you there?', wait_ms: 1000 });
    const [frame] = await untilDelivered(bobSock, 'dm.received');
    await bobHandle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', delivery_id: frame.delivery_id, up_to_seq: frame.seq }));
    const sent = await sending;
    const elapsed = Date.now() - started;

    expect(sent.status).toBe(201);
    expect(sent.data.delivery).toEqual({
      id: frame.delivery_id, status: 'delivered', state: 'delivered', accepted_at: expect.any(String), error: null, expires_at: expect.any(String),
    });
    expect(elapsed).toBeLessThan(1000);
    await stack.settle();
  });

  it('answers a DM send after the budget with the row as it stands when the receiver never accepts', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-wait-miss');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const carol = await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

    // A live socket that only takes the frame: host-delivered, never accepted.
    let started = Date.now();
    const toBob = await sendDm(alice.token, { to: 'bob', text: 'silent receiver', wait_ms: 300 });
    let elapsed = Date.now() - started;
    expect(toBob.status).toBe(201);
    expect(deliverFramesOfType(bobSock, 'dm.received')).toHaveLength(1);
    expect(toBob.data.delivery).toMatchObject({ status: 'delivered', state: 'delivered', accepted_at: null });
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(1000);

    // No socket at all: still queued; delivery continues after the answer.
    started = Date.now();
    const toCarol = await sendDm(alice.token, { to: 'carol', text: 'nobody home', wait_ms: 300 }, '?wait_ms=2000');
    elapsed = Date.now() - started;
    expect(toCarol.data.delivery).toMatchObject({ status: 'queued', state: 'queued', accepted_at: null });
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(1000);
    expect((await receipts(alice.token, toCarol.data.id))[0]).toMatchObject({ agent_id: carol.agentId, state: 'queued' });

    // The query form works alone, and an over-budget or blank value is refused.
    started = Date.now();
    const viaQuery = await sendDm(alice.token, { to: 'carol', text: 'query budget' }, '?wait_ms=200');
    expect(viaQuery.status).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(190);
    for (const bad of [{ body: { wait_ms: 2001 } }, { body: { wait_ms: -1 } }, { body: { wait_ms: 1.5 } }, { query: '?wait_ms=' }, { query: '?wait_ms=5000' }]) {
      const res = await sendDm(alice.token, { to: 'carol', text: 'bad', ...(bad.body ?? {}) }, bad.query ?? '');
      expect(res.status).toBe(400);
    }
    await stack.settle();
  });

  it('answers a channel post once every named recipient accepts, and reports the stragglers as queued', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-channel-wait');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws);
    const bob = await registerViaNode(node, 'bob');
    const carol = await registerViaNode(node, 'carol');

    const post = (text: string, waitMs: number) => stack.app.request('/v1/channels/general/messages', authed(alice.token, {
      method: 'POST', body: JSON.stringify({ text, wait_ms: waitMs }),
    }));
    let started = Date.now();
    const posting = post('all hands', 1000);
    await untilDelivered(node.sock, 'message.created', 2);
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', up_to_seq: 1 }));
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'carol', up_to_seq: 1 }));
    const res = await posting;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.status).toBe(201);
    const posted = ((await res.json()) as { data: { deliveries: SentDelivery[]; deliveries_truncated: boolean } }).data;
    expect(posted.deliveries.map((d) => [d.agent_id, d.state, d.accepted_at !== null]).sort()).toEqual([
      [bob.agentId, 'delivered', true], [carol.agentId, 'delivered', true],
    ].sort());
    expect(posted.deliveries_truncated).toBe(false);

    // Only bob accepts the next one: the budget runs out, carol is reported as it stands.
    started = Date.now();
    const partial = post('bob only', 300);
    await untilDelivered(node.sock, 'message.created', 4);
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', up_to_seq: 2 }));
    const partialRes = await partial;
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(290);
    expect(elapsed).toBeLessThan(1000);
    const partialPosted = ((await partialRes.json()) as { data: { deliveries: SentDelivery[] } }).data;
    expect(Object.fromEntries(partialPosted.deliveries.map((d) => [d.agent_id, [d.state, d.accepted_at !== null]]))).toEqual({
      [bob.agentId]: ['delivered', true], [carol.agentId]: ['delivered', false],
    });
    await stack.settle();
  });

  it('answers at once on a host without a delivery waiter, and on an idempotent replay', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-no-waiter');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    await registerAgent(stack.app, ws.workspaceKey, 'bob');

    const key = 'confirm-replay';
    let started = Date.now();
    const original = await sendDm(alice.token, { to: 'bob', text: 'first', wait_ms: 1000 });
    expect(original.status).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    await stack.settle();

    const send = () => stack.app.request('/v1/dm', authed(alice.token, {
      method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ to: 'bob', text: 'keyed', wait_ms: 1000 }),
    }));
    started = Date.now();
    const first = await send();
    expect(first.status).toBe(201);
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    const firstBody = await first.json();
    await stack.settle();

    // A replay repeats the stored receipt and never parks, whatever wait_ms says.
    started = Date.now();
    const replay = await send();
    expect(replay.headers.get('Idempotency-Replayed')).toBe('true');
    expect(await replay.json()).toEqual(firstBody);
    expect(Date.now() - started).toBeLessThan(500);

    // Without a DeliveryWaiters provider (the workspace actor, Cloudflare), a
    // fresh send answers at once: the same ports, minus the waiter.
    const bare = createEngine({ ...stack.runtime.deps, deliveryWaiters: undefined });
    started = Date.now();
    const immediate = await bare.request('/v1/dm', authed(alice.token, { method: 'POST', body: JSON.stringify({ to: 'bob', text: 'no waiter', wait_ms: 2000 }) }));
    expect(immediate.status).toBe(201);
    expect(((await immediate.json()) as { data: { delivery: SentDelivery } }).data.delivery).toMatchObject({ state: 'queued' });
    expect(Date.now() - started).toBeLessThan(500);
    await stack.settle();
  });

  it('wakes a parked send when the recipient acks, replies or fails the row instead of accepting it', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-wait-other');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');

    for (const settle of ['ack', 'fail'] as const) {
      const started = Date.now();
      const sending = sendDm(alice.token, { to: 'bob', text: settle, wait_ms: 1000 });
      // The recipient has no socket: the row stays queued until it settles it over REST.
      await new Promise((resolve) => setTimeout(resolve, 20));
      const queue = await stack.app.request('/v1/deliveries', authed(bob.token));
      const [item] = ((await queue.json()) as { data: Array<{ id: string }> }).data.filter(() => true).slice(-1);
      const settled = await stack.app.request(`/v1/deliveries/${item!.id}/${settle}`, authed(bob.token, {
        method: 'POST', body: settle === 'fail' ? JSON.stringify({ error: 'handler crashed', retryable: false }) : undefined,
      }));
      expect(settled.status).toBe(200);
      const sent = await sending;
      expect(Date.now() - started).toBeLessThan(1000);
      expect(sent.data.delivery).toMatchObject(settle === 'ack'
        ? { id: item!.id, status: 'acked', state: 'consumed', accepted_at: expect.any(String) }
        : { id: item!.id, status: 'failed', state: 'failed', error: 'handler crashed' });
      await stack.settle();
    }
  });
});
