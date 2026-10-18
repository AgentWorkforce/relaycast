import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finalizeEvent, generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { BuzzRoomBridge, type RelayMessage, type RelayPort } from '../buzz-bridge/bridge.js';
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
      .filter((item) => !options.before || item.id < options.before!)
      .sort((a, b) => b.id.localeCompare(a.id))
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

  it('refuses to reuse a durable state file for another room or agent', async () => {
    const f = await fixture();
    await f.state.bind('room-a/coder');
    const reopened = await StateStore.open(f.path);
    await expect(reopened.bind('room-b/coder')).rejects.toThrow('different Buzz room');
  });
});
