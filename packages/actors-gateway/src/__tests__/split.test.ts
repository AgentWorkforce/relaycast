import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { INBOX_SEQ_BASE, type InboxHandoff, type SourcePost } from '@relaycast/engine/gateway';
import type { ActorClient } from '../actors.js';
import type { GatewayContext } from '../context.js';
import { NodeSocketSplit, createSplitRouter, hotPathSend } from '../split.js';

const WS = '241764880589606912';
const bob = { id: '300000000000000002', name: 'bob', address: 'bob@direct' };
const alice = { id: '300000000000000001', name: 'alice' };
const carol = { id: '300000000000000003', name: 'carol' };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const signal = new AbortController().signal;

function handoff(agent: { id: string; name: string }, seq: number): InboxHandoff {
  return { source: 'src', agent, entries: [{ source_seq: seq, delivery_id: `del_${seq}`, msg_id: `m${seq}`, mode: 'wait', event_type: 'dm.received' }], payloads: { [`m${seq}`]: { text: `t${seq}` } } };
}

function fakeContext(overrides: Partial<ActorClient> = {}) {
  const posts: { actorName: string; actorId: string; input: SourcePost }[] = [];
  let seq = 0;
  const actors = {
    splitResolve: vi.fn(async (_ws: string, input: { dm_to?: string; channel?: string }) => (input.dm_to === 'nobody'
      ? { ok: false as const, reason: 'not_found' as const }
      : {
        ok: true as const,
        sender: bob,
        ...(input.dm_to ? { dm: { recipient: alice, conversation_id: 'dm_abc', pair_key: 'abc' } } : {}),
        ...(input.channel ? { channel: { id: '400', name: input.channel, members: [alice, bob, carol] } } : {}),
      })),
    sourcePost: vi.fn(async (actorName: string, actorId: string, input: SourcePost) => {
      posts.push({ actorName, actorId, input });
      seq += 1;
      const recipients = input.kind === 'dm' ? [input.recipient] : input.recipients.filter((member) => member.id !== input.sender.id);
      return { status: 201, body: JSON.stringify({ ok: true, data: { id: `m${seq}` } }), handoffs: recipients.map((agent) => handoff(agent, seq)) };
    }),
    inboxAccept: vi.fn(async (_id: string, h: InboxHandoff) => ({ through: h.entries.at(-1)!.source_seq, accepted: h.entries.length })),
    sourceConfirm: vi.fn(async () => {}),
    ...overrides,
  } as unknown as ActorClient;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const ctx = { actors, logger, config: { actorsTopology: 'split' } } as unknown as GatewayContext;
  return { ctx, actors, posts, logger };
}

describe('hotPathSend', () => {
  const headers: [string, string][] = [['content-type', 'application/json']];
  it('takes an agent DM or channel post with only the fields the split path implements', () => {
    expect(hotPathSend('POST', '/v1/dm', headers, json({ to: 'alice', text: 'hi' }), 't', 'agent', WS))
      .toEqual({ workspaceId: WS, token: 't', target: { kind: 'dm', to: 'alice' }, text: 'hi', mode: 'wait' });
    expect(hotPathSend('POST', '/v1/channels/gen%20eral/messages', headers, json({ text: 'hi', mode: 'steer' }), 't', 'agent', WS))
      .toEqual({ workspaceId: WS, token: 't', target: { kind: 'channel', name: 'gen eral' }, text: 'hi', mode: 'steer' });
  });

  it('leaves everything else to the Workspace actor', () => {
    expect(hotPathSend('POST', '/v1/dm', headers, json({ to: 'alice', text: 'hi', attachments: ['f'] }), 't', 'agent', WS)).toBeUndefined();
    expect(hotPathSend('POST', '/v1/dm', headers, json({ address: 'alice@m', text: 'hi' }), 't', 'agent', WS)).toBeUndefined();
    expect(hotPathSend('POST', '/v1/dm', [...headers, ['idempotency-key', 'k']], json({ to: 'alice', text: 'hi' }), 't', 'agent', WS)).toBeUndefined();
    expect(hotPathSend('POST', '/v1/dm', headers, json({ to: 'alice', text: 'hi' }), 't', 'node', WS)).toBeUndefined();
    expect(hotPathSend('POST', '/v1/channels/gen/messages', headers, json({ text: 'hi', from: 'x' }), 't', 'agent', WS)).toBeUndefined();
    expect(hotPathSend('POST', '/v1/channels/gen/messages', headers, Buffer.from('not json'), 't', 'agent', WS)).toBeUndefined();
    expect(hotPathSend('GET', '/v1/dm', headers, null, 't', 'agent', WS)).toBeUndefined();
  });
});

