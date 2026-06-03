import { describe, it, expect } from 'vitest';
import { createStore } from '../store.js';
import { handleServerEvent } from '../reducer.js';
import type { MessageWithMeta } from '@relaycast/sdk';

function makeMessage(overrides: Partial<MessageWithMeta> = {}): MessageWithMeta {
  return {
    id: 'msg1',
    channelId: 'general',
    agentName: 'Alice',
    agentId: 'a1',
    text: 'hello',
    blocks: null,
    hasAttachments: false,
    threadId: null,
    attachments: [],
    createdAt: '2026-01-01T00:00:00Z',
    replyCount: 0,
    reactions: [],
    readByCount: 0,
    ...overrides,
  };
}

function makeChannel(overrides: Partial<{ id: string; workspaceId: string; name: string; channelType: number; topic: string | null; createdBy: string | null; createdAt: string; isArchived: boolean }> = {}) {
  return {
    id: 'ch1',
    workspaceId: 'ws1',
    name: 'general',
    channelType: 0,
    topic: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00Z',
    isArchived: false,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<{ id: string; workspaceId: string; name: string; type: 'agent' | 'human' | 'system'; tokenHash: string; status: 'online' | 'offline' | 'away'; persona: string | null; metadata: Record<string, unknown>; createdAt: string; lastSeen: string }> = {}) {
  return {
    id: 'ag1',
    workspaceId: 'ws1',
    name: 'Alice',
    type: 'agent' as const,
    tokenHash: '',
    status: 'online' as const,
    persona: null,
    metadata: {},
    createdAt: '2026-01-01T00:00:00Z',
    lastSeen: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('handleServerEvent', () => {
  // ─── message.created ───────────────────────────────────────────

  describe('message.created', () => {
    it('appends message to correct channel', () => {
      const store = createStore();

      handleServerEvent(store, {
        type: 'message.created',
        channel: 'general',
        message: { id: 'msg1', agentName: 'Alice', text: 'hello', attachments: [] },
      });

      const state = store.getState();
      expect(state.channelMessages['general'].messages).toHaveLength(1);
      expect(state.channelMessages['general'].messages[0].id).toBe('msg1');
      expect(state.channelMessages['general'].messages[0].agentName).toBe('Alice');
      expect(state.channelMessages['general'].messages[0].text).toBe('hello');
    });

    it('deduplicates by id', () => {
      const store = createStore();

      handleServerEvent(store, {
        type: 'message.created',
        channel: 'general',
        message: { id: 'msg1', agentName: 'Alice', text: 'hello', attachments: [] },
      });
      handleServerEvent(store, {
        type: 'message.created',
        channel: 'general',
        message: { id: 'msg1', agentName: 'Alice', text: 'hello again', attachments: [] },
      });

      const state = store.getState();
      expect(state.channelMessages['general'].messages).toHaveLength(1);
      expect(state.channelMessages['general'].messages[0].text).toBe('hello');
    });
  });

  // ─── message.updated ───────────────────────────────────────────

  describe('message.updated', () => {
    it('updates text in matching message', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({ id: 'msg1', text: 'original' })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'message.updated',
        channel: 'general',
        message: { id: 'msg1', agentName: 'Alice', text: 'edited' },
      });

      const state = store.getState();
      expect(state.channelMessages['general'].messages[0].text).toBe('edited');
    });

    it('is a no-op if message not found', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({ id: 'msg1', text: 'original' })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'message.updated',
        channel: 'general',
        message: { id: 'msg999', agentName: 'Alice', text: 'edited' },
      });

      const state = store.getState();
      expect(state.channelMessages['general'].messages).toHaveLength(1);
      expect(state.channelMessages['general'].messages[0].text).toBe('original');
    });
  });

  // ─── thread.reply ──────────────────────────────────────────────

  describe('thread.reply', () => {
    it('appends reply to correct thread', () => {
      const store = createStore();

      handleServerEvent(store, {
        type: 'thread.reply',
        parentId: 'msg1',
        message: { id: 'reply1', agentName: 'Bob', text: 'reply text' },
      });

      const state = store.getState();
      expect(state.threads['msg1'].replies).toHaveLength(1);
      expect(state.threads['msg1'].replies[0].id).toBe('reply1');
      expect(state.threads['msg1'].replies[0].text).toBe('reply text');
    });

    it('deduplicates by id', () => {
      const store = createStore();

      handleServerEvent(store, {
        type: 'thread.reply',
        parentId: 'msg1',
        message: { id: 'reply1', agentName: 'Bob', text: 'reply text' },
      });
      handleServerEvent(store, {
        type: 'thread.reply',
        parentId: 'msg1',
        message: { id: 'reply1', agentName: 'Bob', text: 'reply text duplicate' },
      });

      const state = store.getState();
      expect(state.threads['msg1'].replies).toHaveLength(1);
      expect(state.threads['msg1'].replies[0].text).toBe('reply text');
    });

    it('increments parent replyCount in channel messages', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({ id: 'msg1', replyCount: 0 })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'thread.reply',
        parentId: 'msg1',
        message: { id: 'reply1', agentName: 'Bob', text: 'reply text' },
      });

      const state = store.getState();
      expect(state.channelMessages['general'].messages[0].replyCount).toBe(1);
      expect(state.channelMessages['general'].messages).toHaveLength(1);
    });

    it('increments parent replyCount in thread parent cache', () => {
      const store = createStore();
      store.updateThread('msg1', () => ({
        parent: makeMessage({ id: 'msg1', replyCount: 0 }),
        replies: [],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'thread.reply',
        parentId: 'msg1',
        message: { id: 'reply1', agentName: 'Bob', text: 'reply text' },
      });

      const state = store.getState();
      expect(state.threads['msg1'].parent?.replyCount).toBe(1);
    });

    it('does not double-count duplicate reply events', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({ id: 'msg1', replyCount: 0 })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'thread.reply',
        parentId: 'msg1',
        message: { id: 'reply1', agentName: 'Bob', text: 'reply text' },
      });
      handleServerEvent(store, {
        type: 'thread.reply',
        parentId: 'msg1',
        message: { id: 'reply1', agentName: 'Bob', text: 'duplicate payload' },
      });

      const state = store.getState();
      expect(state.threads['msg1'].replies).toHaveLength(1);
      expect(state.channelMessages['general'].messages[0].replyCount).toBe(1);
      expect(state.channelMessages['general'].messages).toHaveLength(1);
    });
  });

  // ─── message.reacted added ─────────────────────────────────────

  describe('message.reacted added', () => {
    it('creates new ReactionGroup if emoji not present', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({ id: 'msg1', reactions: [] })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'message.reacted',
        messageId: 'msg1',
        emoji: 'thumbsup',
        agentName: 'Alice',
        action: 'added',
      });

      const state = store.getState();
      const reactions = state.channelMessages['general'].messages[0].reactions;
      expect(reactions).toHaveLength(1);
      expect(reactions[0]).toEqual({ emoji: 'thumbsup', count: 1, agents: ['Alice'] });
    });

    it('increments count on existing group', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({
          id: 'msg1',
          reactions: [{ emoji: 'thumbsup', count: 1, agents: ['Alice'] }],
        })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'message.reacted',
        messageId: 'msg1',
        emoji: 'thumbsup',
        agentName: 'Bob',
        action: 'added',
      });

      const state = store.getState();
      const reactions = state.channelMessages['general'].messages[0].reactions;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].count).toBe(2);
      expect(reactions[0].agents).toEqual(['Alice', 'Bob']);
    });

    it('deduplicates (same agent, same emoji)', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({
          id: 'msg1',
          reactions: [{ emoji: 'thumbsup', count: 1, agents: ['Alice'] }],
        })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'message.reacted',
        messageId: 'msg1',
        emoji: 'thumbsup',
        agentName: 'Alice',
        action: 'added',
      });

      const state = store.getState();
      const reactions = state.channelMessages['general'].messages[0].reactions;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].count).toBe(1);
      expect(reactions[0].agents).toEqual(['Alice']);
    });
  });

  // ─── message.reacted removed ───────────────────────────────────

  describe('message.reacted removed', () => {
    it('decrements count', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({
          id: 'msg1',
          reactions: [{ emoji: 'thumbsup', count: 2, agents: ['Alice', 'Bob'] }],
        })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'message.reacted',
        messageId: 'msg1',
        emoji: 'thumbsup',
        agentName: 'Bob',
        action: 'removed',
      });

      const state = store.getState();
      const reactions = state.channelMessages['general'].messages[0].reactions;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].count).toBe(1);
      expect(reactions[0].agents).toEqual(['Alice']);
    });

    it('removes group when count reaches 0', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({
          id: 'msg1',
          reactions: [{ emoji: 'thumbsup', count: 1, agents: ['Alice'] }],
        })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'message.reacted',
        messageId: 'msg1',
        emoji: 'thumbsup',
        agentName: 'Alice',
        action: 'removed',
      });

      const state = store.getState();
      const reactions = state.channelMessages['general'].messages[0].reactions;
      expect(reactions).toHaveLength(0);
    });
  });

  // ─── agent.status.active / agent.status.offline ────────────────

  describe('agent.status.active', () => {
    it('updates agent status to online', () => {
      const store = createStore();
      const agent = makeAgent({ name: 'Alice', status: 'offline' });
      store.setState({ agents: { data: [agent], loading: false, error: null } });

      handleServerEvent(store, {
        type: 'agent.status.active',
        agent: { name: 'Alice' },
        status: 'active',
      });

      const state = store.getState();
      expect(state.agents.data[0].status).toBe('online');
    });
  });

  describe('agent.status.offline', () => {
    it('updates agent status to offline', () => {
      const store = createStore();
      const agent = makeAgent({ name: 'Alice', status: 'online' });
      store.setState({ agents: { data: [agent], loading: false, error: null } });

      handleServerEvent(store, {
        type: 'agent.status.offline',
        agent: { name: 'Alice' },
        status: 'offline',
      });

      const state = store.getState();
      expect(state.agents.data[0].status).toBe('offline');
    });
  });

  // ─── channel.created ───────────────────────────────────────────

  describe('channel.created', () => {
    it('appends to channel list', () => {
      const store = createStore();
      store.setState({ channels: { data: [], loading: false, error: null } });

      handleServerEvent(store, {
        type: 'channel.created',
        channel: { name: 'new-channel', topic: 'A new channel' },
      });

      const state = store.getState();
      expect(state.channels.data).toHaveLength(1);
      expect(state.channels.data[0].name).toBe('new-channel');
      expect(state.channels.data[0].topic).toBe('A new channel');
      expect(state.channels.data[0].isArchived).toBe(false);
    });

    it('deduplicates by name', () => {
      const store = createStore();
      store.setState({
        channels: { data: [makeChannel({ name: 'general' })], loading: false, error: null },
      });

      handleServerEvent(store, {
        type: 'channel.created',
        channel: { name: 'general', topic: 'duplicate' },
      });

      const state = store.getState();
      expect(state.channels.data).toHaveLength(1);
    });
  });

  // ─── channel.updated ───────────────────────────────────────────

  describe('channel.updated', () => {
    it('updates topic', () => {
      const store = createStore();
      store.setState({
        channels: { data: [makeChannel({ name: 'general', topic: 'old topic' })], loading: false, error: null },
      });

      handleServerEvent(store, {
        type: 'channel.updated',
        channel: { name: 'general', topic: 'new topic' },
      });

      const state = store.getState();
      expect(state.channels.data[0].topic).toBe('new topic');
    });
  });

  // ─── channel.archived ──────────────────────────────────────────

  describe('channel.archived', () => {
    it('sets isArchived true', () => {
      const store = createStore();
      store.setState({
        channels: { data: [makeChannel({ name: 'general', isArchived: false })], loading: false, error: null },
      });

      handleServerEvent(store, {
        type: 'channel.archived',
        channel: { name: 'general' },
      });

      const state = store.getState();
      expect(state.channels.data[0].isArchived).toBe(true);
    });
  });

  // ─── member.joined ─────────────────────────────────────────────

  describe('member.joined', () => {
    it('adds member to channel details', () => {
      const store = createStore();

      handleServerEvent(store, {
        type: 'member.joined',
        channel: 'general',
        agentName: 'Alice',
      });

      const state = store.getState();
      expect(state.channelDetails['general'].members).toHaveLength(1);
      expect(state.channelDetails['general'].members[0].agentName).toBe('Alice');
      expect(state.channelDetails['general'].members[0].role).toBe('member');
    });

    it('deduplicates by agentName', () => {
      const store = createStore();
      store.updateChannelDetail('general', () => ({
        channel: null,
        members: [{ agentId: '', agentName: 'Alice', role: 'member' as const, joinedAt: '2026-01-01T00:00:00Z' }],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'member.joined',
        channel: 'general',
        agentName: 'Alice',
      });

      const state = store.getState();
      expect(state.channelDetails['general'].members).toHaveLength(1);
    });
  });

  // ─── member.left ───────────────────────────────────────────────

  describe('member.left', () => {
    it('removes member from channel details', () => {
      const store = createStore();
      store.updateChannelDetail('general', () => ({
        channel: null,
        members: [
          { agentId: '', agentName: 'Alice', role: 'member' as const, joinedAt: '2026-01-01T00:00:00Z' },
          { agentId: '', agentName: 'Bob', role: 'member' as const, joinedAt: '2026-01-01T00:00:00Z' },
        ],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'member.left',
        channel: 'general',
        agentName: 'Alice',
      });

      const state = store.getState();
      expect(state.channelDetails['general'].members).toHaveLength(1);
      expect(state.channelDetails['general'].members[0].agentName).toBe('Bob');
    });
  });

  // ─── dm.received ───────────────────────────────────────────────

  describe('dm.received', () => {
    it('flags dms as loading', () => {
      const store = createStore();
      store.setState({ dms: { data: [], loading: false, error: null } });

      handleServerEvent(store, {
        type: 'dm.received',
        conversationId: 'conv1',
        message: { id: 'dm1', agentName: 'Alice', text: 'hi' },
      });

      const state = store.getState();
      expect(state.dms.loading).toBe(true);
    });
  });

  // ─── group_dm.received ─────────────────────────────────────────

  describe('group_dm.received', () => {
    it('flags dms as loading', () => {
      const store = createStore();
      store.setState({ dms: { data: [], loading: false, error: null } });

      handleServerEvent(store, {
        type: 'group_dm.received',
        conversationId: 'conv1',
        message: { id: 'dm1', agentName: 'Alice', text: 'hi group' },
      });

      const state = store.getState();
      expect(state.dms.loading).toBe(true);
    });
  });
});
