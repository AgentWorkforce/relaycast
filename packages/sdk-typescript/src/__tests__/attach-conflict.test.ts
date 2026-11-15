import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type AgentClientOptions } from '../agent.js';
import { HttpClient } from '../client.js';
import { conflictRetryDelayMs, readCloseEvent } from '../attach-conflict.js';

/**
 * Direct-node attach refusals (`provider_instance_conflict` / close 4009):
 * several clients of one agent share its implicit direct node, and the gateway
 * refuses the losers. A refused client must not announce itself as connected
 * and must back off for at least 30 s instead of superseding in a loop.
 */

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code: number; reason: string }) => void) | null = null;
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

  /** Server-side close; omit `code` to mimic runtimes that pass no event. */
  simulateClose(code?: number): void {
    this.readyState = MockWebSocket.CLOSED;
    if (code === undefined) this.onclose?.();
    else this.onclose?.({ code, reason: '' });
  }

  frames(): Record<string, unknown>[] {
    return this.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
  }

  register(): Record<string, unknown> {
    const register = this.frames().find((frame) => frame.type === 'node.register');
    expect(register).toBeDefined();
    return register!;
  }
}

const mockFetch = vi.fn();

function mockResponse(data: unknown = {}, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve({ ok: true, data }),
  });
}

function createAgent(options: AgentClientOptions = {}): AgentClient {
  const client = new HttpClient({ apiKey: 'at_live_test', baseUrl: 'http://localhost:8080' });
  return new AgentClient(client, {
    ...options,
    ws: { reconnectJitter: false, ...(options.ws ?? {}) },
  });
}

describe('conflictRetryDelayMs / readCloseEvent', () => {
  it('floors at 30s, honours retry_after_ms and retry_after, caps at 300s', () => {
    expect(conflictRetryDelayMs()).toBe(30_000);
    expect(conflictRetryDelayMs({})).toBe(30_000);
    expect(conflictRetryDelayMs({ retry_after_ms: 1_000 })).toBe(30_000);
    expect(conflictRetryDelayMs({ retry_after_ms: 45_000 })).toBe(45_000);
    expect(conflictRetryDelayMs({ retry_after: 90 })).toBe(90_000);
    expect(conflictRetryDelayMs({ retry_after_ms: 40_000, retry_after: 50 })).toBe(50_000);
    expect(conflictRetryDelayMs({ retry_after_ms: 10_000_000 })).toBe(300_000);
    expect(conflictRetryDelayMs({ retry_after: 3_600 })).toBe(300_000);
    expect(conflictRetryDelayMs({ retry_after_ms: -5, retry_after: 'soon' })).toBe(30_000);
    expect(conflictRetryDelayMs({ retry_after_ms: Number.NaN })).toBe(30_000);
  });

  it('tolerates runtimes that pass no close event', () => {
    expect(readCloseEvent(undefined)).toEqual({ code: null, reason: '' });
    expect(readCloseEvent({ code: 4009, reason: 'conflict' })).toEqual({ code: 4009, reason: 'conflict' });
    expect(readCloseEvent({ code: 'x' })).toEqual({ code: null, reason: '' });
  });
});

