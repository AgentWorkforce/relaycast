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
import { sweepExpiredDeliveries } from '../../routes/deliveryRouting.js';
import { createEngine } from '../../engine.js';
import * as deliveryEngine from '../../engine/delivery.js';
import { markReadAndApplyReplies } from '../../engine/receipt.js';

type SentDelivery = {
  id: string;
  agent_id?: string;
  status: string;
  state: string;
  accepted_at: string | null;
  replied_at: string | null;
  reply_message_id: string | null;
  error: string | null;
  expires_at: string | null;
};
const QUEUED_RECEIPT = { status: 'queued', state: 'queued', accepted_at: null, replied_at: null, reply_message_id: null, error: null, expires_at: expect.any(String) };

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
    expect(sent.data.delivery).toEqual({ id: expect.any(String), ...QUEUED_RECEIPT });
    const deliveryId = sent.data.delivery!.id;
    await stack.settle();
    const [frame] = deliverFramesOfType(bobSock, 'dm.received');
    expect(frame).toMatchObject({ delivery_id: deliveryId, seq: 1 });

    // The host's socket write: raw status `delivered` (compat), but the
    // client has not confirmed it, so the sender's state is still `queued`.
    expect(stream.ofType('delivery.delivered')).toEqual([expect.objectContaining({ delivery_id: deliveryId, status: 'delivered', accepted: false })]);
    expect((await receipts(alice.token, sent.data.id))[0]).toMatchObject({ status: 'delivered', state: 'queued', delivered_at: expect.any(String), accepted_at: null });

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
    expect((await receipts(alice.token, first.data.id))[0]).toMatchObject({ status: 'delivered', state: 'queued', accepted_at: null });
    expect((await receipts(alice.token, second.data.id))[0]).toMatchObject({ state: 'delivered', accepted_at: expect.any(String) });
    expect(node.sock.ofType('error')).toHaveLength(0);
  });

  it('applies a named delivery_id on its own (up_to_seq ignored) for acceptance and ack, so rows settle individually and out of order', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-named-row');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws);
    const bob = await registerViaNode(node, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);
    const cursor = () => (stack.runtime.handle.sqlite.prepare('SELECT delivery_ack_seq AS c FROM agents WHERE id = ?').get(bob.agentId) as { c: number }).c;

    const first = await sendDm(alice.token, { to: 'bob', text: 'one' });
    const second = await sendDm(alice.token, { to: 'bob', text: 'two' });
    await stack.settle();
    expect(node.sock.ofType('deliver').map((f) => f.seq)).toEqual([1, 2]);

    // The client persisted 2 but not 1: it names 2. A stray up_to_seq beside
    // the name must not sweep 1 in.
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', delivery_id: second.data.delivery!.id, up_to_seq: 2 }));
    await stack.settle();
    expect((await receipts(alice.token, first.data.id))[0]).toMatchObject({ state: 'queued', accepted_at: null });
    expect((await receipts(alice.token, second.data.id))[0]).toMatchObject({ state: 'delivered', accepted_at: expect.any(String) });
    expect(stream.ofType('delivery.delivered').filter((e) => e.accepted === true).map((e) => e.delivery_id)).toEqual([second.data.delivery!.id]);

    // 1 is re-delivered and persisted later: marked on its own, never by range.
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', delivery_id: first.data.delivery!.id }));
    await stack.settle();
    expect((await receipts(alice.token, first.data.id))[0]).toMatchObject({ state: 'delivered', accepted_at: expect.any(String) });

    // Per-delivery consumption of 2 moves nothing else: 1 stays unconsumed and
    // the cumulative cursor stays put, so a reconnect still replays 1.
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', delivery_id: second.data.delivery!.id, up_to_seq: 2 }));
    await stack.settle();
    expect(stream.ofType('delivery.acked').map((e) => e.delivery_id)).toEqual([second.data.delivery!.id]);
    expect((await receipts(alice.token, first.data.id))[0]).toMatchObject({ state: 'delivered', acked_at: null });
    expect((await receipts(alice.token, second.data.id))[0]).toMatchObject({ state: 'consumed' });
    expect(cursor()).toBe(0);
    // A repeat names an already-consumed row: nothing new.
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', delivery_id: second.data.delivery!.id }));
    await stack.settle();
    expect(stream.ofType('delivery.acked')).toHaveLength(1);

    // Only a bare up_to_seq moves the cursor; it consumes what is left below it.
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: 2 }));
    await stack.settle();
    expect(stream.ofType('delivery.acked').map((e) => e.delivery_id).sort()).toEqual([first.data.delivery!.id, second.data.delivery!.id].sort());
    expect(cursor()).toBe(2);
    expect(node.sock.ofType('error')).toHaveLength(0);
  });

  it('marks exactly the message a DM explicitly answers as replied, and nothing without reply_to_message_id', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    await attachDirectNodeSocket(stack, ws.workspaceId, bob);
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const question = await sendDm(alice.token, { to: 'bob', text: 'free at 3?' });
    const followUp = await sendDm(alice.token, { to: 'bob', text: 'or 4?' });
    await stack.settle();

    // A DM back without a reference answers nothing.
    const aside = await sendDm(bob.token, { to: 'alice', text: 'by the way' });
    expect(aside.status).toBe(201);
    await stack.settle();
    expect(stream.ofType('delivery.replied')).toEqual([]);
    expect((await receipts(alice.token, question.data.id))[0]).toMatchObject({ state: 'queued', replied_at: null });

    // An explicit answer marks that message's delivery, and only that one.
    const answer = await sendDm(bob.token, { to: 'alice', text: 'yes, 3', reply_to_message_id: question.data.id });
    expect(answer.status).toBe(201);
    await stack.settle();
    const replied = expect.objectContaining({
      delivery_id: question.data.delivery!.id, message_id: question.data.id, agent_id: bob.agentId, agent_name: 'bob',
      status: 'replied', reply_message_id: answer.data.id, at: expect.any(String),
    });
    expect(stream.ofType('delivery.replied')).toEqual([replied]);
    expect(contextUpdatesOfType(aliceSock, 'delivery.replied').map((f) => f.data)).toEqual([replied]);
    expect((await receipts(alice.token, question.data.id))[0]).toMatchObject({
      status: 'delivered', state: 'replied', replied_at: expect.any(String), reply_message_id: answer.data.id,
    });
    expect((await receipts(alice.token, followUp.data.id))[0]).toMatchObject({ state: 'queued', replied_at: null, reply_message_id: null });

    // The reply names what it answers, on the send response and in history.
    const history = await stack.app.request(`/v1/dm/${answer.data.conversation_id}/messages`, authed(alice.token));
    const messages = ((await history.json()) as { data: Array<{ id: string; reply_to_message_id: string | null }> }).data;
    expect(messages.find((m) => m.id === answer.data.id)?.reply_to_message_id).toBe(question.data.id);
    expect(messages.find((m) => m.id === aside.data.id)?.reply_to_message_id).toBeNull();

    // Answering it again changes and reports nothing.
    await sendDm(bob.token, { to: 'alice', text: 'still 3', reply_to_message_id: question.data.id });
    await stack.settle();
    expect(stream.ofType('delivery.replied')).toHaveLength(1);
  });

  it('refuses a reply_to_message_id that is not the recipient\'s message in this conversation', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-invalid');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const carol = await registerAgent(stack.app, ws.workspaceKey, 'carol');
    const toBob = await sendDm(alice.token, { to: 'bob', text: 'for bob' });
    const toCarol = await sendDm(alice.token, { to: 'carol', text: 'for carol' });
    const bobsOwn = await sendDm(bob.token, { to: 'alice', text: 'mine' });
    await stack.settle();

    for (const [token, body] of [
      [bob.token, { to: 'alice', text: 'x', reply_to_message_id: toCarol.data.id }],   // another conversation
      [bob.token, { to: 'alice', text: 'x', reply_to_message_id: bobsOwn.data.id }],   // the replier's own message
      [carol.token, { to: 'bob', text: 'x', reply_to_message_id: toBob.data.id }],     // not the recipient's message
      [bob.token, { to: 'alice', text: 'x', reply_to_message_id: 'msg_missing' }],
      [bob.token, { to: 'alice', text: 'x', reply_to_message_id: '' }],
    ] as const) {
      const res = await sendDm(token, body);
      expect(res.status).toBe(400);
      expect(res.error?.code ?? 'invalid_request').toBe('invalid_request');
    }
    expect((await receipts(alice.token, toBob.data.id))[0]).toMatchObject({ replied_at: null });
  });

  it('keeps a reply to a still-queued row as a pending link: state queued, no delivery.replied, no reply_message_id shown', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-queued');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    // No socket: the row is never handed over (raw status queued).
    const unseen = await sendDm(alice.token, { to: 'bob', text: 'unseen' });
    await stack.settle();
    const answer = await sendDm(bob.token, { to: 'alice', text: 'guessing', reply_to_message_id: unseen.data.id });
    expect(answer.status).toBe(201);
    await stack.settle();
    expect(stream.ofType('delivery.replied')).toEqual([]);
    expect((await receipts(alice.token, unseen.data.id))[0]).toMatchObject({ status: 'queued', state: 'queued', replied_at: null, reply_message_id: null });
    // The link is kept for the row's transition out of queued; a second reply does not replace it.
    await sendDm(bob.token, { to: 'alice', text: 'again', reply_to_message_id: unseen.data.id });
    await stack.settle();
    expect(pendingLink(unseen.data.delivery!.id)).toEqual({ reply_message_id: answer.data.id, replied_at: null });
    expect(stream.ofType('delivery.replied')).toEqual([]);
  });

  /** The row's stored reply link, read under the API (which hides a pending one). */
  function pendingLink(deliveryId: string) {
    return stack.runtime.handle.sqlite.prepare('SELECT reply_message_id, replied_at FROM deliveries WHERE id = ?').get(deliveryId);
  }

  /** The sender-facing receipt events for one delivery, in arrival order. */
  function receiptEvents(stream: FakeSocket, deliveryId: string) {
    return stream.received.filter((event) => String(event.type).startsWith('delivery.') && event.delivery_id === deliveryId);
  }

  it('applies a reply sent while its row was still queued once replay marks the row delivered: delivered, then replied', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-replay');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: aliceSock } = await attachDirectNodeSocket(stack, ws.workspaceId, alice);
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const question = await sendDm(alice.token, { to: 'bob', text: 'free at 3?' });
    const deliveryId = question.data.delivery!.id;
    await stack.settle();
    // The replay window: the recipient already holds the row and answers over
    // HTTP while its page is still being sent, so the row is still raw queued.
    const answer = await sendDm(bob.token, { to: 'alice', text: 'yes', reply_to_message_id: question.data.id });
    expect(answer.status).toBe(201);
    await stack.settle();
    expect(receiptEvents(stream, deliveryId)).toEqual([]);
    expect((await receipts(alice.token, question.data.id))[0]).toMatchObject({ status: 'queued', state: 'queued', replied_at: null, reply_message_id: null });

    // The page's delivered mark runs: the pending reply applies behind it.
    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
    await stack.settle();
    expect(deliverFramesOfType(bobSock, 'dm.received')).toEqual([expect.objectContaining({ delivery_id: deliveryId })]);
    const replied = {
      delivery_id: deliveryId, message_id: question.data.id, agent_id: bob.agentId, agent_name: 'bob',
      status: 'replied', reply_message_id: answer.data.id, at: expect.any(String),
    };
    expect(receiptEvents(stream, deliveryId)).toEqual([
      expect.objectContaining({ type: 'delivery.delivered', status: 'delivered', accepted: false }),
      expect.objectContaining({ type: 'delivery.replied', ...replied }),
    ]);
    expect(contextUpdatesOfType(aliceSock, 'delivery.replied').map((f) => f.data)).toEqual([expect.objectContaining(replied)]);
    expect((await receipts(alice.token, question.data.id))[0]).toMatchObject({
      status: 'delivered', state: 'replied', delivered_at: expect.any(String), replied_at: expect.any(String), reply_message_id: answer.data.id,
    });
  });

  it('applies a reply sent while its row was still queued on the receiver acceptance: delivered (accepted), then replied', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-accepted');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws);
    const bob = await registerViaNode(node, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const question = await sendDm(alice.token, { to: 'bob', text: 'ship it?' });
    const deliveryId = question.data.delivery!.id;
    await stack.settle();
    expect(node.sock.ofType('deliver')).toHaveLength(1);
    // Simulate the window between the frame write and its delivered mark.
    stack.runtime.handle.sqlite.prepare("UPDATE deliveries SET status = 'queued', delivered_at = NULL WHERE id = ?").run(deliveryId);
    const sentReceipts = receiptEvents(stream, deliveryId).length;

    const answer = await sendDm(bob.token, { to: 'alice', text: 'shipped', reply_to_message_id: question.data.id });
    expect(answer.status).toBe(201);
    await stack.settle();
    expect(stream.ofType('delivery.replied')).toEqual([]);
    expect((await receipts(alice.token, question.data.id))[0]).toMatchObject({ status: 'queued', state: 'queued', reply_message_id: null });

    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', delivery_id: deliveryId }));
    await stack.settle();
    expect(receiptEvents(stream, deliveryId).slice(sentReceipts)).toEqual([
      expect.objectContaining({ type: 'delivery.delivered', accepted: true }),
      expect.objectContaining({ type: 'delivery.replied', agent_id: bob.agentId, reply_message_id: answer.data.id }),
    ]);
    expect((await receipts(alice.token, question.data.id))[0]).toMatchObject({
      status: 'delivered', state: 'replied', accepted_at: expect.any(String), replied_at: expect.any(String), reply_message_id: answer.data.id,
    });
    // A repeat acceptance or a later ack reports no second reply.
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.accepted', agent: 'bob', delivery_id: deliveryId }));
    await node.handle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    expect(stream.ofType('delivery.replied')).toHaveLength(1);
    expect(node.sock.ofType('error')).toHaveLength(0);
  });

  it('applies a reply a polling recipient sent before acking its still-queued row: acked, then replied', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-rest-ack');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const question = await sendDm(alice.token, { to: 'bob', text: 'polling?' });
    const deliveryId = question.data.delivery!.id;
    await stack.settle();
    const answer = await sendDm(bob.token, { to: 'alice', text: 'polled', reply_to_message_id: question.data.id });
    await stack.settle();
    expect(stream.ofType('delivery.replied')).toEqual([]);

    const ack = await stack.app.request(`/v1/deliveries/${deliveryId}/ack`, authed(bob.token, { method: 'POST' }));
    expect(ack.status).toBe(200);
    await stack.settle();
    // (The recipient-side `delivery.delivered` fanout of a REST ack is not a sender receipt.)
    const senderReceipts = receiptEvents(stream, deliveryId).filter((event) => event.type !== 'delivery.delivered');
    expect(senderReceipts.map((event) => [event.type, event.reply_message_id ?? null])).toEqual([
      ['delivery.acked', null], ['delivery.replied', answer.data.id],
    ]);
    expect((await receipts(alice.token, question.data.id))[0]).toMatchObject({ status: 'acked', state: 'replied', reply_message_id: answer.data.id });
  });

  /** The `UPDATE deliveries` statements `fn` prepares, alongside its result. */
  async function deliveryUpdates<T>(fn: () => Promise<T>): Promise<{ result: T; updates: string[] }> {
    const sqlite = stack.runtime.handle.sqlite;
    const original = sqlite.prepare;
    const updates: string[] = [];
    sqlite.prepare = ((source: string) => {
      if (/^\s*update\s+"?deliveries"?\s/i.test(source)) updates.push(source);
      return original.call(sqlite, source);
    }) as typeof sqlite.prepare;
    try {
      return { result: await fn(), updates };
    } finally {
      sqlite.prepare = original;
    }
  }

  /** A DM to `to` whose row is raw `queued` and carries a pending reply link from `to`. */
  async function pendingLinkedDm(from: { token: string }, to: { token: string; name: string }, text: string) {
    const question = await sendDm(from.token, { to: to.name, text });
    const deliveryId = question.data.delivery!.id;
    await stack.settle();
    stack.runtime.handle.sqlite.prepare("UPDATE deliveries SET status = 'queued', delivered_at = NULL WHERE id = ?").run(deliveryId);
    const answer = await sendDm(to.token, { to: 'alice', text: `re: ${text}`, reply_to_message_id: question.data.id });
    expect(answer.status).toBe(201);
    await stack.settle();
    expect(pendingLink(deliveryId)).toEqual({ reply_message_id: answer.data.id, replied_at: null });
    return { messageId: question.data.id, deliveryId, answerId: answer.data.id };
  }

  it('applies a pending reply link in the transition statement itself: delivered mark, REST ack and read each stamp replied_at in their one deliveries write', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-same-write');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const db = stack.runtime.handle.db;
    // No follow-up "apply" statement exists any more.
    expect(Object.keys(deliveryEngine).filter((name) => /applyPendingReplies/.test(name))).toEqual([]);

    const delivered = await pendingLinkedDm(alice, bob, 'mark me delivered');
    const mark = await deliveryUpdates(() => deliveryEngine.markDeliveriesDelivered(db, ws.workspaceId, [delivered.deliveryId]));
    expect(mark.result).toEqual({ delivered: [delivered.deliveryId], replied: [delivered.deliveryId] });
    expect(mark.updates).toHaveLength(1);
    expect(pendingLink(delivered.deliveryId)).toEqual({ reply_message_id: delivered.answerId, replied_at: expect.any(Number) });
    // Idempotent: the row is no longer queued, nothing is reported twice.
    expect(await deliveryEngine.markDeliveriesDelivered(db, ws.workspaceId, [delivered.deliveryId])).toEqual({ delivered: [], replied: [] });

    const acked = await pendingLinkedDm(alice, bob, 'ack me');
    const ack = await deliveryUpdates(() => deliveryEngine.ackDelivery(db, ws.workspaceId, bob.agentId, acked.deliveryId));
    expect(ack.result).toMatchObject({ changed: true, repliedDeliveryIds: [acked.deliveryId] });
    expect(ack.updates).toHaveLength(1);
    expect(pendingLink(acked.deliveryId)).toEqual({ reply_message_id: acked.answerId, replied_at: expect.any(Number) });
    expect(await deliveryEngine.ackDelivery(db, ws.workspaceId, bob.agentId, acked.deliveryId)).toMatchObject({ changed: false });

    const read = await pendingLinkedDm(alice, bob, 'read me');
    const marked = await deliveryUpdates(() => markReadAndApplyReplies(db, ws.workspaceId, read.messageId, bob.agentId));
    expect(marked.result).toMatchObject({ receipt: { message_id: read.messageId }, repliedDeliveryIds: [read.deliveryId] });
    expect(marked.updates).toHaveLength(1);
    expect(pendingLink(read.deliveryId)).toEqual({ reply_message_id: read.answerId, replied_at: expect.any(Number) });
    expect((await markReadAndApplyReplies(db, ws.workspaceId, read.messageId, bob.agentId))?.repliedDeliveryIds).toEqual([]);

    // A transition of a row without a link reports no reply.
    const plain = await sendDm(alice.token, { to: 'bob', text: 'no reply' });
    await stack.settle();
    expect((await deliveryEngine.ackDelivery(db, ws.workspaceId, bob.agentId, plain.data.delivery!.id))?.repliedDeliveryIds).toBeUndefined();
  });

  it('applies a pending reply link in the node acceptance and cumulative ack statements themselves, and never re-reports an earlier reply', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-node-same-write');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws);
    const bob = await registerViaNode(node, 'bob');
    const db = stack.runtime.handle.db;
    const { provider_name: provider } = stack.runtime.handle.sqlite
      .prepare('SELECT provider_name FROM agents WHERE id = ?').get(bob.agentId) as { provider_name: string };

    const first = await pendingLinkedDm(alice, bob, 'first');
    const second = await pendingLinkedDm(alice, bob, 'second');

    const accept = await deliveryUpdates(() => deliveryEngine.acceptDeliveries(db, ws.workspaceId, node.id, provider, 'bob', { deliveryId: first.deliveryId }));
    expect(accept.result).toMatchObject({ accepted_delivery_ids: [first.deliveryId], replied_delivery_ids: [first.deliveryId] });
    expect(accept.updates).toHaveLength(1);
    expect(pendingLink(first.deliveryId)).toEqual({ reply_message_id: first.answerId, replied_at: expect.any(Number) });
    expect(pendingLink(second.deliveryId)).toEqual({ reply_message_id: second.answerId, replied_at: null });

    // One chunk, one deliveries write: `first` (already replied) is acked
    // without a second reply; `second` leaves queued and its link applies.
    const ack = await deliveryUpdates(() => deliveryEngine.ackDeliveriesUpToSeq(db, ws.workspaceId, node.id, provider, 'bob', 2));
    expect(ack.result).toMatchObject({ acked_delivery_ids: [first.deliveryId, second.deliveryId], replied_delivery_ids: [second.deliveryId] });
    expect(ack.updates).toHaveLength(1);
    expect(pendingLink(second.deliveryId)).toEqual({ reply_message_id: second.answerId, replied_at: expect.any(Number) });

    // A row replied while delivered (stamped at once, maybe this very second)
    // is accepted without reporting that reply again.
    const third = await sendDm(alice.token, { to: 'bob', text: 'third' });
    await stack.settle();
    await sendDm(bob.token, { to: 'alice', text: 're: third', reply_to_message_id: third.data.id });
    await stack.settle();
    expect(await deliveryEngine.acceptDeliveries(db, ws.workspaceId, node.id, provider, 'bob', { deliveryId: third.data.delivery!.id }))
      .toMatchObject({ accepted_delivery_ids: [third.data.delivery!.id], replied_delivery_ids: [] });
  });

  it('does not re-report a reply a concurrent write stamped between the acceptance page read and its update, even in the same second', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-accept-race');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws);
    const bob = await registerViaNode(node, 'bob');
    const db = stack.runtime.handle.db;
    const sqlite = stack.runtime.handle.sqlite;
    const { provider_name: provider } = sqlite
      .prepare('SELECT provider_name FROM agents WHERE id = ?').get(bob.agentId) as { provider_name: string };

    const question = await sendDm(alice.token, { to: 'bob', text: 'race me' });
    const deliveryId = question.data.delivery!.id;
    await stack.settle();
    // A real message of bob's to point the link at, not yet linked.
    const answer = await sendDm(bob.token, { to: 'alice', text: 'the answer' });
    await stack.settle();
    expect(sqlite.prepare('SELECT status, accepted_at FROM deliveries WHERE id = ?').get(deliveryId))
      .toEqual({ status: 'delivered', accepted_at: null });
    expect(pendingLink(deliveryId)).toEqual({ reply_message_id: null, replied_at: null });

    // What a concurrent `markDeliveriesReplied` does to a `delivered` row (the
    // sender already heard `delivery.replied`), landing right after the
    // acceptance page read: the next statement acceptDeliveries prepares.
    const original = sqlite.prepare;
    let pageRead = false;
    let injectedAt: number | null = null;
    sqlite.prepare = ((source: string) => {
      if (injectedAt === null && pageRead) {
        injectedAt = Math.floor(Date.now() / 1000);
        original.call(sqlite, 'UPDATE deliveries SET reply_message_id = ?, replied_at = ?, updated_at = ? WHERE id = ?')
          .run(answer.data.id, injectedAt, injectedAt, deliveryId);
      }
      if (/from "deliveries"/i.test(source) && /order by/i.test(source)) pageRead = true;
      return original.call(sqlite, source);
    }) as typeof sqlite.prepare;
    let result;
    try {
      result = await deliveryEngine.acceptDeliveries(db, ws.workspaceId, node.id, provider, 'bob', { deliveryId });
    } finally {
      sqlite.prepare = original;
    }

    expect(injectedAt).not.toBeNull();
    expect(result).toMatchObject({ accepted_delivery_ids: [deliveryId], replied_delivery_ids: [] });
    // Stamped once, by the concurrent write; the acceptance left it alone.
    expect(pendingLink(deliveryId)).toEqual({ reply_message_id: answer.data.id, replied_at: injectedAt });
  });

  it('does not report a queued row whose reply was stamped before a requeue, even in the same second', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-reply-requeue-same-second');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const db = stack.runtime.handle.db;

    const question = await sendDm(alice.token, { to: 'bob', text: 'requeued' });
    const deliveryId = question.data.delivery!.id;
    await stack.settle();
    const answer = await sendDm(bob.token, { to: 'alice', text: 're: requeued', reply_to_message_id: question.data.id });
    await stack.settle();
    // Replied, then requeued this very second (a redrive leaves the link applied).
    const now = Math.floor(Date.now() / 1000);
    stack.runtime.handle.sqlite.prepare("UPDATE deliveries SET status = 'queued', delivered_at = NULL, reply_message_id = ?, replied_at = ? WHERE id = ?")
      .run(answer.data.id, now, deliveryId);

    expect(await deliveryEngine.markDeliveriesDelivered(db, ws.workspaceId, [deliveryId]))
      .toEqual({ delivered: [deliveryId], replied: [] });
    expect(pendingLink(deliveryId)).toEqual({ reply_message_id: answer.data.id, replied_at: now });
  });

  it('marks a channel message replied when a thread reply answers it', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-thread-reply');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const node = await enrollBrokerNode(ws);
    const bob = await registerViaNode(node, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const post = await stack.app.request('/v1/channels/general/messages', authed(alice.token, { method: 'POST', body: JSON.stringify({ text: 'thoughts?' }) }));
    const posted = ((await post.json()) as { data: { id: string; deliveries: SentDelivery[] } }).data;
    await stack.settle();
    expect(node.sock.ofType('deliver')).toHaveLength(1);

    const reply = await stack.app.request(`/v1/messages/${posted.id}/replies`, authed(bob.token, { method: 'POST', body: JSON.stringify({ text: 'two' }) }));
    expect(reply.status).toBe(201);
    const replied = ((await reply.json()) as { data: { id: string; reply_to_message_id: string } }).data;
    expect(replied.reply_to_message_id).toBe(posted.id);
    await stack.settle();
    expect(stream.ofType('delivery.replied')).toEqual([expect.objectContaining({
      delivery_id: posted.deliveries[0]!.id, message_id: posted.id, agent_id: bob.agentId, status: 'replied', reply_message_id: replied.id,
    })]);
    expect((await receipts(alice.token, posted.id))[0]).toMatchObject({ state: 'replied', reply_message_id: replied.id });
    const thread = await stack.app.request(`/v1/messages/${posted.id}/replies`, authed(alice.token));
    expect(((await thread.json()) as { data: { replies: Array<{ reply_to_message_id: string }> } }).data.replies[0]!.reply_to_message_id).toBe(posted.id);
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
      id: frame.delivery_id, status: 'delivered', state: 'delivered', accepted_at: expect.any(String),
      replied_at: null, reply_message_id: null, error: null, expires_at: expect.any(String),
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

    // A live socket that only takes the frame: host-delivered (raw status),
    // never accepted — so the wait runs out and the state is still `queued`.
    let started = Date.now();
    const toBob = await sendDm(alice.token, { to: 'bob', text: 'silent receiver', wait_ms: 300 });
    let elapsed = Date.now() - started;
    expect(toBob.status).toBe(201);
    expect(deliverFramesOfType(bobSock, 'dm.received')).toHaveLength(1);
    expect(toBob.data.delivery).toMatchObject({ status: 'delivered', state: 'queued', accepted_at: null });
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
    expect(Object.fromEntries(partialPosted.deliveries.map((d) => [d.agent_id, [d.status, d.state, d.accepted_at !== null]]))).toEqual({
      [bob.agentId]: ['delivered', 'delivered', true], [carol.agentId]: ['delivered', 'queued', false],
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
      expect((await receipts(alice.token, sent.data.id))[0]).toMatchObject(settle === 'ack'
        ? { state: 'consumed' }
        : { state: 'failed', error: 'handler crashed' });
      await stack.settle();
    }
  });

  it('answers a parked send with replied when the recipient explicitly answers during the wait', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-wait-replied');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { sock: bobSock } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);

    const started = Date.now();
    const sending = sendDm(alice.token, { to: 'bob', text: 'lunch?', wait_ms: 1000 });
    const [frame] = await untilDelivered(bobSock, 'dm.received');
    const questionId = (frame.msg_id ?? (frame.payload as { data: { id: string } }).data.id) as string;
    const answer = await sendDm(bob.token, { to: 'alice', text: 'sure', reply_to_message_id: questionId });
    expect(answer.status).toBe(201);
    const sent = await sending;
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sent.data.delivery).toMatchObject({
      id: frame.delivery_id, status: 'delivered', state: 'replied', accepted_at: null, replied_at: expect.any(String), reply_message_id: answer.data.id,
    });
    await stack.settle();
  });

  it('reports dead-lettered rows as failed to the sender', async () => {
    await stack.close();
    stack = makeNodeStack({ ttlMs: 60_000, mailbox: { deliveryTtlMs: 1_000 } });
    const ws = await createWorkspace(stack.app, 'confirm-dead-letter');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const sent = await sendDm(alice.token, { to: 'bob', text: 'will expire' });
    await stack.settle();
    const expired = await sweepExpiredDeliveries(stack.runtime.deps, { workspaceId: ws.workspaceId, now: new Date(Date.now() + 120_000) });
    expect(expired).toBe(1);
    await stack.settle();
    expect(stream.ofType('delivery.failed')).toEqual([expect.objectContaining({ delivery_id: sent.data.delivery!.id, message_id: sent.data.id })]);
    expect((await receipts(alice.token, sent.data.id))[0]).toMatchObject({
      agent_id: bob.agentId, status: 'dead_lettered', state: 'failed', dead_lettered_at: expect.any(String), replied_at: null,
    });
  });

  it('never applies a pending reply link to a row that expires: failed, not replied', async () => {
    await stack.close();
    stack = makeNodeStack({ ttlMs: 60_000, mailbox: { deliveryTtlMs: 1_000 } });
    const ws = await createWorkspace(stack.app, 'confirm-reply-expired');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const sent = await sendDm(alice.token, { to: 'bob', text: 'will expire' });
    await sendDm(bob.token, { to: 'alice', text: 'answered anyway', reply_to_message_id: sent.data.id });
    await stack.settle();
    expect(await sweepExpiredDeliveries(stack.runtime.deps, { workspaceId: ws.workspaceId, now: new Date(Date.now() + 120_000) })).toBeGreaterThanOrEqual(1);
    await stack.settle();
    expect(stream.ofType('delivery.failed').map((event) => event.delivery_id)).toContain(sent.data.delivery!.id);
    expect(stream.ofType('delivery.replied')).toEqual([]);
    expect((await receipts(alice.token, sent.data.id))[0]).toMatchObject({
      status: 'dead_lettered', state: 'failed', replied_at: null, reply_message_id: null,
    });
  });

  it('keeps an old client that never accepts truthful: queued until it acks, then consumed, never delivered', async () => {
    const ws = await createWorkspace(stack.app, 'confirm-legacy-client');
    const alice = await registerAgent(stack.app, ws.workspaceKey, 'alice');
    const bob = await registerAgent(stack.app, ws.workspaceKey, 'bob');
    const { handle: bobHandle } = await attachDirectNodeSocket(stack, ws.workspaceId, bob);
    const stream = new FakeSocket();
    stack.runtime.realtime.attachWorkspaceSocket(ws.workspaceId, stream);

    const sent = await sendDm(alice.token, { to: 'bob', text: 'legacy', wait_ms: 200 });
    expect(sent.data.delivery).toMatchObject({ status: 'delivered', state: 'queued', accepted_at: null });
    await stack.settle();
    expect((await receipts(alice.token, sent.data.id))[0]).toMatchObject({ status: 'delivered', state: 'queued' });

    // #620 shapes, unchanged except the additive `accepted` flag.
    expect(stream.ofType('delivery.delivered')).toEqual([{
      type: 'delivery.delivered', created_at: expect.any(String), seq: expect.any(Number),
      delivery_id: sent.data.delivery!.id, message_id: sent.data.id, agent_id: bob.agentId, agent_name: 'bob',
      status: 'delivered', accepted: false, at: expect.any(String),
    }]);

    await bobHandle.handleMessage(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: 1 }));
    await stack.settle();
    expect(stream.ofType('delivery.acked')).toEqual([{
      type: 'delivery.acked', created_at: expect.any(String), seq: expect.any(Number),
      delivery_id: sent.data.delivery!.id, message_id: sent.data.id, agent_id: bob.agentId, agent_name: 'bob',
      status: 'acked', at: expect.any(String),
    }]);
    const [receipt] = await receipts(alice.token, sent.data.id);
    expect(receipt).toMatchObject({ status: 'acked', state: 'consumed', acked_at: expect.any(String) });
    expect(Object.keys(receipt).sort()).toEqual([
      'accepted_at', 'acked_at', 'agent_id', 'agent_name', 'created_at', 'dead_lettered_at', 'delivered_at', 'error', 'id',
      'read_at', 'replied_at', 'reply_message_id', 'state', 'status',
    ]);
    // Never `delivered`: the client never said it held the row.
    expect(stream.ofType('delivery.delivered').filter((event) => event.accepted === true)).toEqual([]);
  });
});
