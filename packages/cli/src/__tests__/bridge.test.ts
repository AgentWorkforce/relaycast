import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { BuzzRoomBridge, compareMessageIds, type RelayMessage, type RelayPort } from '../buzz-bridge/bridge.js';
import type { BridgeConfig } from '../buzz-bridge/config.js';
import { StateStore } from '../buzz-bridge/state.js';
import { isRoomMention, rootEventId } from '../buzz-bridge/nostr.js';

const channel = 'c83154dd-49d3-4dc1-aede-fdb8130d7fbe';
const botKey = generateSecretKey();
const senderKey = generateSecretKey();
const dirs: string[] = [];

afterEach(async () => { await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function mention(content = 'Please review this', tags: string[][] = []): Event {
  return finalizeEvent({
    kind: 9,
    created_at: Math.floor(Date.now() / 1000),
    content,
    tags: [['h', channel], ['p', getPublicKey(botKey)], ...tags],
  }, senderKey);
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'buzz-bridge-test-'));
  dirs.push(dir);
  const path = join(dir, 'state.json');
  const config: BridgeConfig = {
    buzzUrl: 'ws://localhost:3000/', channelId: channel, secretKey: botKey,
    pubkey: getPublicKey(botKey), relayToken: 'token', targetAgent: 'Coder',
    relayBaseUrl: 'http://localhost:8787', stateFile: path,
  };
  const messages = new Map<string, RelayMessage>();
  const dm = vi.fn(async () => ({ conversationId: 'dm-1', message: { id: '0000000000000000001' } }));
  const relay: RelayPort = {
    dm,
    message: async (id) => {
      const value = messages.get(id);
      if (!value) throw new Error(`Missing ${id}`);
      return value;
    },
    messages: async (_id, options) => [...messages.values()]
      .filter((item) => !options.before || compareMessageIds(item.id, options.before) < 0)
      .sort((a, b) => compareMessageIds(b.id, a.id))
      .slice(0, options.limit),
  };
  const published: Event[] = [];
  const publish = vi.fn(async (event: Event) => { published.push(event); });
  const state = await StateStore.open(path);
  const bridge = new BuzzRoomBridge(config, state, relay, { publish });
  return { bridge, config, dm, messages, published, publish, path, state, relay };
}

