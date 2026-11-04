import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient, type AgentClientOptions } from '../agent.js';
import { stableRelaycastEventId } from '../event-id.js';
import { HttpClient } from '../client.js';
import type { AgentExitedEvent } from '../types.js';

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

  it('keeps direct-node heartbeat load explicitly unreported', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    await vi.advanceTimersByTimeAsync(30_000);
    const frames = ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)) as Record<string, unknown>);
    const heartbeat = frames.find((frame) => frame.type === 'node.heartbeat');

    expect(heartbeat).toMatchObject({ load: null, active_agents: 1, handlers_live: false });
    expect(heartbeat).not.toHaveProperty('load_reported');
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
          created_at: '2026-09-24T05:00:00.000Z',
          channel_name: 'general',
          agent_id: 'bot_1',
          from_name: 'Bot',
          text: 'hi',
          attachments: [],
          metadata: { relayflow: { version: 1 } },
        },
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message.created',
        createdAt: '2026-09-24T05:00:00.000Z',
        channel: 'general',
        message: expect.objectContaining({ metadata: { relayflow: { version: 1 } } }),
      }),
    );
    // The ack follows the handlers' completion, not the dispatch.
    expect(ws.send.mock.calls.map(([p]) => JSON.parse(String(p)).type)).not.toContain('delivery.ack');
    await settleDeliveries();
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      v: 1,
      type: 'delivery.ack',
      agent: 'worker',
      up_to_seq: 1,
    }));
  });

  /** The engine's reply to this socket's `node.register`, listing the frames it understands. */
  async function replyToRegistration(ws: MockWebSocket, capabilities?: string[]): Promise<void> {
    for (let i = 0; i < 10 && !ws.send.mock.calls.some(([p]) => JSON.parse(String(p)).type === 'node.register'); i += 1) {
      await Promise.resolve();
    }
    const register = ws.send.mock.calls.map(([p]) => JSON.parse(String(p))).find((frame) => frame.type === 'node.register');
    expect(register).toBeDefined();
    ws.simulateMessage({
      v: 1, id: register.id, type: 'reply', ok: true,
      data: {
        provider: { name: 'default', instance_id: 'i1' }, accepted_capabilities: [],
        ...(capabilities ? { capabilities } : {}),
      },
    });
  }

  /** A `deliver` frame for `agent` at its `seq`; `key` names the row (`del_<key>`) and, by default, the message (`m_<key>`). */
  const deliverFrameFor = (agent: string, seq: number, key = String(seq), messageId = `m_${key}`) => ({
    v: 1,
    type: 'deliver',
    delivery_id: `del_${key}`,
    agent_id: 'agent_1',
    agent,
    msg_id: messageId,
    seq,
    mode: 'wait',
    payload: {
      type: 'dm.received',
      data: {
        conversation_id: 'dm_1', id: messageId, from_agent_id: 'bot_1', from_name: 'Bot', to: agent,
        text: 'confirm me', created_at: '2026-09-24T05:00:00.000Z', attachments: [], metadata: {},
        message: { id: messageId, agent_id: 'bot_1', agent_name: 'Bot', text: 'confirm me', attachments: [], metadata: {} },
      },
    },
  });
  const deliverFrame = (seq: number) => deliverFrameFor('worker', seq);

  /** Settle the transport's ordered deliver chain (acceptance hooks resolve on microtasks). */
  async function settleDeliveries(): Promise<void> {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  }

  const sentTypes = (ws: MockWebSocket) => ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)).type as string);
  const sentFrames = (ws: MockWebSocket, type: string) =>
    ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload))).filter((frame) => frame.type === type);
  const ack = (agent: string, form: { up_to_seq: number } | { delivery_id: string }) => ({ v: 1, type: 'delivery.ack', agent, ...form });
  const accepted = (agent: string, form: { up_to_seq: number } | { delivery_id: string }) => ({ v: 1, type: 'delivery.accepted', agent, ...form });

  it('sends no delivery.accepted without a persistence hook, even when the engine lists the capability', async () => {
    const handler = vi.fn();
    for (const ws of [
      { autoAcceptDeliveries: true },           // asked for, but nothing persists: stay honest
      { acceptDelivery: async () => {} },       // a hook alone does not opt in
      {},
    ] as const) {
      MockWebSocket.instances = [];
      const agent = createAgent({ ws });
      agent.on.dmReceived(handler);
      agent.connect();
      const socket = await nextSocket();
      socket.simulateOpen();
      await replyToRegistration(socket, ['delivery.accepted']);

      socket.simulateMessage(deliverFrame(3));
      await settleDeliveries();

      const sent = socket.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
      expect(sent.filter((frame) => frame.type === 'delivery.accepted')).toEqual([]);
      expect(sent.filter((frame) => frame.type === 'delivery.ack')).toEqual([
        { v: 1, type: 'delivery.ack', agent: 'worker', up_to_seq: 3 },
      ]);
    }
    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('sends no delivery.accepted when the engine did not list the capability, but still acks', async () => {
    const agent = createAgent({ ws: { autoAcceptDeliveries: true, acceptDelivery: async () => {} } });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(3));
    await settleDeliveries();

    const sent = ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
    expect(sent.filter((frame) => frame.type === 'delivery.accepted')).toEqual([]);
    expect(sent.filter((frame) => frame.type === 'delivery.ack')).toEqual([
      { v: 1, type: 'delivery.ack', agent: 'worker', up_to_seq: 3 },
    ]);
  });

  it('accepts only after the persistence hook resolved, before any handler runs, and acks after dispatch', async () => {
    const order: string[] = [];
    let release!: () => void;
    const stored = new Promise<void>((resolve) => { release = resolve; });
    const acceptDelivery = vi.fn(async (delivery: { deliveryId: string; seq: number }) => {
      order.push(`hook:${delivery.deliveryId}`);
      await stored;
      order.push('stored');
    });
    const agent = createAgent({ ws: { autoAcceptDeliveries: true, acceptDelivery } });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws, ['delivery.accepted']);

    const framesWhenHandled: string[] = [];
    agent.on.dmReceived(() => {
      order.push('handler');
      framesWhenHandled.push(...sentTypes(ws));
    });

    ws.simulateMessage(deliverFrame(7));
    await settleDeliveries();
    // Nothing is claimed while the store is still writing.
    expect(acceptDelivery).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'del_7', agent: 'worker', messageId: 'm_7', seq: 7, mode: 'wait' }));
    expect(sentTypes(ws)).not.toContain('delivery.accepted');
    expect(order).toEqual(['hook:del_7']);

    release();
    await settleDeliveries();
    expect(order).toEqual(['hook:del_7', 'stored', 'handler']);

    // The acceptance was already on the wire when the handler ran; the ack was not.
    expect(framesWhenHandled).toContain('delivery.accepted');
    expect(framesWhenHandled).not.toContain('delivery.ack');
    const sent = ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
    expect(sent.filter((frame) => frame.type === 'delivery.accepted')).toEqual([
      { v: 1, type: 'delivery.accepted', agent: 'worker', up_to_seq: 7 },
    ]);
    expect(sent.findIndex((frame) => frame.type === 'delivery.accepted'))
      .toBeLessThan(sent.findIndex((frame) => frame.type === 'delivery.ack'));
    expect(sent.filter((frame) => frame.type === 'delivery.ack')).toEqual([
      { v: 1, type: 'delivery.ack', agent: 'worker', up_to_seq: 7 },
    ]);
  });

  it('neither accepts, dispatches nor acks a delivery whose persistence hook rejected; later frames still flow per delivery', async () => {
    const handler = vi.fn();
    const failing = new Set([8]);
    const acceptDelivery = vi.fn(async (delivery: { seq: number }) => {
      if (failing.has(delivery.seq)) throw new Error('disk full');
    });
    const agent = createAgent({ ws: { autoAcceptDeliveries: true, acceptDelivery } });
    agent.on.dmReceived(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws, ['delivery.accepted']);

    ws.simulateMessage(deliverFrame(8));
    ws.simulateMessage(deliverFrame(9));
    await settleDeliveries();

    // 8 was never stored: the server keeps it for re-delivery. 9 was, but a
    // gap is open below it, so both its receipts name the row, never a watermark.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0]).toMatchObject({ message: { id: 'm_9' } });
    let sent = ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
    expect(sent.filter((frame) => frame.type === 'delivery.accepted')).toEqual([
      { v: 1, type: 'delivery.accepted', agent: 'worker', delivery_id: 'del_9' },
    ]);
    expect(sent.filter((frame) => frame.type === 'delivery.ack')).toEqual([
      { v: 1, type: 'delivery.ack', agent: 'worker', delivery_id: 'del_9' },
    ]);

    // The server re-delivers 8; once it persists, the watermark closes over 9.
    failing.clear();
    ws.simulateMessage(deliverFrame(8));
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(2);
    sent = ws.send.mock.calls.map(([payload]) => JSON.parse(String(payload)));
    expect(sent.filter((frame) => frame.type === 'delivery.accepted').at(-1)).toEqual(
      { v: 1, type: 'delivery.accepted', agent: 'worker', up_to_seq: 9 },
    );
    expect(sent.filter((frame) => frame.type === 'delivery.ack').at(-1)).toEqual(
      { v: 1, type: 'delivery.ack', agent: 'worker', up_to_seq: 9 },
    );
  });

  it('acks only after every handler settled, never a delivery whose handler rejected', async () => {
    let release!: () => void;
    const working = new Promise<void>((resolve) => { release = resolve; });
    const agent = createAgent();
    agent.on.dmReceived(async (event) => {
      if (event.message.id === 'm_2') throw new Error('model crashed');
      await working;
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(1));
    await settleDeliveries();
    expect(sentTypes(ws)).not.toContain('delivery.ack');
    release();
    await settleDeliveries();
    let acks = ws.send.mock.calls.map(([p]) => JSON.parse(String(p))).filter((f) => f.type === 'delivery.ack');
    expect(acks).toEqual([{ v: 1, type: 'delivery.ack', agent: 'worker', up_to_seq: 1 }]);

    // 2 rejects: unconsumed, held on the server. 3 succeeds behind the gap: per-delivery ack.
    ws.simulateMessage(deliverFrame(2));
    ws.simulateMessage(deliverFrame(3));
    await settleDeliveries();
    acks = ws.send.mock.calls.map(([p]) => JSON.parse(String(p))).filter((f) => f.type === 'delivery.ack');
    expect(acks).toEqual([
      { v: 1, type: 'delivery.ack', agent: 'worker', up_to_seq: 1 },
      { v: 1, type: 'delivery.ack', agent: 'worker', delivery_id: 'del_3' },
    ]);
  });

  it('keeps processing later deliveries when a handler throws synchronously, without acking the failed one', async () => {
    const seen: string[] = [];
    const agent = createAgent();
    agent.on.dmReceived((event) => {
      seen.push(event.message.id);
      if (event.message.id === 'm_1') throw new Error('sync boom');
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(1));
    ws.simulateMessage(deliverFrame(2));
    ws.simulateMessage(deliverFrame(3));
    await settleDeliveries();

    expect(seen).toEqual(['m_1', 'm_2', 'm_3']);
    const acks = ws.send.mock.calls.map(([p]) => JSON.parse(String(p))).filter((f) => f.type === 'delivery.ack');
    expect(acks).toEqual([
      { v: 1, type: 'delivery.ack', agent: 'worker', delivery_id: 'del_2' },
      { v: 1, type: 'delivery.ack', agent: 'worker', delivery_id: 'del_3' },
    ]);
  });

  it("ackMode 'on-receipt' keeps the legacy synchronous cumulative ack whatever the handler does", async () => {
    const agent = createAgent({ ws: { ackMode: 'on-receipt' } });
    agent.on.dmReceived(async () => { throw new Error('ignored by legacy mode'); });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(5));
    expect(ws.send.mock.calls.map(([p]) => JSON.parse(String(p))).filter((f) => f.type === 'delivery.ack')).toEqual([
      { v: 1, type: 'delivery.ack', agent: 'worker', up_to_seq: 5 },
    ]);
    await settleDeliveries();
  });

  it('reruns the handlers of a delivery whose handler rejected when the server re-delivers it, and acks only after that run resolved', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const retried = new Promise<void>((resolve) => { release = resolve; });
    const agent = createAgent();
    agent.on.dmReceived(async (event) => {
      calls.push(event.message.id);
      if (calls.length === 1) throw new Error('model crashed');
      await retried;
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(4));
    await settleDeliveries();
    expect(calls).toEqual(['m_4']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);

    // The same row comes back (same delivery_id, msg_id and seq): the failed
    // run did not mark it seen, so the handler runs again with the message.
    ws.simulateMessage(deliverFrame(4));
    await settleDeliveries();
    expect(calls).toEqual(['m_4', 'm_4']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);

    release();
    await settleDeliveries();
    expect(calls).toHaveLength(2);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([ack('worker', { up_to_seq: 4 })]);
  });

  it('reruns the handlers of a delivery whose handler threw synchronously when the server re-delivers it', async () => {
    const handler = vi.fn((event: { message: { id: string } }) => {
      if (handler.mock.calls.length === 1) throw new Error(`sync boom for ${event.message.id}`);
    });
    const agent = createAgent();
    agent.on.dmReceived(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(4));
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);

    ws.simulateMessage(deliverFrame(4));
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]![0]).toMatchObject({ message: { id: 'm_4' } });
    expect(sentFrames(ws, 'delivery.ack')).toEqual([ack('worker', { up_to_seq: 4 })]);
  });

  it('acks a re-delivered frame whose handlers already succeeded without running them again', async () => {
    const handler = vi.fn();
    const agent = createAgent();
    agent.on.dmReceived(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(6));
    await settleDeliveries();
    ws.simulateMessage(deliverFrame(6));
    await settleDeliveries();

    // Consumed once; the duplicate is confirmed by name since the watermark already covers it.
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([
      ack('worker', { up_to_seq: 6 }),
      ack('worker', { delivery_id: 'del_6' }),
    ]);
  });

  it('re-runs the persistence hook and the handlers of a re-delivered frame whose handler failed after acceptance', async () => {
    const order: string[] = [];
    const acceptDelivery = vi.fn(async (delivery: { deliveryId: string }) => { order.push(`hook:${delivery.deliveryId}`); });
    const agent = createAgent({ ws: { autoAcceptDeliveries: true, acceptDelivery } });
    const handler = vi.fn(() => {
      order.push(`handler:${sentTypes(ws).filter((type) => type === 'delivery.ack').length} acks so far`);
      if (handler.mock.calls.length === 1) throw new Error('model crashed');
    });
    agent.on.dmReceived(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws, ['delivery.accepted']);

    ws.simulateMessage(deliverFrame(3));
    await settleDeliveries();
    expect(sentFrames(ws, 'delivery.accepted')).toEqual([{ v: 1, type: 'delivery.accepted', agent: 'worker', up_to_seq: 3 }]);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);

    // Nothing is cached across the failure: the hook stores the row again
    // (the engine accepts an accepted row idempotently) and the handler
    // reruns before the ack.
    ws.simulateMessage(deliverFrame(3));
    await settleDeliveries();
    expect(order).toEqual(['hook:del_3', 'handler:0 acks so far', 'hook:del_3', 'handler:0 acks so far']);
    expect(sentFrames(ws, 'delivery.accepted')).toEqual([
      { v: 1, type: 'delivery.accepted', agent: 'worker', up_to_seq: 3 },
      { v: 1, type: 'delivery.accepted', agent: 'worker', delivery_id: 'del_3' },
    ]);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([ack('worker', { up_to_seq: 3 })]);
  });

  it('shares the outcome of a run still in flight with a duplicate frame: acks when it succeeds, reruns when it fails', async () => {
    const outcomes = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();
    const handler = vi.fn((event: { message: { id: string } }) => new Promise<void>((resolve, reject) => {
      outcomes.set(event.message.id, { resolve, reject });
    }));
    // 'on-receipt' returns from the deliver chain before the handlers settle,
    // so a duplicate can arrive while the first run is still going.
    const agent = createAgent({ ws: { ackMode: 'on-receipt' } });
    agent.on.dmReceived(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(1));
    ws.simulateMessage(deliverFrame(1));
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(1);
    outcomes.get('m_1')!.resolve();
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(1);

    ws.simulateMessage(deliverFrame(2));
    ws.simulateMessage(deliverFrame(2));
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(2);
    outcomes.get('m_2')!.reject(new Error('model crashed'));
    await settleDeliveries();
    // The duplicate waited for the first run and, as it failed, ran the handlers itself.
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls[2]![0]).toMatchObject({ message: { id: 'm_2' } });
    outcomes.get('m_2')!.resolve();
    await settleDeliveries();
  });

  it('drops confirmations from the previous connection after a reconnect instead of applying them to the new watermark', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const working = new Promise<void>((resolve) => { release = resolve; });
    const failing = new Set(['m_8']);
    const agent = createAgent();
    agent.on.dmReceived(async (event) => {
      calls.push(event.message.id);
      if (failing.delete(event.message.id)) throw new Error('model crashed');
      if (event.message.id === 'm_9' && calls.filter((id) => id === 'm_9').length === 1) await working;
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    // 8 fails (unacked); 9's handler is still running when the socket drops.
    ws.simulateMessage(deliverFrame(8));
    ws.simulateMessage(deliverFrame(9));
    await settleDeliveries();
    expect(calls).toEqual(['m_8', 'm_9']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);

    ws.simulateClose();
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = await nextSocket(1);
    ws2.simulateOpen();
    await replyToRegistration(ws2);

    // The old 9 completes before anything arrived on the new connection. Its
    // ack must not anchor the fresh watermark at 8 and claim `up_to_seq: 9`.
    release();
    await settleDeliveries();
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);
    expect(sentFrames(ws2, 'delivery.ack')).toEqual([]);

    // The server replays what the old connection left unacked.
    ws2.simulateMessage(deliverFrame(8));
    ws2.simulateMessage(deliverFrame(9));
    await settleDeliveries();
    expect(calls).toEqual(['m_8', 'm_9', 'm_8']);
    expect(sentFrames(ws2, 'delivery.ack')).toEqual([
      ack('worker', { up_to_seq: 8 }),
      ack('worker', { up_to_seq: 9 }),
    ]);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);
  });

  it('keeps one watermark per agent: interleaved seqs of two agents never collapse or break each other', async () => {
    const agent = createAgent();
    agent.on.dmReceived(() => {});
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrameFor('alice', 1, 'a1'));
    ws.simulateMessage(deliverFrameFor('bob', 1, 'b1'));
    ws.simulateMessage(deliverFrameFor('alice', 2, 'a2'));
    ws.simulateMessage(deliverFrameFor('bob', 2, 'b2'));
    await settleDeliveries();
    expect(sentFrames(ws, 'delivery.ack')).toEqual([
      ack('alice', { up_to_seq: 1 }),
      ack('bob', { up_to_seq: 1 }),
      ack('alice', { up_to_seq: 2 }),
      ack('bob', { up_to_seq: 2 }),
    ]);
  });

  it("keeps one watermark per agent: one agent's failed delivery does not hold the other agent's cursor", async () => {
    const agent = createAgent();
    agent.on.dmReceived((event) => {
      if (event.message.id === 'm_a1') throw new Error('model crashed');
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrameFor('alice', 1, 'a1'));
    ws.simulateMessage(deliverFrameFor('bob', 1, 'b1'));
    ws.simulateMessage(deliverFrameFor('alice', 2, 'a2'));
    ws.simulateMessage(deliverFrameFor('bob', 2, 'b2'));
    await settleDeliveries();
    expect(sentFrames(ws, 'delivery.ack')).toEqual([
      ack('bob', { up_to_seq: 1 }),
      ack('alice', { delivery_id: 'del_a2' }),
      ack('bob', { up_to_seq: 2 }),
    ]);
  });

  it('persists and accepts later frames while a handler hangs; their handlers and acks wait behind it in order', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const working = new Promise<void>((resolve) => { release = resolve; });
    const acceptDelivery = vi.fn(async (_delivery: { deliveryId: string }) => {});
    const agent = createAgent({ ws: { autoAcceptDeliveries: true, acceptDelivery } });
    agent.on.dmReceived(async (event) => {
      calls.push(event.message.id);
      if (event.message.id === 'm_1') await working;
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws, ['delivery.accepted']);

    ws.simulateMessage(deliverFrame(1));
    ws.simulateMessage(deliverFrame(2));
    ws.simulateMessage(deliverFrame(3));
    await settleDeliveries();
    // Intake never waits for handlers: 2 and 3 are stored and accepted while 1 hangs.
    expect(acceptDelivery.mock.calls.map(([delivery]) => delivery.deliveryId)).toEqual(['del_1', 'del_2', 'del_3']);
    expect(sentFrames(ws, 'delivery.accepted')).toEqual([
      accepted('worker', { up_to_seq: 1 }), accepted('worker', { up_to_seq: 2 }), accepted('worker', { up_to_seq: 3 }),
    ]);
    // Dispatch is ordered per agent: 2 and 3 are handled (and acked) only after 1 completed.
    expect(calls).toEqual(['m_1']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);

    release();
    await settleDeliveries();
    expect(calls).toEqual(['m_1', 'm_2', 'm_3']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([
      ack('worker', { up_to_seq: 1 }), ack('worker', { up_to_seq: 2 }), ack('worker', { up_to_seq: 3 }),
    ]);
  });

  it("one agent's hung handler holds neither another agent's handlers nor its acks", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const working = new Promise<void>((resolve) => { release = resolve; });
    const agent = createAgent();
    agent.on.dmReceived(async (event) => {
      calls.push(event.message.id);
      if (event.message.id === 'm_a1') await working;
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrameFor('alice', 1, 'a1'));
    ws.simulateMessage(deliverFrameFor('bob', 1, 'b1'));
    ws.simulateMessage(deliverFrameFor('alice', 2, 'a2'));
    ws.simulateMessage(deliverFrameFor('bob', 2, 'b2'));
    await settleDeliveries();
    expect(calls).toEqual(['m_a1', 'm_b1', 'm_b2']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([ack('bob', { up_to_seq: 1 }), ack('bob', { up_to_seq: 2 })]);

    release();
    await settleDeliveries();
    expect(calls).toEqual(['m_a1', 'm_b1', 'm_b2', 'm_a2']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([
      ack('bob', { up_to_seq: 1 }), ack('bob', { up_to_seq: 2 }), ack('alice', { up_to_seq: 1 }), ack('alice', { up_to_seq: 2 }),
    ]);
  });

  it('accepts replayed frames on a new connection at once while an old-generation handler still hangs; handlers and acks wait behind it', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const working = new Promise<void>((resolve) => { release = resolve; });
    const acceptDelivery = vi.fn(async () => {});
    const agent = createAgent({ ws: { autoAcceptDeliveries: true, acceptDelivery } });
    agent.on.dmReceived(async (event) => {
      calls.push(event.message.id);
      if (event.message.id === 'm_8') await working;
    });
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws, ['delivery.accepted']);

    ws.simulateMessage(deliverFrame(8));
    ws.simulateMessage(deliverFrame(9));
    await settleDeliveries();
    expect(sentFrames(ws, 'delivery.accepted')).toEqual([accepted('worker', { up_to_seq: 8 }), accepted('worker', { up_to_seq: 9 })]);
    expect(calls).toEqual(['m_8']);

    ws.simulateClose();
    await vi.advanceTimersByTimeAsync(1000);
    const ws2 = await nextSocket(1);
    ws2.simulateOpen();
    await replyToRegistration(ws2, ['delivery.accepted']);

    // The server replays both unacked rows: stored and accepted immediately on
    // the new connection, handled only once the hung run let the agent's queue go.
    ws2.simulateMessage(deliverFrame(8));
    ws2.simulateMessage(deliverFrame(9));
    await settleDeliveries();
    expect(acceptDelivery).toHaveBeenCalledTimes(4);
    expect(sentFrames(ws2, 'delivery.accepted')).toEqual([accepted('worker', { up_to_seq: 8 }), accepted('worker', { up_to_seq: 9 })]);
    expect(calls).toEqual(['m_8']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);
    expect(sentFrames(ws2, 'delivery.ack')).toEqual([]);

    release();
    await settleDeliveries();
    // Each message was handled once; the old-generation outcomes were dropped,
    // the replays shared them and acked on the new connection in order.
    expect(calls).toEqual(['m_8', 'm_9']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([]);
    expect(sentFrames(ws2, 'delivery.ack')).toEqual([ack('worker', { up_to_seq: 8 }), ack('worker', { up_to_seq: 9 })]);
  });

  it('handles one message delivered to two hosted agents once per recipient: dedupe is per agent', async () => {
    const handler = vi.fn();
    const agent = createAgent();
    agent.on.dmReceived(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrameFor('alice', 1, 'a1', 'm_shared'));
    ws.simulateMessage(deliverFrameFor('bob', 1, 'b1', 'm_shared'));
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls.map(([event]) => event.message.id)).toEqual(['m_shared', 'm_shared']);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([ack('alice', { up_to_seq: 1 }), ack('bob', { up_to_seq: 1 })]);
  });

  it("skips one agent's re-delivered copy of a message without touching another agent's first copy", async () => {
    const handler = vi.fn();
    const agent = createAgent();
    agent.on.dmReceived(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrameFor('alice', 1, 'a1', 'm_shared'));
    await settleDeliveries();
    ws.simulateMessage(deliverFrameFor('alice', 1, 'a1', 'm_shared'));
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sentFrames(ws, 'delivery.ack')).toEqual([ack('alice', { up_to_seq: 1 }), ack('alice', { delivery_id: 'del_a1' })]);

    ws.simulateMessage(deliverFrameFor('bob', 1, 'b1', 'm_shared'));
    await settleDeliveries();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(sentFrames(ws, 'delivery.ack').at(-1)).toEqual(ack('bob', { up_to_seq: 1 }));
  });

  it('on.deliveryReplied fires with the sender-side delivery.replied context update', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    const handler = vi.fn();
    agent.on.deliveryReplied(handler);

    ws.simulateMessage({
      v: 1,
      type: 'context.update',
      event: 'delivery.replied',
      data: {
        delivery_id: 'del_1', message_id: 'm_1', agent_id: 'a_bob', agent_name: 'bob',
        status: 'replied', reply_message_id: 'm_2', at: '2026-06-01T00:00:03.000Z',
      },
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      type: 'delivery.replied', deliveryId: 'del_1', agentName: 'bob', replyMessageId: 'm_2',
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
      reason: 'depth_cap',
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

  it('on.agentExited camelizes the spawn-caller deliver frame', async () => {
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();

    let received: AgentExitedEvent | undefined;
    agent.on.agentExited((event) => {
      received = event;
    });

    // emitAgentExitedEffects notifies the spawn caller through
    // sendNodeDeliveriesToAgents: a synthetic seq-0 deliver frame whose
    // payload is { type, data } with the snake_case event fields.
    ws.simulateMessage({
      v: 1,
      type: 'deliver',
      delivery_id: 'evt_agent_exited_agt_01J7FLEET000000000000101_none_deregistered_caller_1',
      agent_id: 'caller_1',
      agent: 'spawner',
      msg_id: 'agt_01J7FLEET000000000000101_none_deregistered',
      seq: 0,
      mode: 'wait',
      payload: {
        type: 'agent.exited',
        data: {
          agent_id: 'agt_01J7FLEET000000000000101',
          agent_name: 'claude-worker-7',
          node_id: 'node_1',
          invocation_id: null,
          reason: 'deregistered',
        },
      },
    });

    expect(received).toEqual({
      type: 'agent.exited',
      agentId: 'agt_01J7FLEET000000000000101',
      agentName: 'claude-worker-7',
      nodeId: 'node_1',
      invocationId: null,
      reason: 'deregistered',
    });
    expect(agent.on).not.toHaveProperty('nodeOnline');
    expect(agent.on).not.toHaveProperty('nodeOffline');
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

  it('reuses the direct node token across reconnect attempts instead of minting per attempt', async () => {
    const agent = createAgent();
    const mints = () =>
      mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/agent/node-token')).length;

    agent.connect();
    await nextSocket();
    expect(mints()).toBe(1);

    // Minting rotates the node token through the workspace's shared write lane, so an
    // attempt that never opens must not mint again — otherwise write backpressure
    // feeds itself and a reconnect loop saturates the lane it is already losing.
    for (const [index, delayMs] of [[0, 1000], [1, 2000]] as const) {
      MockWebSocket.instances[index]!.simulateClose();
      await vi.advanceTimersByTimeAsync(delayMs);
      await nextSocket(index + 1);
      expect(mints()).toBe(1);
    }

    // Reuse stays bounded so a token the server no longer accepts is still replaced.
    MockWebSocket.instances[2]!.simulateClose();
    await vi.advanceTimersByTimeAsync(4000);
    await nextSocket(3);
    expect(mints()).toBe(2);
  });

  it('keeps a single minted token while a connection that opens keeps flapping', async () => {
    const agent = createAgent();
    const mints = () =>
      mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/v1/agent/node-token')).length;

    agent.connect();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const socket = await nextSocket(attempt);
      socket.simulateOpen();
      // `open` is emitted only after node registration is sent, so let that settle:
      // reaching a usable connection is what marks the cached token good.
      await vi.advanceTimersByTimeAsync(0);
      socket.simulateClose();
      await vi.advanceTimersByTimeAsync(1000);
    }

    expect(mints()).toBe(1);
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

  it.each([
    { v: 2 }, { ok: false }, { type: 'pong' },
    { data: { agent_presence: false, agent_id: 'agent_1' } },
    { data: { agent_id: 'agent_1' } },
  ])('does not suppress fallback for invalid confirmation %j', async (invalid) => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const agent = createAgent();
    agent.connect();
    const socket = await nextSocket();
    socket.simulateOpen();
    await vi.advanceTimersByTimeAsync(27_000);
    const frame = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    socket.simulateMessage({ v: 1, type: 'reply', id: frame.id, ok: true,
      data: { agent_presence: true, agent_id: 'agent_1' }, ...invalid });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/agents/heartbeat'))).toHaveLength(2);
    await agent.disconnect();
    vi.mocked(Math.random).mockRestore();
  });

  it('uses send time for lease expiry even when a reply arrives late', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const agent = createAgent();
    agent.connect();
    const socket = await nextSocket();
    socket.simulateOpen();
    await vi.advanceTimersByTimeAsync(27_000);
    const frame = JSON.parse(socket.send.mock.calls.at(-1)![0]);
    vi.setSystemTime(Date.now() + 30_000);
    socket.simulateMessage({ v: 1, type: 'reply', id: frame.id, ok: true,
      data: { agent_presence: true, agent_id: 'agent_1' } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/agents/heartbeat'))).toHaveLength(2);
    await agent.disconnect();
    vi.mocked(Math.random).mockRestore();
  });

  it.each([0, 0.999999])('bounds each jittered heartbeat before the existing 30s deadline (%s)', async (random) => {
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const agent = createAgent({ autoHeartbeatMs: false });
    agent.connect();
    const socket = await nextSocket();
    socket.simulateOpen();
    const frames = () => socket.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(f => f.type === 'node.heartbeat');
    await vi.advanceTimersByTimeAsync(26_999);
    expect(frames()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(frames()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(frames()).toHaveLength(2);
    await agent.disconnect();
    vi.mocked(Math.random).mockRestore();
  });

  it('requires fresh correlated presence and falls back while the socket remains open', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await vi.advanceTimersByTimeAsync(27_000);
    const heartbeat = () => ws.send.mock.calls.map(([raw]) => JSON.parse(raw)).filter(f => f.type === 'node.heartbeat').at(-1)!;
    const reply = (id: string, agentId = 'agent_1') => ws.simulateMessage({
      v: 1, type: 'reply', id, ok: true, data: { agent_presence: true, agent_id: agentId },
    });
    const beats = () => mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/agents/heartbeat')).length;
    expect(beats()).toBe(1);
    reply(heartbeat().id);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(beats()).toBe(1);
    await agent.heartbeat();
    expect(beats()).toBe(2);
    await vi.advanceTimersByTimeAsync(24_000);
    const latest = heartbeat().id;
    reply(latest, 'wrong-agent');
    reply(latest);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(beats()).toBe(3);
    await agent.disconnect();
    vi.mocked(Math.random).mockRestore();
  });

  it('rejects unrelated and superseded replies and forgets leases across reconnects', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const agent = createAgent();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await vi.advanceTimersByTimeAsync(27_000);
    const frame = JSON.parse(ws.send.mock.calls.at(-1)![0]);
    const reply = (id: string) => ({ v: 1, type: 'reply', id, ok: true, data: { agent_presence: true, agent_id: 'agent_1' } });
    ws.simulateMessage(reply('unrelated'));
    await vi.advanceTimersByTimeAsync(3_000);
    const beats = () => mockFetch.mock.calls.filter(([url]) => String(url).endsWith('/agents/heartbeat')).length;
    expect(beats()).toBe(2);
    await vi.advanceTimersByTimeAsync(30_000);
    ws.simulateMessage(reply(frame.id));
    expect(beats()).toBe(3);
    const current = JSON.parse(ws.send.mock.calls.at(-1)![0]);
    ws.simulateMessage(reply(current.id));
    ws.simulateClose();
    await vi.advanceTimersByTimeAsync(1_000);
    const next = await nextSocket(1);
    next.simulateOpen();
    await vi.advanceTimersByTimeAsync(0);
    next.simulateMessage(reply(frame.id));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(beats()).toBe(5);
    await agent.disconnect();
    vi.mocked(Math.random).mockRestore();
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

  // --- handlers registered before connect() ---

  it('on.messageCreated registered before connect() does not throw and fires after connecting', async () => {
    const agent = createAgent();
    const handler = vi.fn();

    expect(() => agent.on.messageCreated(handler)).not.toThrow();

    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
    });

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on.connected registered before connect() fires once the socket opens', async () => {
    const agent = createAgent();
    const handler = vi.fn();

    agent.on.connected(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('on.reconnecting registered before connect() fires with attempt count', async () => {
    const agent = createAgent();
    const handler = vi.fn();

    agent.on.reconnecting(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    ws.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(1);
  });

  it('on.permanentlyDisconnected registered before connect() fires with attempt count', async () => {
    const agent = createAgent({
      ws: { maxReconnectAttempts: 0, reconnectJitter: false },
    });
    const handler = vi.fn();

    agent.on.permanentlyDisconnected(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    ws.simulateClose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(0);
  });

  it('on.any registered before connect() receives events once connected', async () => {
    const agent = createAgent();
    const handler = vi.fn();

    agent.on.any(handler);
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    await Promise.resolve();
    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
    });

    // open + message.created
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('registering handlers before connect() does not itself open a WebSocket', () => {
    const agent = createAgent();
    agent.on.messageCreated(vi.fn());
    agent.on.connected(vi.fn());
    agent.on.any(vi.fn());

    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('does not reopen after permanent disconnection until disconnect()', async () => {
    const agent = createAgent({
      ws: { maxReconnectAttempts: 0, reconnectJitter: false },
    });
    const handler = vi.fn();
    agent.on.messageCreated(handler);

    agent.connect();
    agent.connect();
    const ws = await nextSocket();
    ws.simulateOpen();
    ws.simulateClose();

    expect(MockWebSocket.instances).toHaveLength(1);

    agent.connect();
    agent.subscribe(['general'], vi.fn());
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(MockWebSocket.instances).toHaveLength(1);

    const p = agent.disconnect();
    await vi.advanceTimersByTimeAsync(200);
    await p;

    agent.connect();
    const ws2 = await nextSocket(1);
    ws2.simulateOpen();
    ws2.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_2', agent_name: 'Bot', text: 'again', attachments: [] },
    });

    // disconnect() drops the previous transport, including handlers attached to it.
    expect(handler).not.toHaveBeenCalled();
    expect(MockWebSocket.instances).toHaveLength(2);
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
