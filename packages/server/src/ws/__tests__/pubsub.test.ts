import { describe, it, expect, vi, beforeEach } from 'vitest';
import { publishEvent, subscribeToWorkspace, unsubscribeFromWorkspace, setupPubSubListener, getSubscribedWorkspaces, type WsEvent } from '../pubsub.js';

const mockPublish = vi.fn().mockResolvedValue(1);
const mockSubscribe = vi.fn().mockResolvedValue('OK');
const mockUnsubscribe = vi.fn().mockResolvedValue('OK');
const mockOn = vi.fn();

vi.mock('../../redis/index.js', () => ({
  getRedis: vi.fn(() => ({
    publish: mockPublish,
  })),
  getRedisSub: vi.fn(() => ({
    subscribe: mockSubscribe,
    unsubscribe: mockUnsubscribe,
    on: mockOn,
  })),
}));

const mockBroadcastToChannel = vi.fn();
const mockBroadcastToWorkspace = vi.fn();

vi.mock('../subscriptions.js', () => ({
  broadcastToChannel: (...args: unknown[]) => mockBroadcastToChannel(...args),
  broadcastToWorkspace: (...args: unknown[]) => mockBroadcastToWorkspace(...args),
}));

describe('Redis Pub/Sub Fanout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSubscribedWorkspaces().clear();
  });

  describe('publishEvent', () => {
    it('publishes event to redis channel', async () => {
      const event: WsEvent = {
        type: 'message.created',
        workspace_id: 'ws_123',
        channel_id: 'ch_456',
        data: { text: 'hello' },
        timestamp: new Date().toISOString(),
      };

      await publishEvent(event);

      expect(mockPublish).toHaveBeenCalledWith(
        'ws:ws_123',
        JSON.stringify(event),
      );
    });

    it('publishes workspace-level event', async () => {
      const event: WsEvent = {
        type: 'agent.online',
        workspace_id: 'ws_123',
        data: { agent_id: 'agent_1' },
        timestamp: new Date().toISOString(),
      };

      await publishEvent(event);

      expect(mockPublish).toHaveBeenCalledWith(
        'ws:ws_123',
        JSON.stringify(event),
      );
    });
  });

  describe('subscribeToWorkspace', () => {
    it('subscribes to redis channel', async () => {
      await subscribeToWorkspace('ws_123');

      expect(mockSubscribe).toHaveBeenCalledWith('ws:ws_123');
      expect(getSubscribedWorkspaces().has('ws_123')).toBe(true);
    });

    it('does not duplicate subscriptions', async () => {
      await subscribeToWorkspace('ws_123');
      await subscribeToWorkspace('ws_123');

      expect(mockSubscribe).toHaveBeenCalledTimes(1);
    });
  });

  describe('unsubscribeFromWorkspace', () => {
    it('unsubscribes from redis channel', async () => {
      await subscribeToWorkspace('ws_123');
      await unsubscribeFromWorkspace('ws_123');

      expect(mockUnsubscribe).toHaveBeenCalledWith('ws:ws_123');
      expect(getSubscribedWorkspaces().has('ws_123')).toBe(false);
    });

    it('no-op for unsubscribed workspace', async () => {
      await unsubscribeFromWorkspace('ws_999');
      expect(mockUnsubscribe).not.toHaveBeenCalled();
    });
  });

  describe('setupPubSubListener', () => {
    it('registers message handler on redis sub', () => {
      setupPubSubListener();
      expect(mockOn).toHaveBeenCalledWith('message', expect.any(Function));
    });

    it('routes channel events to broadcastToChannel', () => {
      setupPubSubListener();
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'message')![1] as (channel: string, message: string) => void;

      const event: WsEvent = {
        type: 'message.created',
        workspace_id: 'ws_123',
        channel_id: 'ch_456',
        data: { text: 'hello' },
        timestamp: new Date().toISOString(),
      };

      handler('ws:ws_123', JSON.stringify(event));

      expect(mockBroadcastToChannel).toHaveBeenCalledWith('ws_123', 'ch_456', event);
      expect(mockBroadcastToWorkspace).not.toHaveBeenCalled();
    });

    it('prefers channel_name from data over channel_id', () => {
      setupPubSubListener();
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'message')![1] as (channel: string, message: string) => void;

      const event: WsEvent = {
        type: 'message.created',
        workspace_id: 'ws_123',
        channel_id: 'ch_456',
        data: { text: 'hello', channel_name: 'general' },
        timestamp: new Date().toISOString(),
      };

      handler('ws:ws_123', JSON.stringify(event));

      expect(mockBroadcastToChannel).toHaveBeenCalledWith('ws_123', 'general', event);
    });

    it('falls back to channel_id when channel_name is empty or whitespace', () => {
      setupPubSubListener();
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'message')![1] as (channel: string, message: string) => void;

      const event: WsEvent = {
        type: 'message.created',
        workspace_id: 'ws_123',
        channel_id: 'ch_456',
        data: { text: 'hello', channel_name: '  ' },
        timestamp: new Date().toISOString(),
      };

      handler('ws:ws_123', JSON.stringify(event));

      expect(mockBroadcastToChannel).toHaveBeenCalledWith('ws_123', 'ch_456', event);
    });

    it('routes workspace events to broadcastToWorkspace', () => {
      setupPubSubListener();
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'message')![1] as (channel: string, message: string) => void;

      const event: WsEvent = {
        type: 'agent.online',
        workspace_id: 'ws_123',
        data: { agent_id: 'agent_1' },
        timestamp: new Date().toISOString(),
      };

      handler('ws:ws_123', JSON.stringify(event));

      expect(mockBroadcastToWorkspace).toHaveBeenCalledWith('ws_123', event);
      expect(mockBroadcastToChannel).not.toHaveBeenCalled();
    });

    it('ignores non-ws redis channels', () => {
      setupPubSubListener();
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'message')![1] as (channel: string, message: string) => void;

      handler('other:channel', '{}');

      expect(mockBroadcastToChannel).not.toHaveBeenCalled();
      expect(mockBroadcastToWorkspace).not.toHaveBeenCalled();
    });

    it('ignores invalid JSON messages', () => {
      setupPubSubListener();
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'message')![1] as (channel: string, message: string) => void;

      handler('ws:ws_123', 'not json');

      expect(mockBroadcastToChannel).not.toHaveBeenCalled();
      expect(mockBroadcastToWorkspace).not.toHaveBeenCalled();
    });

    it('handles all 13 event types', () => {
      setupPubSubListener();
      const handler = mockOn.mock.calls.find((c: unknown[]) => c[0] === 'message')![1] as (channel: string, message: string) => void;

      const channelEvents = [
        'message.created', 'message.updated', 'thread.reply',
        'reaction.added', 'reaction.removed', 'channel.created',
        'channel.archived', 'message.read', 'file.uploaded',
      ];

      const workspaceEvents = [
        'dm.received', 'group_dm.received', 'agent.online', 'agent.offline',
      ];

      for (const type of channelEvents) {
        vi.clearAllMocks();
        const event = {
          type,
          workspace_id: 'ws_123',
          channel_id: 'ch_456',
          data: {},
          timestamp: new Date().toISOString(),
        };
        handler('ws:ws_123', JSON.stringify(event));
        expect(mockBroadcastToChannel).toHaveBeenCalledTimes(1);
      }

      for (const type of workspaceEvents) {
        vi.clearAllMocks();
        const event = {
          type,
          workspace_id: 'ws_123',
          data: {},
          timestamp: new Date().toISOString(),
        };
        handler('ws:ws_123', JSON.stringify(event));
        expect(mockBroadcastToWorkspace).toHaveBeenCalledTimes(1);
      }
    });
  });
});
