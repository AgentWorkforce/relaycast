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
    expect(url.origin).toBe('wss://api.relaycast.dev');
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
      baseUrl: 'https://pr28-api.relaycast.dev/',
    });
    client.connect();

    const url = new URL(MockWebSocket.instances[0]!.url);
    expect(url.origin).toBe('wss://pr28-api.relaycast.dev');
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
    const client = new WsClient({ token: 'at_live_test' });
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
    const client = new WsClient({ token: 'at_live_test' });
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
      expect.objectContaining({ type: 'typing.started', agent_name: 'Alice' }),
    );
    expect(typedHandler).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'typing.started', agent_name: 'Alice' }),
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
    const client = new WsClient({ token: 'at_live_test' });
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
});
