import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { handleClientMessage, broadcastToChannel, broadcastToWorkspace } from '../subscriptions.js';
import { getClients, type WsClient } from '../server.js';

vi.mock('../server.js', () => ({
  getClients: vi.fn(),
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

      broadcastToChannel('ws_1', 'ch-1', { type: 'test' });

      expect(clientA.ws.send).toHaveBeenCalled();
      expect(clientB.ws.send).not.toHaveBeenCalled();
    });
  });

  describe('broadcastToWorkspace', () => {
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

      const event = { type: 'agent.online', data: { agent_id: 'x' } };
      broadcastToWorkspace('ws_1', event);

      expect(clientA.ws.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(clientB.ws.send).toHaveBeenCalledWith(JSON.stringify(event));
      expect(clientC.ws.send).not.toHaveBeenCalled();
    });
  });
});
