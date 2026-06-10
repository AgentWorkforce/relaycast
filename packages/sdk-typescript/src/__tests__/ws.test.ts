import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsClient } from '../ws.js';

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

describe('WsClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects to correct URL with token and sdk origin', () => {
    const client = new WsClient({ token: 'at_live_test' });
    client.connect();

    expect(MockWebSocket.instances).toHaveLength(1);
    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.origin).toBe('wss://gateway.relaycast.dev');
    expect(url.pathname).toBe('/v1/ws');
    expect(url.searchParams.get('token')).toBe('at_live_test');
    expect(url.searchParams.get('origin_surface')).toBe('sdk');
    expect(url.searchParams.get('origin_client')).toBe('@relaycast/sdk');
    expect(url.searchParams.get('origin_version')).toBeDefined();
  });

  it('converts http baseUrl to ws', () => {
    const client = new WsClient({
      token: 'at_live_test',
      baseUrl: 'http://localhost:8080',
    });
    client.connect();

    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.origin).toBe('ws://localhost:8080');
    expect(url.pathname).toBe('/v1/ws');
    expect(url.searchParams.get('token')).toBe('at_live_test');
    expect(url.searchParams.get('origin_surface')).toBe('sdk');
    expect(url.searchParams.get('origin_client')).toBe('@relaycast/sdk');
    expect(url.searchParams.get('origin_version')).toBeDefined();
  });

  it('normalizes trailing slash in baseUrl', () => {
    const client = new WsClient({
      token: 'at_live_test',
      baseUrl: 'https://pr28-gateway.relaycast.dev/',
    });
    client.connect();

    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.origin).toBe('wss://pr28-gateway.relaycast.dev');
    expect(url.pathname).toBe('/v1/ws');
    expect(url.searchParams.get('token')).toBe('at_live_test');
    expect(url.searchParams.get('origin_surface')).toBe('sdk');
    expect(url.searchParams.get('origin_client')).toBe('@relaycast/sdk');
    expect(url.searchParams.get('origin_version')).toBeDefined();
  });

  it('emits events from server messages', () => {
    const client = new WsClient({ token: 'at_live_test' });
    const handler = vi.fn();
    client.on('message.created', handler);

    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

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

  it('subscribe sends subscribe message', () => {
    const client = new WsClient({ token: 'at_live_test' });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    client.subscribe(['general', 'dev']);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'subscribe', channels: ['general', 'dev'] }),
    );
  });

  it('unsubscribe sends unsubscribe message', () => {
    const client = new WsClient({ token: 'at_live_test' });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    client.unsubscribe(['dev']);

    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: 'unsubscribe', channels: ['dev'] }),
    );
  });

  it('sends ping every 30s', () => {
    const client = new WsClient({ token: 'at_live_test' });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));

    vi.advanceTimersByTime(30_000);
    expect(ws.send).toHaveBeenCalledTimes(2);
  });

  it('auto-reconnects on close with exponential backoff', () => {
    const client = new WsClient({ token: 'at_live_test', reconnectJitter: false });
    client.connect();
    const ws1 = MockWebSocket.instances[0]!;
    ws1.simulateOpen();
    ws1.simulateClose();

    // First reconnect after 1s
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second close -> reconnect after 2s
    const ws2 = MockWebSocket.instances[1]!;
    ws2.simulateClose();
    vi.advanceTimersByTime(1999);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it('reconnects when connect fails with error before close', () => {
    const client = new WsClient({ token: 'at_live_test', reconnectJitter: false });
    client.connect();
    const ws1 = MockWebSocket.instances[0]!;

    ws1.onerror?.();

    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('disconnect() stops reconnection', () => {
    const client = new WsClient({ token: 'at_live_test' });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    client.disconnect();
    expect(ws.close).toHaveBeenCalled();

    // No reconnect after disconnect
    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('on() returns unsubscribe function', () => {
    const client = new WsClient({ token: 'at_live_test' });
    const handler = vi.fn();
    const unsub = client.on('message.created', handler);

    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.simulateMessage({ type: 'message.created', channel: 'general', message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] } });
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    ws.simulateMessage({ type: 'message.created', channel: 'general', message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('off() removes handler', () => {
    const client = new WsClient({ token: 'at_live_test' });
    const handler = vi.fn();
    client.on('pong', handler);

    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.simulateMessage({ type: 'pong' });
    expect(handler).toHaveBeenCalledTimes(1);

    client.off('pong', handler);
    ws.simulateMessage({ type: 'pong' });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('wildcard listener receives all events', () => {
    const client = new WsClient({ token: 'at_live_test' });
    const handler = vi.fn();
    client.on('*', handler);

    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    // 'open' synthetic event is also emitted to wildcard

    ws.simulateMessage({ type: 'message.created', channel: 'general', message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] } });
    ws.simulateMessage({ type: 'pong' });

    // open + message.created + pong = 3
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('ignores malformed messages', () => {
    const client = new WsClient({ token: 'at_live_test' });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    const handler = vi.fn();
    client.on('*', handler);

    // Send invalid JSON — should not emit anything
    ws.onmessage?.({ data: 'not json' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('forwards unrecognized event types to wildcard and typed listeners', () => {
    const client = new WsClient({ token: 'at_live_test' });
    const wildcardHandler = vi.fn();
    const typedHandler = vi.fn();
    client.on('*', wildcardHandler);
    client.on('typing.started', typedHandler);

    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.simulateMessage({ type: 'typing.started', agent_name: 'Alice', channel: 'general' });

    expect(wildcardHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'typing.started', agentName: 'Alice' }),
    );
    expect(typedHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'typing.started', agentName: 'Alice' }),
    );
  });

  it('ignores objects without a type field', () => {
    const client = new WsClient({ token: 'at_live_test' });
    const handler = vi.fn();
    client.on('*', handler);

    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    // Reset after open event
    handler.mockClear();

    ws.simulateMessage({ data: 'no type field' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('logs dropped messages with missing type when debug is enabled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new WsClient({ token: 'at_live_test', debug: true });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.simulateMessage({ data: 'no type field' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('missing or invalid "type"'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('logs malformed JSON when debug is enabled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new WsClient({ token: 'at_live_test', debug: true });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.onmessage?.({ data: 'not json' });
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('malformed'),
      expect.stringContaining('not json'),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it('does not log when debug is disabled', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = new WsClient({ token: 'at_live_test' });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.simulateMessage({ data: 'no type field' });
    ws.onmessage?.({ data: 'not json' });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('emits error event on WebSocket error', () => {
    const client = new WsClient({ token: 'at_live_test' });
    const handler = vi.fn();
    client.on('error', handler);

    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    ws.onerror?.();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('emits reconnecting event with attempt count', () => {
    const client = new WsClient({ token: 'at_live_test', reconnectJitter: false });
    const handler = vi.fn();
    client.on('reconnecting', handler);

    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reconnecting', attempt: 1 }),
    );

    // Advance timer to trigger reconnect, then close again
    vi.advanceTimersByTime(1000);
    const ws2 = MockWebSocket.instances[1]!;
    ws2.simulateClose();

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'reconnecting', attempt: 2 }),
    );
  });

  it('does not send if WebSocket is not open', () => {
    const client = new WsClient({ token: 'at_live_test' });
    // Don't connect, just try to subscribe
    client.subscribe(['general']);
    // No crash, no send
  });

  it('fires late open listeners immediately when already connected', async () => {
    const client = new WsClient({ token: 'at_live_test' });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();

    const handler = vi.fn();
    client.on('open', handler);
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ type: 'open' }));
  });

  it('applies jitter to reconnect delay when enabled', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const client = new WsClient({
      token: 'at_live_test',
      reconnectJitter: true,
      reconnectBaseDelayMs: 1000,
      reconnectMaxDelayMs: 30_000,
    });
    client.connect();
    const ws = MockWebSocket.instances[0]!;
    ws.simulateOpen();
    ws.simulateClose();

    vi.advanceTimersByTime(499);
    expect(MockWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    randomSpy.mockRestore();
  });

  it('emits permanently_disconnected after maxReconnectAttempts is reached', () => {
    const client = new WsClient({
      token: 'at_live_test',
      reconnectJitter: false,
      maxReconnectAttempts: 1,
    });
    const handler = vi.fn();
    client.on('permanently_disconnected', handler);

    client.connect();
    const ws1 = MockWebSocket.instances[0]!;
    ws1.simulateOpen();
    ws1.simulateClose();

    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances).toHaveLength(2);

    const ws2 = MockWebSocket.instances[1]!;
    ws2.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'permanently_disconnected', attempt: 1 }),
    );

    vi.advanceTimersByTime(60_000);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  describe('reconnect resync', () => {
    function sentFrames(ws: MockWebSocket): Array<Record<string, unknown>> {
      return ws.send.mock.calls.map(([data]) => JSON.parse(data as string));
    }

    function resyncFrames(ws: MockWebSocket): Array<Record<string, unknown>> {
      return sentFrames(ws).filter((frame) => frame.type === 'resync');
    }

    it('does not send a resync frame on first connection', () => {
      const client = new WsClient({ token: 'at_live_test' });
      client.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.simulateOpen();

      expect(resyncFrames(ws)).toHaveLength(0);
    });

    it('tracks agent_seq and sends resync with the highest seen seq on reconnect', () => {
      const client = new WsClient({ token: 'at_live_test', reconnectJitter: false });
      client.connect();
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateOpen();

      ws1.simulateMessage({
        type: 'message.created',
        channel: 'general',
        message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
        agent_seq: 1,
      });
      // Unrecognized event types still advance the seq cursor.
      ws1.simulateMessage({ type: 'typing.started', agent_name: 'Alice', agent_seq: 2 });
      ws1.simulateMessage({ type: 'pong' });

      ws1.simulateClose();
      vi.advanceTimersByTime(1000);

      const ws2 = MockWebSocket.instances[1]!;
      ws2.simulateOpen();

      const frames = resyncFrames(ws2);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ type: 'resync', last_seen_seq: 2 });
      expect(typeof frames[0]!.since).toBe('string');
      expect(Number.isNaN(new Date(frames[0]!.since as string).getTime())).toBe(false);
    });

    it('sends resync after open handlers have re-subscribed', () => {
      const client = new WsClient({ token: 'at_live_test', reconnectJitter: false });
      client.on('open', () => client.subscribe(['general']));
      client.connect();
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.simulateMessage({
        type: 'message.reacted',
        message_id: 'm_1',
        emoji: 'thumbsup',
        agent_name: 'Bot',
        action: 'added',
        agent_seq: 7,
      });
      ws1.simulateClose();
      vi.advanceTimersByTime(1000);

      const ws2 = MockWebSocket.instances[1]!;
      ws2.simulateOpen();

      const frames = sentFrames(ws2);
      expect(frames[0]).toMatchObject({ type: 'subscribe', channels: ['general'] });
      expect(frames[1]).toMatchObject({ type: 'resync', last_seen_seq: 7 });
    });

    it('does not send a resync frame on reconnect when no events were received', () => {
      const client = new WsClient({ token: 'at_live_test', reconnectJitter: false });
      client.connect();
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.simulateClose();
      vi.advanceTimersByTime(1000);

      const ws2 = MockWebSocket.instances[1]!;
      ws2.simulateOpen();

      expect(resyncFrames(ws2)).toHaveLength(0);
    });

    it('dispatches replayed events once, deduped by stable event id', () => {
      const client = new WsClient({ token: 'at_live_test', reconnectJitter: false });
      const handler = vi.fn();
      client.on('message.created', handler);
      client.connect();
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateOpen();

      const original = {
        id: 'evt-stable-1',
        type: 'message.created',
        channel: 'general',
        message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
        agent_seq: 1,
      };
      ws1.simulateMessage(original);
      expect(handler).toHaveBeenCalledTimes(1);

      ws1.simulateClose();
      vi.advanceTimersByTime(1000);
      const ws2 = MockWebSocket.instances[1]!;
      ws2.simulateOpen();

      // Server replays the same event (same stable id) plus a new one.
      ws2.simulateMessage(original);
      ws2.simulateMessage({
        id: 'evt-stable-2',
        type: 'message.created',
        channel: 'general',
        message: { id: 'm_2', agent_name: 'Bot', text: 'missed you', attachments: [] },
        agent_seq: 2,
        replayed: true,
      });

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenLastCalledWith(
        expect.objectContaining({ id: 'evt-stable-2' }),
      );
    });

    it('emits resynced with replay stats when the server acks a resync', () => {
      const client = new WsClient({ token: 'at_live_test' });
      const resyncedHandler = vi.fn();
      const wildcardHandler = vi.fn();
      client.on('resynced', resyncedHandler);
      client.on('*', wildcardHandler);
      client.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.simulateOpen();

      ws.simulateMessage({
        type: 'resync_ack',
        last_seen_seq: 5,
        current_seq: 9,
        replayed: 4,
        gap_detected: true,
      });

      expect(resyncedHandler).toHaveBeenCalledTimes(1);
      expect(resyncedHandler).toHaveBeenCalledWith({
        type: 'resynced',
        replayed: 4,
        gapDetected: true,
      });
      expect(wildcardHandler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'resynced' }),
      );
    });

    it('resyncs from the latest seq after multiple reconnects', () => {
      const client = new WsClient({ token: 'at_live_test', reconnectJitter: false });
      client.connect();
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.simulateMessage({
        type: 'message.reacted',
        message_id: 'm_1',
        emoji: 'eyes',
        agent_name: 'Bot',
        action: 'added',
        agent_seq: 3,
      });
      ws1.simulateClose();
      vi.advanceTimersByTime(1000);

      const ws2 = MockWebSocket.instances[1]!;
      ws2.simulateOpen();
      expect(resyncFrames(ws2)[0]).toMatchObject({ last_seen_seq: 3 });

      ws2.simulateMessage({
        type: 'message.reacted',
        message_id: 'm_2',
        emoji: 'eyes',
        agent_name: 'Bot',
        action: 'added',
        agent_seq: 8,
      });
      ws2.simulateClose();
      vi.advanceTimersByTime(1000);

      const ws3 = MockWebSocket.instances[2]!;
      ws3.simulateOpen();
      expect(resyncFrames(ws3)[0]).toMatchObject({ last_seen_seq: 8 });
    });
  });

  it('manual reconnect() opens a new socket after circuit breaker trip', () => {
    const client = new WsClient({
      token: 'at_live_test',
      reconnectJitter: false,
      maxReconnectAttempts: 0,
    });
    const handler = vi.fn();
    client.on('permanently_disconnected', handler);

    client.connect();
    const ws1 = MockWebSocket.instances[0]!;
    ws1.simulateOpen();
    ws1.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(1);

    client.reconnect();
    expect(MockWebSocket.instances).toHaveLength(2);
  });
});