describe('Buzz room bridge', () => {
  it('accepts only signed room mentions, including out-of-room mention tags', () => {
    const event = mention('hi');
    expect(isRoomMention(event, channel, getPublicKey(botKey))).toBe(true);
    const outside = finalizeEvent({ ...event, tags: [['h', channel], ['mention', getPublicKey(botKey)]] }, senderKey);
    expect(isRoomMention(outside, channel, getPublicKey(botKey))).toBe(true);
    expect(isRoomMention({ ...event, content: 'tampered' }, channel, getPublicKey(botKey))).toBe(false);
    expect(isRoomMention(event, 'another-room', getPublicKey(botKey))).toBe(false);
    const literal = finalizeEvent({
      kind: 9, created_at: event.created_at, content: '@Relay Coder please review', tags: [['h', channel]],
    }, senderKey);
    expect(isRoomMention(literal, channel, getPublicKey(botKey), 'Relay Coder')).toBe(true);
    expect(isRoomMention(literal, channel, getPublicKey(botKey), 'Other Bot')).toBe(false);
  });

  it('sends one Relay DM, then signs a threaded Buzz reply with the original author', async () => {
    const f = await fixture();
    const root = 'a'.repeat(64);
    const event = mention('Review', [['e', root, '', 'root']]);
    expect(rootEventId(event)).toBe(root);
    expect(await f.bridge.receiveBuzz(event)).toBe(true);
    expect(await f.bridge.receiveBuzz(event)).toBe(false);
    expect(f.dm).toHaveBeenCalledTimes(1);
    expect(f.dm.mock.calls[0]?.[2]).toEqual({ idempotencyKey: `buzz-room-${event.id}` });
    f.messages.set('0000000000000000002', {
      id: '0000000000000000002', agentName: 'Coder', text: 'Reviewed and fixed.',
      threadId: '0000000000000000001',
    });
    expect(await f.bridge.receiveRelay('0000000000000000002')).toBe(true);
    const reply = f.published[0]!;
    expect(reply.content).toBe('Reviewed and fixed.');
    expect(reply.tags).toContainEqual(['h', channel]);
    expect(reply.tags).toContainEqual(['e', root, '', 'root']);
    expect(reply.tags).toContainEqual(['e', event.id, '', 'reply']);
    expect(reply.tags).toContainEqual(['p', event.pubkey]);
    expect(reply.pubkey).toBe(getPublicKey(botKey));
    expect(await f.bridge.receiveRelay('0000000000000000002')).toBe(false);
    expect(f.published).toHaveLength(1);
  });

  it('retries the exact signed reply after a failed publish and restart', async () => {
    const f = await fixture();
    const event = mention();
    await f.bridge.receiveBuzz(event);
    f.messages.set('0000000000000000002', {
      id: '0000000000000000002', agentName: 'Coder', text: 'Done', threadId: '0000000000000000001',
    });
    f.publish.mockRejectedValueOnce(new Error('disconnected'));
    await expect(f.bridge.receiveRelay('0000000000000000002')).rejects.toThrow('disconnected');
    const pending = f.state.data.replies['0000000000000000002']!.event.id;
    const reopened = await StateStore.open(f.path);
    const restored = new BuzzRoomBridge(f.config, reopened, f.relay, { publish: f.publish });
    await restored.replayPending();
    expect(f.publish).toHaveBeenCalledTimes(2);
    expect(f.publish.mock.calls[1]?.[0].id).toBe(pending);
    expect(reopened.data.replies['0000000000000000002']?.published).toBe(true);
  });

  it('catches up after more than one page of Relay messages without skipping replies', async () => {
    const f = await fixture();
    await f.bridge.receiveBuzz(mention());
    for (let n = 2; n <= 105; n++) {
      const id = String(n).padStart(19, '0');
      f.messages.set(id, {
        id, agentName: n === 2 ? 'Coder' : 'Other', text: `message ${n}`,
        threadId: n === 2 ? '0000000000000000001' : null,
      });
    }
    await f.bridge.catchUp();
    expect(f.published).toHaveLength(1);
    expect(f.state.data.relayCursor).toBe('0000000000000000105');
  });

  it('skips an unpublishable reply and advances the catch-up cursor', async () => {
    const f = await fixture();
    await f.bridge.receiveBuzz(mention());
    const threadId = '0000000000000000001';
    f.messages.set('0000000000000000002', {
      id: '0000000000000000002', agentName: 'Coder', text: '   ', threadId,
    });
    f.messages.set('0000000000000000003', {
      id: '0000000000000000003', agentName: 'Coder', text: 'x'.repeat(65_537), threadId,
    });
    f.messages.set('0000000000000000004', {
      id: '0000000000000000004', agentName: 'Coder', text: 'kept', threadId,
    });
    await f.bridge.catchUp();
    expect(f.published.map((event) => event.content)).toEqual(['kept']);
    expect(f.state.data.replies['0000000000000000002']?.skipped).toBe(true);
    expect(f.state.data.replies['0000000000000000003']?.skipped).toBe(true);
    expect(f.state.data.relayCursor).toBe('0000000000000000004');
    await f.bridge.replayPending();
    await f.bridge.catchUp();
    expect(f.published).toHaveLength(1);
  });

  it('does not advance the cursor past an unmatched reply', async () => {
    const f = await fixture();
    await f.bridge.receiveBuzz(mention());
    const cursor = f.state.data.relayCursor;
    f.messages.set('0000000000000000002', {
      id: '0000000000000000002', agentName: 'Coder', text: 'early',
      threadId: '0000000000000000999',
    });
    f.messages.set('0000000000000000003', {
      id: '0000000000000000003', agentName: 'Coder', text: 'later',
      threadId: '0000000000000000001',
    });
    await f.bridge.catchUp();
    expect(f.published).toHaveLength(0);
    expect(f.state.data.replies['0000000000000000002']).toBeUndefined();
    expect(f.state.data.relayCursor).toBe(cursor);

    f.messages.set('0000000000000000002', {
      id: '0000000000000000002', agentName: 'Coder', text: 'early',
      threadId: '0000000000000000001',
    });
    await f.bridge.catchUp();
    expect(f.published.map((event) => event.content)).toEqual(['early', 'later']);
    expect(f.state.data.relayCursor).toBe('0000000000000000003');
  });

  it('publishes the next pending reply when one Buzz publish fails', async () => {
    const f = await fixture();
    const first = { id: '1', content: 'first', kind: 9, pubkey: 'p', created_at: 0, tags: [], sig: 's' } as Event;
    const second = { ...first, id: '2', content: 'second' };
    await f.state.update((state) => {
      state.replies['0000000000000000002'] = { event: first, published: false };
      state.replies['0000000000000000003'] = { event: second, published: false };
    });
    f.publish.mockImplementation(async (event: Event) => {
      if (event.content === 'first') throw new Error('rejected');
      f.published.push(event);
    });
    await f.bridge.replayPending();
    expect(f.published.map((event) => event.content)).toEqual(['second']);
    expect(f.state.data.replies['0000000000000000002']?.published).toBe(false);
    expect(f.state.data.replies['0000000000000000003']?.published).toBe(true);
  });

  it('keeps a reply-marked e tag in the same Buzz thread', async () => {
    const f = await fixture();
    const parent = 'c'.repeat(64);
    const root = 'd'.repeat(64);
    const replyOnly = mention('continue', [['e', parent, '', 'reply']]);
    expect(rootEventId(replyOnly)).toBe(parent);
    expect(rootEventId(mention('both', [['e', parent, '', 'reply'], ['e', root, '', 'root']]))).toBe(root);
    await f.bridge.receiveBuzz(replyOnly);
    f.messages.set('0000000000000000002', {
      id: '0000000000000000002', agentName: 'Coder', text: 'staying',
      threadId: '0000000000000000001',
    });
    expect(await f.bridge.receiveRelay('0000000000000000002')).toBe(true);
    expect(f.published[0]?.tags).toContainEqual(['e', parent, '', 'root']);
    expect(f.published[0]?.tags).toContainEqual(['e', replyOnly.id, '', 'reply']);
  });

  it('orders snowflake ids by length, then lexicographically', async () => {
    const f = await fixture();
    await f.bridge.receiveBuzz(mention());
    await f.state.update((state) => { state.relayCursor = '99'; });
    const threadId = '0000000000000000001';
    f.messages.set('98', { id: '98', agentName: 'Coder', text: 'stale', threadId });
    f.messages.set('100', { id: '100', agentName: 'Coder', text: 'first', threadId });
    f.messages.set('999', { id: '999', agentName: 'Other', text: 'noise' });
    f.messages.set('1000', { id: '1000', agentName: 'Coder', text: 'second', threadId });
    await f.bridge.catchUp();
    expect(f.published.map((event) => event.content)).toEqual(['first', 'second']);
    expect(f.state.data.relayCursor).toBe('1000');
  });

  it('refuses to reuse a durable state file for another room or agent', async () => {
    const f = await fixture();
    await f.state.bind('room-a/coder');
    const reopened = await StateStore.open(f.path);
    await expect(reopened.bind('room-b/coder')).rejects.toThrow('different Buzz room');
  });
});
