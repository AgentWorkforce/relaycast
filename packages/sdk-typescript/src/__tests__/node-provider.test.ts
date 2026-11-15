import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NodeProviderClient } from '../node-provider.js';
import {
  FLEET_ACTION_CALLER_METADATA_KEY,
  FLEET_ACTION_CALLER_METADATA_VERSION,
} from '@relaycast/types';

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
  onclose: ((event?: { code: number; reason: string }) => void) | null = null;
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

  /** Server-side close; omit `code` to mimic runtimes that pass no close event. */
  drop(code?: number): void {
    this.readyState = MockWebSocket.CLOSED;
    if (code === undefined) this.onclose?.();
    else this.onclose?.({ code, reason: '' });
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
    expect(register.capabilities).toEqual([{
      name: 'run-etl',
      metadata: {
        [FLEET_ACTION_CALLER_METADATA_KEY]: FLEET_ACTION_CALLER_METADATA_VERSION,
      },
    }]);

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

  it('hard-fails registration on a non-retryable engine error frame', async () => {
    const node = new NodeProviderClient(baseOptions);
    const served = node.serve();
    const sock = newSocket();
    sock.open();
    const register = sock.lastRegister();
    sock.emit({ v: 1, id: register.id, type: 'error', ok: false, code: 'node_not_enrolled', message: 'unknown node' });
    await expect(node.whenRegistered()).rejects.toMatchObject({ code: 'node_not_enrolled' });
    await expect(served).rejects.toMatchObject({ code: 'node_not_enrolled' });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it('reconnects when the node.register reply never arrives', async () => {
    const errors: Error[] = [];
    const node = new NodeProviderClient({ ...baseOptions, onError: (err) => errors.push(err) });
    let settled = false;
    void node.serve().then(() => { settled = true; }, () => { settled = true; });
    const first = newSocket();
    first.open();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(first.readyState).toBe(MockWebSocket.OPEN);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.readyState).toBe(MockWebSocket.CLOSED);
    expect(errors.at(-1)?.message).toBe('node.register reply timed out');
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(MockWebSocket.instances).toHaveLength(2);

    const second = newSocket();
    second.open();
    second.emit(acceptAll(second.lastRegister()));
    await expect(node.whenRegistered()).resolves.toBeTruthy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(second.readyState).toBe(MockWebSocket.OPEN);
    expect(MockWebSocket.instances).toHaveLength(2);
    await node.stop();
  });

  describe('provider_instance_conflict refusal', () => {
    function refuse(sock: MockWebSocket, extra: Record<string, unknown> = {}): void {
      const register = sock.lastRegister();
      sock.emit({
        v: 1,
        id: register.id,
        type: 'error',
        ok: false,
        code: 'provider_instance_conflict',
        message: 'another instance is attached',
        ...extra,
      });
    }

    it('keeps serving, does not close client-side, and re-attaches no sooner than 30s', async () => {
      const errors: Error[] = [];
      const node = new NodeProviderClient({ ...baseOptions, onError: (err) => errors.push(err) });
      let settled = false;
      void node.serve().then(() => { settled = true; }, () => { settled = true; });
      let registered = false;
      void node.whenRegistered().then(() => { registered = true; }, () => { registered = true; });
      const first = newSocket();
      first.open();
      refuse(first);
      await vi.advanceTimersByTimeAsync(0);

      expect(errors.at(-1)).toMatchObject({ code: 'provider_instance_conflict', retryAfterMs: 30_000 });
      expect(first.readyState).toBe(MockWebSocket.OPEN); // the server owns the close
      expect(settled).toBe(false);
      expect(registered).toBe(false);

      // The gateway closes with 4009 right away; the wait still runs from the refusal.
      first.drop(4009);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(MockWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(2);

      const second = newSocket();
      second.open();
      second.emit(acceptAll(second.lastRegister()));
      await expect(node.whenRegistered()).resolves.toBeTruthy();
      expect(settled).toBe(false);
      await node.stop();
    });

    it('does not add a second wait when the server holds the socket before closing 4009', async () => {
      const node = new NodeProviderClient({ ...baseOptions, onError: () => {} });
      void node.serve().catch(() => {});
      const first = newSocket();
      first.open();
      refuse(first);
      await vi.advanceTimersByTimeAsync(29_000);
      first.drop(4009);
      await vi.advanceTimersByTimeAsync(999);
      expect(MockWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(2);
      await node.stop();
    });

    it('honours retry_after_ms / retry_after and caps the wait at 300s', async () => {
      for (const [extra, expected] of [
        [{ retry_after_ms: 45_000 }, 45_000],
        [{ retry_after: 60 }, 60_000],
        [{ retry_after_ms: 5_000 }, 30_000],
        [{ retry_after_ms: 10_000_000 }, 300_000],
      ] as const) {
        MockWebSocket.instances = [];
        const errors: Error[] = [];
        const node = new NodeProviderClient({ ...baseOptions, onError: (err) => errors.push(err) });
        void node.serve().catch(() => {});
        const first = newSocket();
        first.open();
        refuse(first, extra);
        await vi.advanceTimersByTimeAsync(0);
        expect(errors.at(-1)).toMatchObject({ retryAfterMs: expected });
        first.drop(4009);
        await vi.advanceTimersByTimeAsync(expected - 1);
        expect(MockWebSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(MockWebSocket.instances).toHaveLength(2);
        await node.stop();
      }
    });

    it('closes client-side once the wait passes if the server never closes', async () => {
      const node = new NodeProviderClient({ ...baseOptions, onError: () => {} });
      void node.serve().catch(() => {});
      const first = newSocket();
      first.open();
      refuse(first);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(first.readyState).toBe(MockWebSocket.OPEN);
      await vi.advanceTimersByTimeAsync(1);
      expect(first.readyState).toBe(MockWebSocket.CLOSED);
      // The deadline has already passed, so the reconnect uses the ordinary backoff.
      await vi.advanceTimersByTimeAsync(10);
      expect(MockWebSocket.instances).toHaveLength(2);
      await node.stop();
    });

    it('treats a bare 4009 close (no error frame) as a conflict and waits 30s', async () => {
      const node = new NodeProviderClient({ ...baseOptions, onError: () => {} });
      void node.serve().catch(() => {});
      const first = newSocket();
      first.open();
      first.drop(4009);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(MockWebSocket.instances).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(MockWebSocket.instances).toHaveLength(2);
      await node.stop();
    });

    it('stop() during the refusal wait cancels the client-side close and the reconnect', async () => {
      const node = new NodeProviderClient({ ...baseOptions, onError: () => {} });
      const served = node.serve();
      const first = newSocket();
      first.open();
      refuse(first);
      await vi.advanceTimersByTimeAsync(0);
      await node.stop();
      await expect(served).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(600_000);
      expect(MockWebSocket.instances).toHaveLength(1);
    });
  });

  it('runs a handler on action.invoke and replies with the output', async () => {
    let handlerContext: unknown;
    const node = new NodeProviderClient({
      ...baseOptions,
      capabilities: {
        'run-etl': async (input: unknown, context) => {
          handlerContext = context;
          return { echoed: input };
        },
      },
    });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    sock.emit({
      v: 1,
      type: 'action.invoke',
      invocation_id: 'inv-1',
      action: 'run-etl',
      caller_id: 'agent-caller',
      caller_name: 'listener',
      input: { rows: 3 },
    });
    await vi.waitFor(() => expect(sock.sentOfType('action.result')).toHaveLength(1));
    expect(handlerContext).toMatchObject({
      invocationId: 'inv-1',
      callerAgentId: 'agent-caller',
      callerAgentName: 'listener',
    });
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

  it('sends provider-scoped heartbeats without inventing finite-capacity load', async () => {
    const node = new NodeProviderClient({ ...baseOptions, maxAgents: 4, heartbeatIntervalMs: 1_000 });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    await vi.advanceTimersByTimeAsync(1_000);
    const hb = sock.sentOfType('node.heartbeat').at(-1)!;
    expect(hb).toMatchObject({ provider: { name: 'py' }, active_agents: 0, handlers_live: true });
    expect(hb).not.toHaveProperty('load');
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

  it('hard-fails registration when the reply omits a requested capability', async () => {
    const node = new NodeProviderClient({
      ...baseOptions,
      capabilities: { 'run-etl': async () => 'ok', deploy: async () => 'ok' },
    });
    node.serve().catch(() => {});
    const sock = newSocket();
    sock.open();
    const register = sock.lastRegister();
    // Only run-etl is acknowledged; deploy is silently missing.
    sock.emit({
      v: 1, id: register.id, type: 'reply', ok: true,
      data: { provider: register.provider, accepted_capabilities: [{ name: 'run-etl', kind: 'action', accepted: true }] },
    });
    await expect(node.whenRegistered()).rejects.toMatchObject({ code: 'invalid_register_reply' });
  });

  it('validates registration against the capabilities sent, not later additions', async () => {
    const node = new NodeProviderClient({ ...baseOptions, capabilities: { 'run-etl': async () => 'ok' } });
    node.serve().catch(() => {});
    const sock = newSocket();
    sock.open();
    const register = sock.lastRegister();
    // A capability added AFTER the register frame was sent isn't in this reply.
    node.capability('late', async () => 'ok');
    sock.emit(acceptAll(register)); // acknowledges only run-etl (what was sent)
    await expect(node.whenRegistered()).resolves.toBeTruthy();
  });

  it('rejects whenRegistered when stopped before registration completes', async () => {
    const node = new NodeProviderClient(baseOptions);
    node.serve().catch(() => {});
    const sock = newSocket();
    sock.open();
    // node.register was sent but no acceptance reply has arrived yet.
    await node.stop();
    await expect(node.whenRegistered()).rejects.toThrow(/stopped/i);
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

  it('ctx.sendMessage normalizes a ws base URL to http and encodes the channel', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return { ok: true, status: 201, json: async () => ({ data: { id: 'm' } }) } as unknown as Response;
    }));

    const node = new NodeProviderClient({
      ...baseOptions,
      baseUrl: 'wss://engine.test',
      capabilities: { 'run-etl': async (_i: unknown, ctx) => ctx.sendMessage({ to: 'team/alpha', from: 'reporter', text: 'x' }) },
    });
    node.serve();
    const sock = newSocket();
    sock.open();
    sock.emit(acceptAll(sock.lastRegister()));
    await node.whenRegistered();

    sock.emit({ v: 1, type: 'action.invoke', invocation_id: 'i', action: 'run-etl', input: {} });
    await vi.waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toBe('https://engine.test/v1/channels/team%2Falpha/messages');
  });
});
