import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentClient } from '../agent.js';
import { HttpClient } from '../client.js';
import { Relay } from '../communicate/relay.js';

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

function createRelay(): { agent: AgentClient; relay: Relay } {
  const client = new HttpClient({
    apiKey: 'at_live_test',
    baseUrl: 'http://localhost:8080',
  });
  const agent = new AgentClient(client, {
    ws: { reconnectJitter: false },
  });

  return {
    agent,
    relay: new Relay(agent),
  };
}

describe('communicate Relay wrapper', () => {
  beforeEach(() => {
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
      return mockResponse({ id: 'm_1' });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function nextSocket(): Promise<MockWebSocket> {
    for (let i = 0; i < 10; i += 1) {
      await Promise.resolve();
      const socket = MockWebSocket.instances[0];
      if (socket) return socket;
    }
    throw new Error('Mock WebSocket was not created');
  }

  it('exposes the underlying AgentClient as agents', () => {
    const { agent, relay } = createRelay();

    expect(relay.agents).toBe(agent);
  });

  it('post() delegates to AgentClient.send() and preserves #channel ergonomics', async () => {
    const { relay } = createRelay();

    await relay.post('#general', 'hello');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:8080/v1/channels/general/messages');
    expect(mockFetch.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ text: 'hello', mode: 'wait' }),
    });
  });

  it('send() delegates to AgentClient.dm()', async () => {
    const { relay } = createRelay();

    await relay.send('Alice', 'hello');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:8080/v1/dm');
    expect(mockFetch.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ to: 'Alice', text: 'hello', mode: 'wait' }),
    });
  });

  it('reply() delegates to AgentClient.reply()', async () => {
    const { relay } = createRelay();

    await relay.reply('m_1', 'thanks');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:8080/v1/messages/m_1/replies');
    expect(mockFetch.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ text: 'thanks' }),
    });
  });

  it('inbox() delegates to AgentClient.inbox()', async () => {
    const { relay } = createRelay();

    await relay.inbox();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:8080/v1/inbox');
  });

  it('onMessage() connects lazily and normalizes channel, thread, and DM events', async () => {
    const { relay } = createRelay();
    const handler = vi.fn();

    const unsubscribe = relay.onMessage(handler);

    const ws = await nextSocket();
    expect(MockWebSocket.instances).toHaveLength(1);

    ws.simulateOpen();
    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_1', agent_name: 'Alice', text: 'hello', attachments: [] },
    });
    ws.simulateMessage({
      type: 'thread.reply',
      channel: 'general',
      parent_id: 'm_1',
      message: { id: 'm_2', agent_name: 'Bob', text: 'reply', attachments: [] },
    });
    ws.simulateMessage({
      type: 'dm.received',
      conversation_id: 'conv_1',
      message: { id: 'dm_1', agent_name: 'Alice', text: 'ping' },
    });
    ws.simulateMessage({
      type: 'group_dm.received',
      conversation_id: 'gdm_1',
      participants: ['Alice', 'Bob'],
      message: { id: 'dm_2', agent_name: 'Bob', text: 'group ping' },
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(4);
    expect(handler.mock.calls[0]![0]).toMatchObject({
      id: 'm_1',
      sender: 'Alice',
      channel: 'general',
      text: 'hello',
      threadId: null,
    });
    expect(handler.mock.calls[1]![0]).toMatchObject({
      id: 'm_2',
      sender: 'Bob',
      channel: 'general',
      text: 'reply',
      threadId: 'm_1',
    });
    expect(handler.mock.calls[2]![0]).toMatchObject({
      id: 'dm_1',
      sender: 'Alice',
      text: 'ping',
      threadId: null,
    });
    expect(handler.mock.calls[3]![0]).toMatchObject({
      id: 'dm_2',
      sender: 'Bob',
      text: 'group ping',
      threadId: null,
    });
    for (const [message] of handler.mock.calls) {
      expect(message.createdAt).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }

    unsubscribe();
    ws.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'm_3', agent_name: 'Alice', text: 'after unsubscribe', attachments: [] },
    });
    await Promise.resolve();

    expect(handler).toHaveBeenCalledTimes(4);
  });

  // --- after-handlers ack through the wrapper (node transport) ---

  /** The engine's reply to this socket's `node.register`, listing the frames it understands. */
  async function replyToRegistration(ws: MockWebSocket): Promise<void> {
    for (let i = 0; i < 10 && !ws.send.mock.calls.some(([p]) => JSON.parse(String(p)).type === 'node.register'); i += 1) {
      await Promise.resolve();
    }
    const register = ws.send.mock.calls.map(([p]) => JSON.parse(String(p))).find((frame) => frame.type === 'node.register');
    expect(register).toBeDefined();
    ws.simulateMessage({
      v: 1, id: register.id, type: 'reply', ok: true,
      data: {
        provider: { name: 'default', instance_id: 'i1' }, accepted_capabilities: [],
        capabilities: ['delivery.accepted', 'delivery.ack.delivery_id'],
      },
    });
  }

  const deliverFrame = (seq: number) => ({
    v: 1, type: 'deliver', delivery_id: `del_${seq}`, agent_id: 'agent_1', agent: 'worker', msg_id: `m_${seq}`, seq, mode: 'wait',
    payload: {
      type: 'dm.received',
      data: {
        conversation_id: 'conv_1', id: `m_${seq}`, from_agent_id: 'bot_1', from_name: 'Bot', to: 'worker',
        text: 'confirm me', created_at: '2026-09-24T05:00:00.000Z', attachments: [], metadata: {},
        message: { id: `m_${seq}`, agent_id: 'bot_1', agent_name: 'Bot', text: 'confirm me', attachments: [], metadata: {} },
      },
    },
  });
  const acks = (ws: MockWebSocket) =>
    ws.send.mock.calls.map(([p]) => JSON.parse(String(p))).filter((frame) => frame.type === 'delivery.ack');
  async function settleDeliveries(): Promise<void> {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  }

  it('onMessage() holds the delivery.ack until an async handler resolves', async () => {
    const { relay } = createRelay();
    let release!: () => void;
    const working = new Promise<void>((resolve) => { release = resolve; });
    const seen: string[] = [];
    relay.onMessage(async (message) => {
      seen.push(message.id);
      await working;
    });
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(1));
    await settleDeliveries();
    expect(seen).toEqual(['m_1']);
    // The handler is still running: nothing is acked yet.
    expect(acks(ws)).toEqual([]);

    release();
    await settleDeliveries();
    expect(acks(ws)).toEqual([{ v: 1, type: 'delivery.ack', agent: 'worker', delivery_id: 'del_1' }]);
  });

  it('onMessage() leaves a delivery unacked when the async handler rejects, and acks the next one on its own', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { relay } = createRelay();
    relay.onMessage(async (message) => {
      if (message.id === 'm_2') throw new Error('model crashed');
    });
    const ws = await nextSocket();
    ws.simulateOpen();
    await replyToRegistration(ws);

    ws.simulateMessage(deliverFrame(2));
    ws.simulateMessage(deliverFrame(3));
    await settleDeliveries();
    expect(acks(ws)).toEqual([{ v: 1, type: 'delivery.ack', agent: 'worker', delivery_id: 'del_3' }]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('delivery handler failed; delivery left unconsumed'),
      expect.objectContaining({ deliveryId: 'del_2', seq: 2 }),
    );
  });
});
