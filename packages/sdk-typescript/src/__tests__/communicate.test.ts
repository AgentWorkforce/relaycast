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
});