describe('split router', () => {
  it('commits on the source actor, hands off to every recipient inbox and piggybacks confirmations on the next post', async () => {
    const { ctx, actors, posts } = fakeContext();
    const router = createSplitRouter(ctx);
    const send = hotPathSend('POST', '/v1/channels/gen/messages', [], json({ text: 'one' }), 't', 'agent', WS)!;
    const first = await router.send(send, signal);
    expect(first).toMatchObject({ status: 201 });
    await router.settled();
    expect(posts[0]).toMatchObject({ actorName: 'Channel', actorId: `${WS}-ch-400` });
    expect(vi.mocked(actors.inboxAccept).mock.calls.map(([id]) => id)).toEqual([`${WS}-in-${alice.id}`, `${WS}-in-${carol.id}`]);

    await router.send(send, signal);
    expect(posts[1]!.input.confirmed).toEqual([{ recipient: alice.id, through: 1 }, { recipient: carol.id, through: 1 }]);
    // The roster was resolved once and reused.
    expect(actors.splitResolve).toHaveBeenCalledTimes(1);
    await router.settled();
  });

  it('routes a DM to its conversation actor and falls back to the Workspace actor for an unresolved target', async () => {
    const { ctx, posts } = fakeContext();
    const router = createSplitRouter(ctx);
    await router.send(hotPathSend('POST', '/v1/dm', [], json({ to: 'alice', text: 'hi' }), 't', 'agent', WS)!, signal);
    expect(posts[0]).toMatchObject({ actorName: 'Conversation', actorId: `${WS}-dm-abc`, input: { kind: 'dm', conversationId: 'dm_abc' } });
    expect(await router.send(hotPathSend('POST', '/v1/dm', [], json({ to: 'nobody', text: 'hi' }), 't', 'agent', WS)!, signal)).toBeUndefined();
    await router.settled();
  });

  it('re-resolves after a write went to the Workspace actor', async () => {
    const { ctx, actors } = fakeContext();
    const router = createSplitRouter(ctx);
    const send = hotPathSend('POST', '/v1/channels/gen/messages', [], json({ text: 'x' }), 't', 'agent', WS)!;
    await router.send(send, signal);
    router.invalidate(WS);
    await router.send(send, signal);
    expect(actors.splitResolve).toHaveBeenCalledTimes(2);
    await router.settled();
  });

  it('keeps a failed hand-off in the outbox: the next post carries no confirmation for it', async () => {
    const { ctx, posts, logger } = fakeContext({ inboxAccept: vi.fn(async () => { throw new Error('inbox down'); }) });
    const router = createSplitRouter(ctx);
    const send = hotPathSend('POST', '/v1/dm', [], json({ to: 'alice', text: 'x' }), 't', 'agent', WS)!;
    await router.send(send, signal);
    await router.settled();
    await router.send(send, signal);
    expect(posts[1]!.input.confirmed).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('split.handoff_failed', expect.objectContaining({ actor_id: `${WS}-in-${alice.id}` }));
    await router.settled();
  });
});

describe('node socket split', () => {
  it('routes acks by seq space: inbox seqs to the inbox socket, the rest (capped) to the Workspace actor', () => {
    const { ctx } = fakeContext();
    const client = { readyState: WebSocket.OPEN, send: vi.fn() } as unknown as WebSocket;
    const nodeSplit = new NodeSocketSplit(ctx, WS, 'node_1', client, vi.fn());
    const inboxSocket = { readyState: WebSocket.OPEN, send: vi.fn(), close: vi.fn() };
    (nodeSplit as unknown as { inboxes: Map<string, unknown> }).inboxes.set('alice', { socket: inboxSocket, agentId: alice.id });

    // Below the inbox base: a Workspace actor delivery, forwarded unchanged.
    const low = JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'alice', up_to_seq: 4 });
    expect(nodeSplit.fromClient(low)).toBe(low);
    expect(inboxSocket.send).not.toHaveBeenCalled();

    // An inbox seq: to the inbox, and to the Workspace actor only as far as it delivered.
    nodeSplit.fromWorkspace(JSON.stringify({ v: 1, type: 'deliver', agent: 'alice', seq: 7 }));
    const high = JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'alice', up_to_seq: INBOX_SEQ_BASE + 3 });
    expect(JSON.parse(nodeSplit.fromClient(high)!)).toMatchObject({ up_to_seq: 7 });
    expect(inboxSocket.send).toHaveBeenCalledWith(high);

    // An agent the Workspace actor never delivered to: nothing goes to it.
    expect(nodeSplit.fromClient(JSON.stringify({ v: 1, type: 'delivery.ack', agent: 'bob', up_to_seq: INBOX_SEQ_BASE + 1 }))).toBeNull();
    nodeSplit.close();
    expect(inboxSocket.close).toHaveBeenCalled();
  });
});
