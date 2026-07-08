import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeProviderClient } from '../node-provider.js';

/**
 * A fake node-ws server: captures frames the client sends and lets the test
 * drive replies/invokes. Mirrors the engine's request/reply-over-node-socket
 * contract without any network.
 */
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
  sent: Record<string, unknown>[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  drop(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  sentOfType(type: string): Record<string, unknown>[] {
    return this.sent.filter((f) => f.type === type);
  }

  /** The last node.register frame, for driving an acceptance reply. */
  lastRegister(): Record<string, unknown> {
    return this.sentOfType('node.register').at(-1)!;
  }
}

function acceptAll(register: Record<string, unknown>) {
  const caps = (register.capabilities as { name: string; kind?: string }[]) ?? [];
  const provider = register.provider as { name: string; instance_id: string };
  return {
    v: 1,
    id: register.id,
    type: 'reply',
    ok: true,
    data: {
      provider,
      accepted_capabilities: caps.map((c) => ({ name: c.name, kind: c.kind ?? 'action', accepted: true })),
      name: register.name,
    },
  };
}

const baseOptions = {
  baseUrl: 'https://engine.test',
  nodeToken: 'nt_live_test',
  nodeId: 'node_a',
  nodeName: 'alpha',
  provider: { name: 'py' },
  reconnectJitter: false,
  reconnectBaseDelayMs: 10,
};

describe('NodeProviderClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function newSocket(): MockWebSocket {
    return MockWebSocket.instances.at(-1)!;
  }

  it('connects to /v1/node/ws with the node token and registers the provider', async () => {
    const node = new NodeProviderClient({ ...baseOptions, capabilities: { 'run-etl': async () => 'ok' } });
    node.serve();
    const sock = newSocket();
    const url = new URL(sock.url);
    expect(url.origin).toBe('wss://engine.test');
    expect(url.pathname).toBe('/v1/node/ws');
    expect(url.searchParams.get('token')).toBe('nt_live_test');

    sock.open();
    const register = sock.lastRegister();
    expect(register).toMatchObject({ type: 'node.register', name: 'alpha', node_id: 'node_a' });
    expect(register.provider).toMatchObject({ name: 'py' });
    expect((register.provider as { instance_id: string }).instance_id).toBeTruthy();
    expect(register.capabilities).toEqual([{ name: 'run-etl' }]);

    sock.emit(acceptAll(register));
    await expect(node.whenRegistered()).resolves.toBeTruthy();
    expect(node.connected).toBe(true);
  });

  it('hard-fails registration when a capability is rejected', async () => {
    const node = new NodeProviderClient({ ...baseOptions, capabilities: { 'run-etl': async () => 'ok' } });
    const served = node.serve();
    const sock = newSocket();
    sock.open();
    const register = sock.lastRegister();
    sock.emit({
      v: 1,
      id: register.id,
      type: 'reply',
      ok: true,
      data: {
        provider: register.provider,
        accepted_capabilities: [{ name: 'run-etl', kind: 'action', accepted: false, reason: 'duplicate action name' }],
      },
    });
    await expect(node.whenRegistered()).rejects.toThrow(/rejected.*run-etl.*duplicate action name/i);
    // serve() surfaces the same hard rejection.
    await expect(served).rejects.toThrow(/rejected/i);
  });

  it('hard-fails registration on an engine error frame (duplicate live instance)', async () => {
    const node = new NodeProviderClient(baseOptions);
    const served = node.serve();
    const sock = newSocket();
    sock.open();
    const register = sock.lastRegister();
    sock.emit({ v: 1, id: register.id, type: 'error', ok: false, code: 'provider_instance_conflict', message: 'already connected' });
    await expect(node.whenRegistered()).rejects.toMatchObject({ code: 'provider_instance_conflict' });
    await expect(served).rejects.toMatchObject({ code: 'provider_instance_conflict' });
  });

  it('runs a handler on action.invoke and replies with the output', async () => {
    const node = new NodeProviderClient({
      ...baseOptions,
      capabilities: { 'run-etl': async (input: unknown) => ({ echoed: input }) },
    });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'inv-1', action: 'run-etl', input: { rows: 3 } });
    await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
    expect(sock.sentOfType('action.result').at(-1)).toEqual({
      v: 1,
      type: 'action.result',
      invocation_id: 'inv-1',
      output: { echoed: { rows: 3 } },
    });
  });

  it('turns a handler throw into an error result and never drops the invocation', async () => {
    const node = new NodeProviderClient({
      ...baseOptions,
      capabilities: { 'run-etl': async () => { throw new Error('boom'); } },
    });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'inv-err', action: 'run-etl', input: {} });
    await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
    expect(sock.sentOfType('action.result').at(-1)).toEqual({
      v: 1,
      type: 'action.result',
      invocation_id: 'inv-err',
      error: 'boom',
    });
  });

  it('errors an invoke for an unknown action rather than dropping it', async () => {
    const node = new NodeProviderClient({ ...baseOptions, capabilities: { 'run-etl': async () => 'ok' } });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'inv-x', action: 'nope', input: {} });
    await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
    expect(sock.sentOfType('action.result').at(-1)).toMatchObject({ invocation_id: 'inv-x', error: expect.stringContaining('nope') });
  });

  it('sends provider-scoped heartbeats while serving', async () => {
    const node = new NodeProviderClient({ ...baseOptions, heartbeatIntervalMs: 1_000 });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    await vi.advanceTimersByTimeAsync(1_000);
    const hb = sock.sentOfType('node.heartbeat').at(-1)!;
    expect(hb).toMatchObject({ provider: { name: 'py' }, load: 0, active_agents: 0, handlers_live: true });
    expect(hb).not.toHaveProperty('last_heartbeat_at');
  });

  it('reconnects with a new instance id after an unexpected drop', async () => {
    const node = new NodeProviderClient(baseOptions);
    node.serve();
    const first = newSocket();
    first.open();
    const firstRegister = first.lastRegister();
    first.emit(acceptAll(firstRegister));
    await node.whenRegistered();
    const firstInstance = (firstRegister.provider as { instance_id: string }).instance_id;

    first.drop();
    await vi.advanceTimersByTimeAsync(50);
    const second = newSocket();
    expect(second).not.toBe(first);
    second.open();
    const secondRegister = second.lastRegister();
    const secondInstance = (secondRegister.provider as { instance_id: string }).instance_id;
    expect(secondRegister).toMatchObject({ name: 'alpha', provider: { name: 'py' } });
    expect(secondInstance).not.toBe(firstInstance);

    // The reconnected registration completes its lifecycle: accepting it brings
    // the provider back to connected.
    second.emit(acceptAll(secondRegister));
    await vi.waitFor(() => expect(node.connected).toBe(true));
  });

  it('hard-fails registration when the reply omits accepted_capabilities', async () => {
    const node = new NodeProviderClient({ ...baseOptions, capabilities: { 'run-etl': async () => 'ok' } });
    node.serve().catch(() => {});
    const sock = newSocket();
    sock.open();
    const register = sock.lastRegister();
    // A reply that confirms nothing about capability acceptance must not be
    // treated as success.
    sock.emit({ v: 1, id: register.id, type: 'reply', ok: true, data: { provider: register.provider } });
    await expect(node.whenRegistered()).rejects.toMatchObject({ code: 'invalid_register_reply' });
  });

  it('reconnects after a transport drop during the register handshake', async () => {
    const node = new NodeProviderClient(baseOptions);
    // A transient handshake drop must not hard-fail serve(); the reconnect below
    // succeeding (whenRegistered resolves) is the assertion.
    node.serve().catch(() => {});
    const first = newSocket();
    first.open();
    expect(first.sentOfType('node.register')).toHaveLength(1);

    // Drop before replying to node.register.
    first.drop();
    await vi.advanceTimersByTimeAsync(50);
    const second = newSocket();
    expect(second).not.toBe(first);
    second.open();
    expect(second.sentOfType('node.register')).toHaveLength(1);

    second.emit(acceptAll(second.lastRegister()));
    await node.whenRegistered();
    expect(node.connected).toBe(true);
  });

  it('rejects whenRegistered when reconnects are exhausted before registering', async () => {
    const node = new NodeProviderClient({ ...baseOptions, maxReconnectAttempts: 1 });
    node.serve().catch(() => {});
    const first = newSocket();
    first.open();
    first.drop(); // dropped mid-handshake -> reconnect
    await vi.advanceTimersByTimeAsync(50);
    const second = newSocket();
    second.open();
    second.drop(); // second attempt drops -> reconnects exhausted
    await vi.advanceTimersByTimeAsync(50);
    await expect(node.whenRegistered()).rejects.toThrow(/exhausted/i);
  });

  it('deregisters the provider on graceful stop', async () => {
    const node = new NodeProviderClient(baseOptions);
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    await node.stop();
    expect(sock.sentOfType('node.deregister').at(-1)).toMatchObject({ provider: { name: 'py' } });
  });

  it('ctx.spawnAgent sends a capacity-direct node.spawn frame and resolves with the reply', async () => {
    let spawnResult: unknown;
    const node = new NodeProviderClient({
      ...baseOptions,
      capabilities: {
        'spawn:claude': {
          kind: 'action',
          handler: async (input: unknown, ctx) => {
            spawnResult = await ctx.spawnAgent({ cli: 'claude', name: 'worker-1' });
            return spawnResult;
          },
        },
      },
    });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'inv-spawn', action: 'spawn:claude', input: {} });
    await vi.waitFor(() => expect(sock.sentOfType('node.spawn')).toHaveLength(1));
    const spawn = sock.sentOfType('node.spawn').at(-1)!;
    // Capacity-direct: the frame carries no node target; the engine uses the
    // connection's own node.
    expect(spawn).toMatchObject({ input: { cli: 'claude', name: 'worker-1' } });
    expect(spawn).not.toHaveProperty('target_node_id');

    sock.emit({ v: 1, id: spawn.id, type: 'reply', ok: true, data: { invocation_id: 'spawned-1', status: 'dispatched' } });
    await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
    expect(spawnResult).toMatchObject({ invocation_id: 'spawned-1' });
  });

  it('ctx.sendMessage posts to the canonical channel route with the node token', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 201, json: async () => ({ data: { id: 'm-1', text: 'done' } }) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    let posted: unknown;
    const node = new NodeProviderClient({
      ...baseOptions,
      capabilities: {
        'run-etl': async (_input: unknown, ctx) => {
          posted = await ctx.sendMessage({ to: 'ops', from: 'reporter', text: 'done' });
          return posted;
        },
      },
    });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'inv-msg', action: 'run-etl', input: {} });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const call = calls[0]!;
    expect(call.url).toBe('https://engine.test/v1/channels/ops/messages');
    expect((call.init.headers as Record<string, string>).authorization).toBe('Bearer nt_live_test');
    expect(JSON.parse(call.init.body as string)).toEqual({ text: 'done', from: 'reporter' });

    await vi.waitFor(() => expect(posted).toBeTruthy());
    expect(posted).toMatchObject({ id: 'm-1' });
    // No node.message frame is sent over the socket — posting is HTTP now.
    expect(sock.sentOfType('node.message')).toHaveLength(0);
  });
});
