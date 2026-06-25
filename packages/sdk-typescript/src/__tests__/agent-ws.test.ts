import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type AgentClientOptions } from '../agent.js';
import { stableRelaycastEventId } from '../event-id.js';
import { HttpClient } from '../client.js';

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: unknown = {}, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve({ ok: true, data }),
  });
}

function createAgent(options: AgentClientOptions = {}): AgentClient {
  const client = new HttpClient({
    apiKey: 'at_live_test',
    baseUrl: 'http://localhost:8080',
  });
  return new AgentClient(client, {
    ...options,
    ws: {
      reconnectJitter: false,
      ...(options.ws ?? {}),
    },
  });
}

describe('AgentClient WebSocket integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/v1/agent/node-token')) {
        return mockResponse({
          node_id: 'node_direct_agent_1',
          node_name: 'direct-agent-1',
          token: 'nt_live_direct_agent_1',
        });
      }
      return mockResponse({});
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function nextSocket(index = 0): Promise<MockWebSocket> {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
      const socket = MockWebSocket.instances[index];
      if (socket) return socket;
    }
    throw new Error(`Mock WebSocket ${index} was not created`);
  }

  // --- connect / disconnect ---

  it('connect() creates WebSocket with correct URL', async () => {
    const agent = createAgent();
    agent.connect();
    await nextSocket();

    expect(MockWebSocket.instances).toHaveLength(1);
    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.origin).toBe('ws://localhost:8080');
    expect(url.pathname).toBe('/v1/node/ws');
    expect(url.searchParams.get('token')).toBe('nt_live_direct_agent_1');
    expect(url.searchParams.get('origin_client')).toBe('@relaycast/sdk');
    expect(url.searchParams.get('origin_version')).toBeDefined();
  });

  it('connect() normalizes trailing slash base URL', async () => {
    const client = new HttpClient({
      apiKey: 'at_live_test',
      baseUrl: 'https://relay.example.com/',
    });
    const agent = new AgentClient(client);
    agent.connect();
    await nextSocket();

    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.origin).toBe('wss://relay.example.com');
    expect(url.pathname).toBe('/v1/node/ws');
    expect(url.searchParams.get('token')).toBe('nt_live_direct_agent_1');
    expect(url.searchParams.get('origin_client')).toBe('@relaycast/sdk');
    expect(url.searchParams.get('origin_version')).toBeDefined();
  });

  it('connect() is idempotent — second call does not create another WebSocket', async () => {
    const agent = createAgent();
    agent.connect();
    agent.connect();
    await nextSocket();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('disconnect() closes WebSocket', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const p = agent.disconnect();
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(ws.close).toHaveBeenCalled();
  });

  it('disconnect() allows reconnect with a fresh WebSocket', async () => {
    const agent = createAgent();
    agent.connect();
    await nextSocket();
    const p = agent.disconnect();
    await vi.advanceTimersByTimeAsync(200);
    await p;

    agent.connect();
    await nextSocket(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('disconnect() clears manual and managed subscriptions before future reconnect', async () => {
    const agent = createAgent();
    agent.connect();
    const ws1 = await nextSocket();
    ws1.simulateOpen();
    agent.subscribe(['general']);
    agent.subscribe(['dev'], vi.fn());

    const p = agent.disconnect();
    await vi.advanceTimersByTimeAsync(200);
    await p;

    agent.subscribe(['random'], vi.fn());
    const ws2 = await nextSocket(1);
    ws2.simulateOpen();

    const subscribePayloads = ws2.send.mock.calls
      .map(([payload]) => JSON.parse(String(payload)))
      .filter((payload) => payload.type === 'subscribe');
    expect(subscribePayloads).toEqual([]);
  });

  // --- typed on.* handlers ---

  it('on.messageCreated fires with message.created event', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.messageCreated(handler);

    ws.simulateMessage({
      v: 1,
      type: 'deliver',
      delivery_id: 'del_1',
      agent_id: 'agent_1',
      agent: 'worker',
      msg_id: 'm_1',
      seq: 1,
      mode: 'wait',
      payload: {
        type: 'message.created',
        data: {
          id: 'm_1',
          channel_name: 'general',
          agent_id: 'bot_1',
          from_name: 'Bot',
          text: 'hi',
          attachments: [],
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.created', channel: 'general' }),
    );
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'worker',
      up_to_seq: 1,
    }));
  });

  it('on.messageReacted fires with message.reacted event', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.messageReacted(handler);

    ws.simulateMessage({
      type: 'message.reacted',
      message_id: 'm_1',
      emoji: '👍',
      agent_name: 'Bot',
      action: 'added',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.reacted', emoji: '👍' }),
    );
  });

  it('on.deliveryFailed fires from node context.update frames', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.deliveryFailed(handler);

    ws.simulateMessage({
      v: 1,
      type: 'context.update',
      topic: 'agent',
      event: 'delivery.failed',
      agent_ids: ['agent_1'],
      data: {
        delivery_id: null,
        message_id: 'm_1',
        reason: 'depth_cap',
        retryable: false,
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'delivery.failed',
      deliveryId: null,
      messageId: 'm_1',
      retryable: false,
    }));
  });

  it('on.dmReceived fires with dm.received event', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.dmReceived(handler);

    ws.simulateMessage({
      v: 1,
      type: 'deliver',
      delivery_id: 'del_dm_1',
      agent_id: 'agent_1',
      agent: 'worker',
      msg_id: 'dm_1',
      seq: 2,
      mode: 'wait',
      payload: {
        type: 'dm.received',
        data: {
          conversation_id: 'conv_1',
          message: { id: 'dm_1', agent_name: 'Alice', text: 'hello' },
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dm.received', conversationId: 'conv_1' }),
    );
  });

  it('on.channelCreated fires with channel.created event', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.channelCreated(handler);

    ws.simulateMessage({
      type: 'channel.created',
      channel: { name: 'new-channel', topic: null },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'channel.created' }),
    );
  });

  // --- subscribe / unsubscribe proxy ---

  it('subscribe() is local state on direct node transport', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    agent.subscribe(['general', 'dev']);

    const frames = ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
    expect(frames.some((frame) => frame.type === 'subscribe')).toBe(false);
  });

  it('unsubscribe() is local state on direct node transport', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    agent.subscribe(['dev']);
    ws.send.mockClear();

    agent.unsubscribe(['dev']);

    expect(ws.send).not.toHaveBeenCalled();
  });

  it('subscribe() is a no-op when not connected', () => {
    const agent = createAgent();
    // Should not throw
    agent.subscribe(['general']);
  });

  it('unsubscribe() is a no-op when not connected', () => {
    const agent = createAgent();
    // Should not throw
    agent.unsubscribe(['general']);
  });

  it('subscribe(channels, handler) multiplexes channel and self DM events on one socket', async () => {
    const agent = createAgent();
    const handler = vi.fn();

    const subscription = agent.subscribe(['#general', '@self'], handler);

    const ws = await nextSocket();
    expect(MockWebSocket.instances).toHaveLength(1);
    ws.simulateOpen();

    const frames = ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
    expect(frames.some((frame) => frame.type === 'subscribe')).toBe(false);

    ws.simulateMessage({
      id: stableRelaycastEventId('m_1'),
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
    });
    ws.simulateMessage({
      id: stableRelaycastEventId('dm_1'),
      type: 'dm.received',
      conversation_id: 'conv_1',
      message: { id: 'dm_1', agent_name: 'Alice', text: 'hello' },
    });
    ws.simulateMessage({
      id: stableRelaycastEventId('m_2'),
      type: 'message.created',
      channel: 'random',
      message: { id: 'm_2', agent_name: 'Bot', text: 'skip', attachments: [] },
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]![0]).toMatchObject({ id: stableRelaycastEventId('m_1'), type: 'message.created' });
    expect(handler.mock.calls[1]![0]).toMatchObject({ id: stableRelaycastEventId('dm_1'), type: 'dm.received' });

    subscription.unsubscribe();
    expect(ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload))).some((frame) => frame.type === 'unsubscribe')).toBe(false);
  });

  it('subscribe(channels, handler) logs rejected handler promises', async () => {
    const agent = createAgent();
    const err = new Error('handler failed');
    const handler = vi.fn().mockRejectedValue(err);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    agent.subscribe(['general'], handler);
    const ws = await nextSocket();
    ws.simulateOpen();
    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
    });

    for (let i = 0; i < 5; i += 1) {
      await Promise.resolve();
    }

    expect(handler).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith('[relaycast] Subscription handler failed', err);
    errorSpy.mockRestore();
  });

  it('does not send remote resubscribe frames after reconnect on direct node transport', async () => {
    const agent = createAgent();
    const subscription = agent.subscribe(['general'], vi.fn());

    const ws1 = await nextSocket();
    ws1.simulateOpen();
    ws1.simulateClose();

    await vi.advanceTimersByTimeAsync(1000);

    const ws2 = await nextSocket(1);
    ws2.simulateOpen();
    const frames = ws2.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
    expect(frames.some((frame) => frame.type === 'subscribe')).toBe(false);

    subscription.unsubscribe();
  });

  // --- lifecycle events ---

  it('on.connected fires on WebSocket open', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();

    const handler = vi.fn();
    agent.on.connected(handler);

    ws.simulateOpen();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on.connected fires immediately if registered after open', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await Promise.resolve();

    const handler = vi.fn();
    agent.on.connected(handler);
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on.disconnected fires on WebSocket close', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.disconnected(handler);

    ws.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on.reconnecting fires with attempt count', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.reconnecting(handler);

    ws.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);

    // Advance timer to trigger reconnect, then close again
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = await nextSocket(1);
    ws2.simulateClose();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(2);
  });

  it('on.permanentlyDisconnected fires with attempt count', async () => {
    const agent = createAgent({
      ws: { maxReconnectAttempts: 0, reconnectJitter: false },
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.permanentlyDisconnected(handler);

    ws.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(0);
  });

  it('does not send workspace resync frames on direct node reconnect', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.resynced(handler);

    // Receive a seq-stamped event, drop, reconnect.
    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
      agent_seq: 4,
    });
    ws.simulateClose();
    await vi.advanceTimersByTimeAsync(1000);

    const ws2 = await nextSocket(1);
    ws2.simulateOpen();

    const frames = ws2.send.mock.calls.map(([data]) => JSON.parse(data as string));
    expect(frames.some((f) => f.type === 'resync')).toBe(false);

    ws2.simulateMessage({
      type: 'resync_ack',
      last_seen_seq: 4,
      current_seq: 6,
      replayed: 2,
      gap_detected: false,
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it('starts auto-heartbeat on open and continues on interval', async () => {
    const agent = createAgent({ autoHeartbeatMs: 30_000 });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:8080/v1/agent/node-token');
    expect(mockFetch.mock.calls[1]![0]).toBe('http://localhost:8080/v1/agents/heartbeat');

    vi.advanceTimersByTime(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[2]![0]).toBe('http://localhost:8080/v1/agents/heartbeat');
  });

  it('stops auto-heartbeat on disconnect', async () => {
    const agent = createAgent({ autoHeartbeatMs: 30_000 });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await Promise.resolve();

    vi.advanceTimersByTime(30_000);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const p = agent.disconnect();
    await vi.advanceTimersByTimeAsync(200);
    await p;
    expect(mockFetch).toHaveBeenCalledTimes(4);
    expect(mockFetch.mock.calls[3]![0]).toBe('http://localhost:8080/v1/agents/disconnect');

    vi.advanceTimersByTime(60_000);
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('does not start auto-heartbeat interval when disabled', async () => {
    const agent = createAgent({ autoHeartbeatMs: false });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await Promise.resolve();

    expect(mockFetch).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(120_000);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // --- wildcard ---

  it('on.any receives all events', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();

    const handler = vi.fn();
    agent.on.any(handler);

    ws.simulateOpen();
    await Promise.resolve();
    // 'open' synthetic event

    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
    });
    ws.simulateMessage({ type: 'pong' });

    // open + message.created; node transport control replies/pongs are not app events.
    expect(handler).toHaveBeenCalledTimes(2);
  });

  // --- error: call before connect ---

  it('on.messageCreated throws if called before connect()', () => {
    const agent = createAgent();
    expect(() => agent.on.messageCreated(vi.fn())).toThrow(
      'WebSocket not connected. Call connect() first.',
    );
  });

  it('on.connected throws if called before connect()', () => {
    const agent = createAgent();
    expect(() => agent.on.connected(vi.fn())).toThrow(
      'WebSocket not connected. Call connect() first.',
    );
  });

  it('on.reconnecting throws if called before connect()', () => {
    const agent = createAgent();
    expect(() => agent.on.reconnecting(vi.fn())).toThrow(
      'WebSocket not connected. Call connect() first.',
    );
  });

  it('on.permanentlyDisconnected throws if called before connect()', () => {
    const agent = createAgent();
    expect(() => agent.on.permanentlyDisconnected(vi.fn())).toThrow(
      'WebSocket not connected. Call connect() first.',
    );
  });

  it('on.any throws if called before connect()', () => {
    const agent = createAgent();
    expect(() => agent.on.any(vi.fn())).toThrow(
      'WebSocket not connected. Call connect() first.',
    );
  });

  // --- unsubscribe function ---

  it('handler unsubscribe function stops future events', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    const unsub = agent.on.messageCreated(handler);

    const event = {
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
    };

    ws.simulateMessage(event);
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    ws.simulateMessage(event);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on.any unsubscribe function stops future events', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    const unsub = agent.on.any(handler);

    ws.simulateMessage({
      type: 'message.reacted',
      message_id: 'm_1',
      emoji: '👍',
      agent_name: 'Bot',
      action: 'added',
    });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    ws.simulateMessage({
      type: 'message.reacted',
      message_id: 'm_1',
      emoji: '👍',
      agent_name: 'Bot',
      action: 'added',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('presence.markOnline/heartbeat/markOffline hit expected endpoints', async () => {
    const agent = createAgent({ autoHeartbeatMs: false });

    await agent.presence.markOnline();
    await agent.presence.heartbeat();
    await agent.presence.markOffline();

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:8080/v1/agents/heartbeat');
    expect(mockFetch.mock.calls[1]![0]).toBe('http://localhost:8080/v1/agents/heartbeat');
    expect(mockFetch.mock.calls[2]![0]).toBe('http://localhost:8080/v1/agents/disconnect');
  });
});
