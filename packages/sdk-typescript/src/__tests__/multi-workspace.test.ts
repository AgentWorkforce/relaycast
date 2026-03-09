import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MultiWorkspaceSessionManager } from '../multi-workspace.js';

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

describe('MultiWorkspaceSessionManager', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => mockResponse({ id: 'msg_1', text: 'hello' }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('merges inbound events and tags them by websocket membership', () => {
    const manager = new MultiWorkspaceSessionManager({
      memberships: [
        {
          workspaceId: 'ws_alpha',
          workspaceAlias: 'alpha',
          agentId: 'agent_alpha',
          agentName: 'Alpha Agent',
          agentToken: 'at_alpha',
          baseUrl: 'http://localhost:8080',
          channels: ['general'],
        },
        {
          workspaceId: 'ws_beta',
          workspaceAlias: 'beta',
          agentId: 'agent_beta',
          agentName: 'Beta Agent',
          agentToken: 'at_beta',
          baseUrl: 'http://localhost:8081',
          channels: ['ops'],
        },
      ],
    });

    const handler = vi.fn();
    manager.onAnyEvent(handler);
    manager.connectAll();

    expect(MockWebSocket.instances).toHaveLength(2);

    const [alphaSocket, betaSocket] = MockWebSocket.instances;
    alphaSocket!.simulateOpen();
    betaSocket!.simulateOpen();

    expect(alphaSocket!.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'subscribe',
      channels: ['general'],
    }));
    expect(betaSocket!.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'subscribe',
      channels: ['ops'],
    }));

    handler.mockClear();

    alphaSocket!.simulateMessage({
      type: 'message.created',
      channel: 'general',
      message: { id: 'msg_alpha', agent_name: 'Relay', text: 'hello', attachments: [] },
    });
    betaSocket!.simulateMessage({
      type: 'dm.received',
      conversation_id: 'dm_beta',
      message: { id: 'msg_beta', agent_id: 'agent_sender', agent_name: 'Relay', text: 'hi' },
    });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, {
      workspaceId: 'ws_alpha',
      workspaceAlias: 'alpha',
      agentId: 'agent_alpha',
      agentName: 'Alpha Agent',
      event: {
        type: 'message.created',
        channel: 'general',
        message: {
          id: 'msg_alpha',
          agentName: 'Relay',
          text: 'hello',
          attachments: [],
        },
      },
    });
    expect(handler).toHaveBeenNthCalledWith(2, {
      workspaceId: 'ws_beta',
      workspaceAlias: 'beta',
      agentId: 'agent_beta',
      agentName: 'Beta Agent',
      event: {
        type: 'dm.received',
        conversationId: 'dm_beta',
        message: {
          id: 'msg_beta',
          agentId: 'agent_sender',
          agentName: 'Relay',
          text: 'hi',
        },
      },
    });
  });

  it('resolves outbound sends by workspaceAlias', async () => {
    const manager = new MultiWorkspaceSessionManager({
      memberships: [
        { workspaceId: 'ws_alpha', workspaceAlias: 'alpha', agentToken: 'at_alpha', baseUrl: 'http://localhost:8080' },
        { workspaceId: 'ws_beta', workspaceAlias: 'beta', agentToken: 'at_beta', baseUrl: 'http://localhost:8081' },
      ],
    });

    await manager.send({ workspaceAlias: 'beta', to: '#ops', message: 'ship it' });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:8081/v1/channels/ops/messages');
    expect((mockFetch.mock.calls[0]![1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer at_beta',
    });
  });

  it('uses the configured default workspace when no workspace ref is provided', async () => {
    const manager = new MultiWorkspaceSessionManager({
      memberships: [
        { workspaceId: 'ws_alpha', workspaceAlias: 'alpha', agentToken: 'at_alpha', baseUrl: 'http://localhost:8080' },
        { workspaceId: 'ws_beta', workspaceAlias: 'beta', agentToken: 'at_beta', baseUrl: 'http://localhost:8081' },
      ],
      defaultWorkspaceId: 'ws_alpha',
    });

    await manager.send({ to: '#general', message: 'hello default' });

    expect(mockFetch.mock.calls[0]![0]).toBe('http://localhost:8080/v1/channels/general/messages');
  });

  it('rejects ambiguous sends when multiple memberships exist without a default', async () => {
    const manager = new MultiWorkspaceSessionManager({
      memberships: [
        { workspaceId: 'ws_alpha', workspaceAlias: 'alpha', agentToken: 'at_alpha' },
        { workspaceId: 'ws_beta', workspaceAlias: 'beta', agentToken: 'at_beta' },
      ],
    });

    await expect(manager.send({ to: '#general', message: 'hello' })).rejects.toThrow(
      'Ambiguous workspace selection. Provide workspaceId or workspaceAlias.',
    );
  });
});
