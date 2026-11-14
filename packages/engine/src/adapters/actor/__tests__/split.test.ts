import { describe, expect, it } from 'vitest';
import { FakeActorDatabase, FakeWorkspaceActor, jsonRequest } from './fakeActor.js';
import {
  INBOX_SEQ_BASE,
  channelActorId,
  conversationActorId,
  createSplitInbox,
  createSplitSource,
  inboxActorId,
  parseSplitActorId,
  type InboxHandoff,
} from '../split/index.js';

const WORKSPACE_ID = '241764880589606912';
const alice = { id: '300000000000000001', name: 'alice' };
const bob = { id: '300000000000000002', name: 'bob' };
const carol = { id: '300000000000000003', name: 'carol' };
const channel = { id: '400000000000000001', name: 'general' };

function channelPost(text: string, extra: Record<string, unknown> = {}) {
  return { kind: 'channel' as const, sender: bob, channel, recipients: [alice, bob, carol], text, ...extra };
}

/** A deterministic shuffle (mulberry32), so a failing interleaving reproduces. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('split topology actor ids', () => {
  it('builds and parses per-entity actor ids within the control plane alphabet', () => {
    expect(channelActorId(WORKSPACE_ID, channel.id)).toBe(`${WORKSPACE_ID}-ch-${channel.id}`);
    expect(conversationActorId(WORKSPACE_ID, 'abcdef0123456789abcdef01')).toBe(`${WORKSPACE_ID}-dm-abcdef0123456789abcdef01`);
    expect(parseSplitActorId(inboxActorId(WORKSPACE_ID, alice.id))).toEqual({ workspaceId: WORKSPACE_ID, kind: 'in', entity: alice.id });
    expect(() => inboxActorId(WORKSPACE_ID, 'a/b')).toThrow();
  });
});

describe('split source (channel / conversation actor)', () => {
  it('commits a channel post with one outbox entry per member but the sender, in the engine response shape', () => {
    const sql = new FakeActorDatabase();
    const source = createSplitSource(sql, { actorId: channelActorId(WORKSPACE_ID, channel.id) });
    const result = source.post(channelPost('hello'));
    expect(result.status).toBe(201);
    const body = JSON.parse(result.body) as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      channel_id: channel.id, agent_id: bob.id, agent_name: 'bob', text: 'hello', thread_id: null,
      injection_mode: 'wait', deliveries_truncated: false,
    });
    const id = body.data.id as string;
    expect(body.data.deliveries).toEqual([
      expect.objectContaining({ id: `del_${id}_${alice.id}`, agent_id: alice.id, status: 'queued' }),
      expect.objectContaining({ id: `del_${id}_${carol.id}`, agent_id: carol.id, status: 'queued' }),
    ]);
    expect(result.handoffs.map((handoff) => handoff.agent.name)).toEqual(['alice', 'carol']);
    expect(result.handoffs[0]!.entries).toEqual([
      { source_seq: 1, delivery_id: `del_${id}_${alice.id}`, msg_id: id, mode: 'wait', event_type: 'message.created' },
    ]);
    expect(result.handoffs[0]!.payloads[id]).toMatchObject({ id, text: 'hello', channel_name: 'general', from_name: 'bob' });
  });

  it('answers a DM in the engine response shape with the conversation id it was given', () => {
    const sql = new FakeActorDatabase();
    const source = createSplitSource(sql, { actorId: conversationActorId(WORKSPACE_ID, 'aa') });
    const result = source.post({ kind: 'dm', sender: bob, conversationId: 'dm_aa', recipient: alice, text: 'psst' });
    const data = (JSON.parse(result.body) as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ conversation_id: 'dm_aa', from_agent_id: bob.id, to: 'alice', text: 'psst', message: { agent_name: 'bob', text: 'psst' } });
    expect(data.delivery).toMatchObject({ id: `del_${data.id as string}_${alice.id}`, status: 'queued' });
    expect(result.handoffs).toHaveLength(1);
    expect(result.handoffs[0]!.payloads[data.id as string]).toMatchObject({ from_name: 'bob', text: 'psst' });
  });

  it('keeps unconfirmed entries in the outbox and sends them again with the next hand-off', () => {
    const sql = new FakeActorDatabase();
    const source = createSplitSource(sql, { actorId: 'src' });
    source.post(channelPost('one'));
    const second = source.post(channelPost('two'));
    expect(second.handoffs[0]!.entries.map((entry) => entry.source_seq)).toEqual([1, 2]);
    // The caller confirms what alice's inbox accepted on its next post.
    const third = source.post(channelPost('three', { confirmed: [{ recipient: alice.id, through: 2 }] }));
    expect(third.handoffs.find((handoff) => handoff.agent.id === alice.id)!.entries.map((entry) => entry.source_seq)).toEqual([3]);
    expect(third.handoffs.find((handoff) => handoff.agent.id === carol.id)!.entries.map((entry) => entry.source_seq)).toEqual([1, 2, 3]);
    expect(source.history().map((message) => (message.payload as { text: string }).text)).toEqual(['one', 'two', 'three']);
  });

  it('group-commits a batch of posts in order with one hand-off per recipient', () => {
    const sql = new FakeActorDatabase();
    const source = createSplitSource(sql, { actorId: 'src' });
    const batch = source.postMany([channelPost('one'), channelPost('two'), { kind: 'dm', sender: bob, conversationId: 'dm_x', recipient: alice, text: 'three' }]);
    expect(batch.results.map((result) => result.status)).toEqual([201, 201, 201]);
    expect(batch.handoffs.map((handoff) => [handoff.agent.name, handoff.entries.map((entry) => entry.source_seq)])).toEqual([['alice', [1, 2, 3]], ['carol', [1, 2]]]);
    const inbox = createSplitInbox(new FakeActorDatabase());
    const accepted = inbox.acceptMany(batch.handoffs.filter((handoff) => handoff.agent.id === alice.id));
    expect(accepted.results).toEqual([{ through: 3, accepted: 3 }]);
    expect(accepted.frames.map((frame) => (frame.payload as { data: { text: string } }).data.text)).toEqual(['one', 'two', 'three']);
  });

  it('redrives only entries older than the redrive delay', () => {
    let now = 1_000_000;
    const sql = new FakeActorDatabase();
    const source = createSplitSource(sql, { actorId: 'src', now: () => now });
    source.post(channelPost('old'));
    expect(source.dueHandoffs()).toEqual([]);
    expect(source.nextRedriveAt()).toBe(1_000_000 + 2_000);
    now += 2_000;
    expect(source.dueHandoffs().map((handoff) => handoff.agent.name)).toEqual(['alice', 'carol']);
    source.confirm([{ recipient: alice.id, through: 1 }, { recipient: carol.id, through: 1 }]);
    expect(source.dueHandoffs()).toEqual([]);
    expect(source.nextRedriveAt()).toBeNull();
  });
});

describe('split inbox (agent inbox actor)', () => {
  function handoffs(count: number, sourceId = 'src'): InboxHandoff[] {
    const sql = new FakeActorDatabase();
    const source = createSplitSource(sql, { actorId: sourceId });
    const out: InboxHandoff[] = [];
    for (let i = 1; i <= count; i += 1) {
      out.push(source.post({ kind: 'dm', sender: bob, conversationId: 'dm_x', recipient: alice, text: `${sourceId}:${i}` }).handoffs[0]!);
    }
    return out;
  }

  it('assigns inbox seqs from the inbox base, emits engine deliver frames and is idempotent', () => {
    const inbox = createSplitInbox(new FakeActorDatabase());
    const [first] = handoffs(1);
    const accepted = inbox.accept(first!);
    expect(accepted.result).toEqual({ through: 1, accepted: 1 });
    expect(accepted.frames).toEqual([expect.objectContaining({
      v: 1, type: 'deliver', agent: 'alice', agent_id: alice.id, seq: INBOX_SEQ_BASE + 1, mode: 'wait',
      payload: expect.objectContaining({ type: 'dm.received', data: expect.objectContaining({ text: 'src:1', from_name: 'bob' }) }),
    })]);
    // The same hand-off again (a retry, a redrive) changes nothing.
    expect(inbox.accept(first!)).toEqual({ result: { through: 1, accepted: 0 }, frames: [] });
    expect(inbox.pending()).toHaveLength(1);
  });

  it('holds back a hand-off that overtook an earlier one until the earlier entries arrive', () => {
    const inbox = createSplitInbox(new FakeActorDatabase());
    const sql = new FakeActorDatabase();
    const source = createSplitSource(sql, { actorId: 'src' });
    const one = source.post(channelPost('one')).handoffs[0]!;
    // A hand-off carrying only entry 2 (as if the outbox had been confirmed past 1 by mistake) stops at the gap.
    const two = source.post(channelPost('two', { confirmed: [{ recipient: alice.id, through: 1 }] })).handoffs[0]!;
    expect(two.entries.map((entry) => entry.source_seq)).toEqual([2]);
    expect(inbox.accept(two).result).toEqual({ through: 0, accepted: 0 });
    expect(inbox.accept(one).result).toEqual({ through: 1, accepted: 1 });
    expect(inbox.accept(two).result).toEqual({ through: 2, accepted: 1 });
  });

  it('keeps per-source order, loses nothing and duplicates nothing under shuffled, repeated hand-offs from two sources', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const inbox = createSplitInbox(new FakeActorDatabase());
      // Each hand-off carries every unconfirmed entry so far, as the source sends them.
      const fromA = handoffs(12, 'a').map((handoff, i, all) => ({ ...handoff, entries: all.slice(0, i + 1).flatMap((h) => h.entries), payloads: Object.assign({}, ...all.slice(0, i + 1).map((h) => h.payloads)) }));
      const fromB = handoffs(12, 'b').map((handoff, i, all) => ({ ...handoff, entries: all.slice(0, i + 1).flatMap((h) => h.entries), payloads: Object.assign({}, ...all.slice(0, i + 1).map((h) => h.payloads)) }));
      // Shuffle (reordering), drop some (loss in transit) and repeat some (retries).
      const traffic = shuffled([...fromA, ...fromB, ...fromA.slice(3, 6)], seed).filter((_, i) => i % 5 !== 2);
      for (const handoff of traffic) inbox.accept(handoff);
      // The last hand-off of each source carries everything; a redrive delivers it eventually.
      inbox.accept(fromA.at(-1)!);
      inbox.accept(fromB.at(-1)!);
      const frames = inbox.pending();
      const texts = frames.map((frame) => (frame.payload as { data: { text: string } }).data.text);
      expect(texts.filter((text) => text.startsWith('a:'))).toEqual(Array.from({ length: 12 }, (_, i) => `a:${i + 1}`));
      expect(texts.filter((text) => text.startsWith('b:'))).toEqual(Array.from({ length: 12 }, (_, i) => `b:${i + 1}`));
      expect(new Set(frames.map((frame) => frame.delivery_id)).size).toBe(24);
      expect(frames.map((frame) => frame.seq)).toEqual(Array.from({ length: 24 }, (_, i) => INBOX_SEQ_BASE + i + 1));
    }
  });

  it('acks up to a seq and replays only the rest', () => {
    const inbox = createSplitInbox(new FakeActorDatabase());
    const all = handoffs(3);
    for (const handoff of all) inbox.accept(handoff);
    expect(inbox.ack(INBOX_SEQ_BASE + 2)).toBe(2);
    expect(inbox.pending().map((frame) => frame.seq)).toEqual([INBOX_SEQ_BASE + 3]);
    // An ack below the cursor or past the last seq handed out is clamped.
    expect(inbox.ack(INBOX_SEQ_BASE + 1)).toBe(0);
    expect(inbox.ack(INBOX_SEQ_BASE + 99)).toBe(1);
    expect(inbox.state()).toEqual({ lastSeq: INBOX_SEQ_BASE + 3, ackedSeq: INBOX_SEQ_BASE + 3 });
  });
});

describe('split resolve on the Workspace actor', () => {
  async function call(actor: FakeWorkspaceActor, method: string, path: string, body?: unknown, token?: string) {
    const response = await actor.handle(jsonRequest(method, path, body, token));
    return { status: response.status, json: JSON.parse(response.body) as { data: Record<string, string> } };
  }

  it('authenticates an agent token and resolves a DM recipient, a channel roster and node bindings', async () => {
    const actor = new FakeWorkspaceActor(WORKSPACE_ID);
    const key = (await call(actor, 'POST', '/v1/workspaces', { name: 'split' })).json.data.api_key!;
    const a = (await call(actor, 'POST', '/v1/agents', { name: 'alice' }, key)).json.data;
    const b = (await call(actor, 'POST', '/v1/agents', { name: 'bob' }, key)).json.data;
    await call(actor, 'POST', '/v1/channels', { name: 'general' }, key);
    await call(actor, 'POST', '/v1/channels/general/join', {}, a.token);
    await call(actor, 'POST', '/v1/channels/general/join', {}, b.token);
    const node = (await call(actor, 'POST', '/v1/nodes', { name: 'n1', max_agents: 2 }, key)).json.data;
    await call(actor, 'POST', '/v1/nodes/n1/agents', { agent_name: 'alice' }, key);

    const resolved = await actor.runtime.splitResolve({ token: b.token, dm_to: 'alice', channel: 'general' });
    expect(resolved).toMatchObject({
      ok: true,
      sender: { id: b.id, name: 'bob' },
      dm: { recipient: { id: a.id, name: 'alice' } },
      channel: { name: 'general', members: expect.arrayContaining([{ id: a.id, name: 'alice' }, { id: b.id, name: 'bob' }]) },
    });
    // The conversation id is the one the engine's own DM path derives.
    const dm = await call(actor, 'POST', '/v1/dm', { to: 'alice', text: 'hi' }, b.token);
    expect(resolved.ok && resolved.dm?.conversation_id).toBe(dm.json.data.conversation_id);

    expect(await actor.runtime.splitResolve({ token: 'ar_ag_nope', dm_to: 'alice' })).toEqual({ ok: false, reason: 'unauthenticated' });
    expect(await actor.runtime.splitResolve({ token: b.token, dm_to: 'nobody' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await actor.runtime.splitResolve({ token: b.token, channel: 'nowhere' })).toEqual({ ok: false, reason: 'not_found' });
    expect(await actor.runtime.splitNodeAgents(node.id!)).toEqual([{ id: a.id, name: 'alice' }]);
  });
});

describe('split source message ids', () => {
  it('are snowflake-shaped, increase within a source and differ across sources in the same millisecond', async () => {
    const { createSourceIdGenerator } = await import('../split/source.js');
    const { SnowflakeGenerator } = await import('../../../engine/snowflake.js');
    const at = Date.UTC(2026, 10, 14, 12, 0, 0);
    const a = createSourceIdGenerator(() => at);
    const ids = Array.from({ length: 1000 }, () => a());
    for (let i = 1; i < ids.length; i += 1) expect(BigInt(ids[i]!) > BigInt(ids[i - 1]!)).toBe(true);
    expect(SnowflakeGenerator.extractTimestamp(ids[0]!)).toBe(at);
    // Sources minting in the same millisecond start at independent random points (a 21-bit draw each).
    const firsts = new Set(Array.from({ length: 50 }, () => createSourceIdGenerator(() => at)()));
    expect(firsts.size).toBe(50);
  });
});
