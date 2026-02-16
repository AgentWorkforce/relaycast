import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../agent.js';
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

function createAgent(): AgentClient {
  const client = new HttpClient({
    apiKey: 'at_live_test',
    baseUrl: 'http://localhost:8080',
  });
  return new AgentClient(client);
}

describe('AgentClient WebSocket integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- connect / disconnect ---

  it('connect() creates WebSocket with correct URL', () => {
    const agent = createAgent();
    agent.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0]!.url).toBe(
      'ws://localhost:8080/v1/stream?token=at_live_test',
    );
  });

  it('connect() is idempotent — second call does not create another WebSocket', () => {
    const agent = createAgent();
    agent.connect();
    agent.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('disconnect() closes WebSocket', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    agent.disconnect();
    expect(ws.close).toHaveBeenCalled();
  });

  it('disconnect() allows reconnect with a fresh WebSocket', () => {
    const agent = createAgent();
    agent.connect();
    agent.disconnect();

    agent.connect();
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  // --- typed on.* handlers ---

  it('on.messageCreated fires with message.created event', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.messageCreated(handler);

    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.created', channel: 'general' }),
    );
  });

  it('on.reactionAdded fires with reaction.added event', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.reactionAdded(handler);

    ws.simulateMessage({
      type: 'reaction.added',
      message_id: 'm_1',
      emoji: '👍',
      agent_name: 'Bot',
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reaction.added', emoji: '👍' }),
    );
  });

  it('on.dmReceived fires with dm.received event', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.dmReceived(handler);

    ws.simulateMessage({
      type: 'dm.received',
      conversation_id: 'conv_1',
      message: { id: 'dm_1', agent_name: 'Alice', text: 'hello' },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'dm.received', conversation_id: 'conv_1' }),
    );
  });

  it('on.channelCreated fires with channel.created event', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
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

  it('subscribe() proxies to WsClient', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    agent.subscribe(['general', 'dev']);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', channels: ['general', 'dev'] }),
    );
  });

  it('unsubscribe() proxies to WsClient', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    agent.unsubscribe(['dev']);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'unsubscribe', channels: ['dev'] }),
    );
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

  // --- lifecycle events ---

  it('on.connected fires on WebSocket open', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;

    const handler = vi.fn();
    agent.on.connected(handler);

    ws.simulateOpen();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on.disconnected fires on WebSocket close', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.disconnected(handler);

    ws.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on.reconnecting fires with attempt count', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.reconnecting(handler);

    ws.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);

    // Advance timer to trigger reconnect, then close again
    vi.advanceTimersByTime(1000);
    const ws2 = MockWebSocket.instances[1]!;
    ws2.simulateClose();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(2);
  });

  // --- wildcard ---

  it('on.any receives all events', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;

    const handler = vi.fn();
    agent.on.any(handler);

    ws.simulateOpen();
    // 'open' synthetic event

    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
    });
    ws.simulateMessage({ type: 'pong' });

    // open + message.created + pong = 3
    expect(handler).toHaveBeenCalledTimes(3);
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

  it('on.any throws if called before connect()', () => {
    const agent = createAgent();
    expect(() => agent.on.any(vi.fn())).toThrow(
      'WebSocket not connected. Call connect() first.',
    );
  });

  // --- unsubscribe function ---

  it('handler unsubscribe function stops future events', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
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

  it('on.any unsubscribe function stops future events', () => {
    const agent = createAgent();
    agent.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    const handler = vi.fn();
    const unsub = agent.on.any(handler);

    ws.simulateMessage({ type: 'pong' });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    ws.simulateMessage({ type: 'pong' });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
