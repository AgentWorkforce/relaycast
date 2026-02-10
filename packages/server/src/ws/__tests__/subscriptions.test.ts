import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { handleClientMessage, broadcastToChannel, broadcastToWorkspace } from '../subscriptions.js';
import { getClients, getChannelIndex, getWorkspaceIndex, indexSubscribe, indexUnsubscribe, type WsClient } from '../server.js';

const mockChannelIndex = new Map<string, Set<string>>();
const mockWorkspaceIndex = new Map<string, Set<string>>();

vi.mock('../server.js', () => ({
  getClients: vi.fn(),
  getChannelIndex: vi.fn(() => mockChannelIndex),
  getWorkspaceIndex: vi.fn(() => mockWorkspaceIndex),
  indexSubscribe: vi.fn((client: { id: string; workspaceId: string }, channel: string) => {
    const key = `${client.workspaceId}:${channel}`;
    let set = mockChannelIndex.get(key);
    if (!set) { set = new Set(); mockChannelIndex.set(key, set); }
    set.add(client.id);
  }),
  indexUnsubscribe: vi.fn((client: { id: string; workspaceId: string }, channel: string) => {
    const key = `${client.workspaceId}:${channel}`;
    const set = mockChannelIndex.get(key);
    if (set) { set.delete(client.id); if (set.size === 0) mockChannelIndex.delete(key); }
  }),
}));

function createMockClient(overrides: Partial<WsClient> = {}): WsClient {
  return {
    id: 'client-1',
    ws: {
      send: vi.fn(),
      readyState: WebSocket.OPEN,
    } as unknown as WebSocket,
    workspaceId: 'ws_123',
    subscriptions: new Set<string>(),
    alive: true,
    ...overrides,
  };
}

describe('Subscription Management', () => {
  describe('handleClientMessage', () => {
    it('subscribes to channels', () => {
      const client = createMockClient();
      handleClientMessage(client, JSON.stringify({
        type: 'subscribe',
        channels: ['channel-a', 'channel-b'],
      }));

      expect(client.subscriptions.has('channel-a')).toBe(true);
      expect(client.subscriptions.has('channel-b')).toBe(true);
      expect(client.ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'subscribed',
          channels: ['channel-a', 'channel-b'],
        }),
      );
    });

    it('unsubscribes from channels', () => {
      const client = createMockClient();
      client.subscriptions.add('channel-a');
      client.subscriptions.add('channel-b');
      client.subscriptions.add('channel-c');

      handleClientMessage(client, JSON.stringify({
        type: 'unsubscribe',
        channels: ['channel-a', 'channel-b'],
      }));

      expect(client.subscriptions.has('channel-a')).toBe(false);
      expect(client.subscriptions.has('channel-b')).toBe(false);
      expect(client.subscriptions.has('channel-c')).toBe(true);
      expect(client.ws.send).toHaveBeenCalledWith(
        JSON.stringify({
          type: 'unsubscribed',
          channels: ['channel-c'],
        }),
      );
    });

    it('handles invalid JSON', () => {
      const client = createMockClient();
      handleClientMessage(client, 'not json');

      expect(client.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'error', message: 'Invalid JSON' }),
      );
    });

    it('responds to ping with pong', () => {
      const client = createMockClient();
      handleClientMessage(client, JSON.stringify({ type: 'ping' }));

      expect(client.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'pong' }),
      );
    });

    it('handles unknown message type', () => {
      const client = createMockClient();
      handleClientMessage(client, JSON.stringify({ type: 'unknown' }));

      expect(client.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'error', message: 'Unknown message type' }),
      );
    });

    it('handles subscribe with invalid channels', () => {
      const client = createMockClient();
      handleClientMessage(client, JSON.stringify({
        type: 'subscribe',
        channels: 'not-an-array',
      }));

      expect(client.ws.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'error', message: 'channels must be an array' }),
      );
    });
  });

  describe('broadcastToChannel', () => {
    beforeEach(() => {
      mockChannelIndex.clear();
      mockWorkspaceIndex.clear();
    });

    it('sends to subscribed clients only', () => {
      const clientA = createMockClient({ id: 'a', workspaceId: 'ws_1' });
      clientA.subscriptions.add('ch-1');

      const clientB = createMockClient({ id: 'b', workspaceId: 'ws_1' });
      // clientB is NOT subscribed to ch-1

      const clientC = createMockClient({ id: 'c', workspaceId: 'ws_1' });
      clientC.subscriptions.add('ch-1');

      const mockClients = new Map<string, WsClient>([
        ['a', clientA],
        ['b', clientB],
        ['c', clientC],
      ]);
      (getClients as ReturnType<typeof vi.fn>).mockReturnValue(mockClients);

      // Populate the channel index (simulates subscribe)
      mockChannelIndex.set('ws_1:ch-1', new Set(['a', 'c']));

      const event = { type: 'message.created', data: { text: 'hello' } };
      broadcastToChannel('ws_1', 'ch-1', event);

      expect(clientA.ws.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(clientB.ws.send).not.toHaveBeenCalled();
      expect(clientC.ws.send).toHaveBeenCalledWith(JSON.stringify(event));
    });

    it('does not send to other workspaces', () => {
      const clientA = createMockClient({ id: 'a', workspaceId: 'ws_1' });
      clientA.subscriptions.add('ch-1');

      const clientB = createMockClient({ id: 'b', workspaceId: 'ws_2' });
      clientB.subscriptions.add('ch-1');

      const mockClients = new Map<string, WsClient>([
        ['a', clientA],
        ['b', clientB],
      ]);
      (getClients as ReturnType<typeof vi.fn>).mockReturnValue(mockClients);

      // Only ws_1:ch-1 has clientA indexed
      mockChannelIndex.set('ws_1:ch-1', new Set(['a']));
      // ws_2:ch-1 would be separate
      mockChannelIndex.set('ws_2:ch-1', new Set(['b']));

      broadcastToChannel('ws_1', 'ch-1', { type: 'test' });

      expect(clientA.ws.send).toHaveBeenCalled();
      expect(clientB.ws.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastToWorkspace', () => {
    beforeEach(() => {
      mockChannelIndex.clear();
      mockWorkspaceIndex.clear();
    });

    it('sends to all clients in workspace', () => {
      const clientA = createMockClient({ id: 'a', workspaceId: 'ws_1' });
      const clientB = createMockClient({ id: 'b', workspaceId: 'ws_1' });
      const clientC = createMockClient({ id: 'c', workspaceId: 'ws_2' });

      const mockClients = new Map<string, WsClient>([
        ['a', clientA],
        ['b', clientB],
        ['c', clientC],
      ]);
      (getClients as ReturnType<typeof vi.fn>).mockReturnValue(mockClients);

      // Populate workspace index
      mockWorkspaceIndex.set('ws_1', new Set(['a', 'b']));
      mockWorkspaceIndex.set('ws_2', new Set(['c']));

      const event = { type: 'agent.online', data: { agent_id: 'x' } };
      broadcastToWorkspace('ws_1', event);

      expect(clientA.ws.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(clientB.ws.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(clientC.ws.send).not.toHaveBeenCalled();
    });
  });
});