describe('AgentClient direct-node attach refusal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', mockFetch);
    MockWebSocket.instances = [];
    mockFetch.mockReset();
    mockFetch.mockImplementation((url: string) => {
      if (url.endsWith('/v1/agent/node-token')) {
        return mockResponse({ node_id: 'node_direct_agent_1', node_name: 'direct-agent-1', token: 'nt_live_direct_agent_1' });
      }
      return mockResponse({});
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function socketAt(index: number): Promise<MockWebSocket> {
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
      const socket = MockWebSocket.instances[index];
      if (socket) return socket;
    }
    throw new Error(`Mock WebSocket ${index} was not created`);
  }

  async function opened(index: number): Promise<MockWebSocket> {
    const ws = await socketAt(index);
    ws.simulateOpen();
    for (let i = 0; i < 20 && !ws.frames().some((f) => f.type === 'node.register'); i += 1) {
      await Promise.resolve();
    }
    return ws;
  }

  function accept(ws: MockWebSocket): void {
    const register = ws.register();
    ws.simulateMessage({
      v: 1, id: register.id, type: 'reply', ok: true,
      data: { provider: register.provider, accepted_capabilities: [] },
    });
  }

  function refuse(ws: MockWebSocket, extra: Record<string, unknown> = {}, code = 'provider_instance_conflict'): void {
    ws.simulateMessage({
      v: 1, id: ws.register().id, type: 'error', ok: false, code,
      message: 'another client holds this node', ...extra,
    });
  }

  /** Advance until just before `ms` and assert no new socket, then to `ms` and assert one. */
  async function expectReconnectAfter(ms: number, socketsBefore: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms - 1);
    expect(MockWebSocket.instances).toHaveLength(socketsBefore);
    await vi.advanceTimersByTimeAsync(1);
    await socketAt(socketsBefore);
    expect(MockWebSocket.instances).toHaveLength(socketsBefore + 1);
  }

  const heartbeatPosts = () => mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/agents/heartbeat'));

  it('sends a per-instance provider identity that is stable across reconnects', async () => {
    const agent = createAgent();
    agent.connect();
    const first = await opened(0);
    const provider = first.register().provider as { name: string; instance_id: string };
    expect(provider.name).toBe('default');
    expect(provider.instance_id).toMatch(/^sdk-./);
    accept(first);
    first.simulateClose();
    await vi.advanceTimersByTimeAsync(1_000);
    const second = await opened(1);
    expect(second.register().provider).toEqual(provider);

    const other = createAgent();
    other.connect();
    const otherSocket = await opened(2);
    expect((otherSocket.register().provider as { instance_id: string }).instance_id).not.toBe(provider.instance_id);
    agent.disconnect();
    other.disconnect();
  });

  it('refused register: no connected, no open hooks, rejection event, >=30s backoff', async () => {
    const agent = createAgent();
    const connected = vi.fn();
    const disconnected = vi.fn();
    const rejected = vi.fn();
    agent.on.connected(connected);
    agent.on.disconnected(disconnected);
    agent.on.registrationRejected(rejected);
    agent.connect();
    const first = await opened(0);
    refuse(first);
    await vi.advanceTimersByTimeAsync(0);

    expect(rejected).toHaveBeenCalledWith({
      code: 'provider_instance_conflict',
      message: 'another client holds this node',
      retryAfterMs: 30_000,
    });
    expect(first.close).not.toHaveBeenCalled(); // the server owns the close
    first.simulateClose(4009);
    await vi.advanceTimersByTimeAsync(0);

    expect(connected).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    expect(heartbeatPosts()).toHaveLength(0);
    expect(first.frames().some((f) => f.type === 'node.heartbeat')).toBe(false);

    await expectReconnectAfter(30_000, 1);
    // The refused attach still authenticated: the token is reused, not re-minted.
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/agent/node-token'))).toHaveLength(1);

    const second = await opened(1);
    accept(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(connected).toHaveBeenCalledTimes(1);
    expect(heartbeatPosts().length).toBeGreaterThan(0);
    agent.disconnect();
  });

  it('does not wait twice when the server holds the refused socket before closing', async () => {
    const agent = createAgent();
    agent.connect();
    const first = await opened(0);
    refuse(first);
    await vi.advanceTimersByTimeAsync(29_000);
    first.simulateClose(4009);
    await expectReconnectAfter(1_000, 1);
    agent.disconnect();
  });

  it('honours retry_after_ms and retry_after, capped at 300s', async () => {
    for (const [extra, expected] of [
      [{ retry_after_ms: 75_000 }, 75_000],
      [{ retry_after: 120 }, 120_000],
      [{ retry_after_ms: 9_999_999 }, 300_000],
    ] as const) {
      MockWebSocket.instances = [];
      const agent = createAgent();
      const rejected = vi.fn();
      agent.on.registrationRejected(rejected);
      agent.connect();
      const first = await opened(0);
      refuse(first, extra);
      expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ retryAfterMs: expected }));
      first.simulateClose(4009);
      await expectReconnectAfter(expected, 1);
      agent.disconnect();
    }
  });

  it('treats a bare 4009 close as a conflict and waits >=30s', async () => {
    const agent = createAgent();
    agent.connect();
    const first = await opened(0);
    first.simulateClose(4009);
    await expectReconnectAfter(30_000, 1);
    agent.disconnect();
  });

  it('closes client-side once the wait passes if the server never closes', async () => {
    const agent = createAgent();
    agent.connect();
    const first = await opened(0);
    refuse(first);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(first.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.close).toHaveBeenCalledTimes(1);
    // The refusal wait has already elapsed; the ordinary backoff applies now.
    await expectReconnectAfter(1_000, 1);
    agent.disconnect();
  });

  it('keeps backing off across refused registers and resets only on an accepted one', async () => {
    const agent = createAgent();
    agent.connect();
    // Non-conflict refusals: closed client-side at once, the backoff keeps growing
    // because opening the socket no longer resets the attempt counter.
    let ws = await opened(0);
    refuse(ws, {}, 'node_unavailable');
    expect(ws.close).toHaveBeenCalledTimes(1);
    await expectReconnectAfter(1_000, 1);
    ws = await opened(1);
    refuse(ws, {}, 'node_unavailable');
    await expectReconnectAfter(2_000, 2);
    ws = await opened(2);
    refuse(ws, {}, 'node_unavailable');
    await expectReconnectAfter(4_000, 3);

    ws = await opened(3);
    accept(ws);
    await vi.advanceTimersByTimeAsync(0);
    ws.simulateClose();
    await expectReconnectAfter(1_000, 4);
    agent.disconnect();
  });

  it('drops a socket whose node.register is never answered and reconnects with the normal backoff', async () => {
    const agent = createAgent({ ws: { debug: true } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const connected = vi.fn();
    const disconnected = vi.fn();
    agent.on.connected(connected);
    agent.on.disconnected(disconnected);
    agent.connect();
    let ws = await opened(0);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(ws.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(ws.close).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('[relaycast] node.register reply timed out', expect.anything());
    expect(connected).not.toHaveBeenCalled();
    expect(disconnected).not.toHaveBeenCalled();
    await expectReconnectAfter(1_000, 1);

    // The counter was not reset by the unanswered socket: the next one backs off further.
    ws = await opened(1);
    await vi.advanceTimersByTimeAsync(15_000);
    await expectReconnectAfter(2_000, 2);

    // An answered register clears the timer: the socket stays up past the timeout.
    ws = await opened(2);
    accept(ws);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ws.close).not.toHaveBeenCalled();
    expect(connected).toHaveBeenCalledTimes(1);
    expect(MockWebSocket.instances).toHaveLength(3);
    agent.disconnect();
    warn.mockRestore();
  });

  it('a refused register clears the reply timeout (the conflict wait governs)', async () => {
    const agent = createAgent();
    agent.connect();
    const first = await opened(0);
    refuse(first, { retry_after_ms: 60_000 });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(first.close).not.toHaveBeenCalled();
    agent.disconnect();
  });

  it('disconnect() while awaiting the register reply cancels the timeout', async () => {
    const agent = createAgent();
    agent.connect();
    await opened(0);
    agent.disconnect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('does not trip the circuit breaker while conflicts persist', async () => {
    const agent = createAgent({ ws: { circuitBreakerMaxAttempts: 2 } });
    const gaveUp = vi.fn();
    agent.on.permanentlyDisconnected(gaveUp);
    agent.connect();
    for (let i = 0; i < 4; i += 1) {
      const ws = await opened(i);
      refuse(ws);
      ws.simulateClose(4009);
      await expectReconnectAfter(30_000, i + 1);
    }
    expect(gaveUp).not.toHaveBeenCalled();
    agent.disconnect();
  });
});
