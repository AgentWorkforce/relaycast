import { describe, it, expect } from 'vitest';
import { createStore } from '../store.js';
import { handleServerEvent } from '../reducer.js';
import type { MessageWithMeta } from '@relaycast/types';

function makeMessage(overrides: Partial<MessageWithMeta> = {}): MessageWithMeta {
  return {
    id: 'msg1',
    agent_name: 'Alice',
    agent_id: 'a1',
    text: 'hello',
    blocks: null,
    attachments: [],
    created_at: '2026-01-01T00:00:00Z',
    reply_count: 0,
    reactions: [],
    read_by_count: 0,
    ...overrides,
  };
}

function makeChannel(overrides: Partial<{ id: string; workspace_id: string; name: string; channel_type: number; topic: string | null; created_by: string | null; created_at: string; is_archived: boolean }> = {}) {
  return {
    id: 'ch1',
    workspace_id: 'ws1',
    name: 'general',
    channel_type: 0,
    topic: null,
    created_by: null,
    created_at: '2026-01-01T00:00:00Z',
    is_archived: false,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<{ id: string; workspace_id: string; name: string; type: 'agent' | 'human'; token_hash: string; status: 'online' | 'offline' | 'away'; persona: string | null; metadata: Record<string, unknown>; created_at: string; last_seen: string }> = {}) {
  return {
    id: 'ag1',
    workspace_id: 'ws1',
    name: 'Alice',
    type: 'agent' as const,
    token_hash: '',
    status: 'online' as const,
    persona: null,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    last_seen: '2026-01-01T00:00:00Z',
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
        message: { id: 'msg1', agent_name: 'Alice', text: 'hello', attachments: [] },
      });

      const state = store.getState();
      expect(state.channelMessages['general'].messages).toHaveLength(1);
      expect(state.channelMessages['general'].messages[0].id).toBe('msg1');
      expect(state.channelMessages['general'].messages[0].agent_name).toBe('Alice');
      expect(state.channelMessages['general'].messages[0].text).toBe('hello');
    });

    it('deduplicates by id', () => {
      const store = createStore();

      handleServerEvent(store, {
        type: 'message.created',
        channel: 'general',
        message: { id: 'msg1', agent_name: 'Alice', text: 'hello', attachments: [] },
      });
      handleServerEvent(store, {
        type: 'message.created',
        channel: 'general',
        message: { id: 'msg1', agent_name: 'Alice', text: 'hello again', attachments: [] },
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
        message: { id: 'msg1', agent_name: 'Alice', text: 'edited' },
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
        message: { id: 'msg999', agent_name: 'Alice', text: 'edited' },
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
        parent_id: 'msg1',
        message: { id: 'reply1', agent_name: 'Bob', text: 'reply text' },
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
        parent_id: 'msg1',
        message: { id: 'reply1', agent_name: 'Bob', text: 'reply text' },
      });
      handleServerEvent(store, {
        type: 'thread.reply',
        parent_id: 'msg1',
        message: { id: 'reply1', agent_name: 'Bob', text: 'reply text duplicate' },
      });

      const state = store.getState();
      expect(state.threads['msg1'].replies).toHaveLength(1);
      expect(state.threads['msg1'].replies[0].text).toBe('reply text');
    });

    it('increments parent reply_count in channel messages', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({ id: 'msg1', reply_count: 0 })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'thread.reply',
        parent_id: 'msg1',
        message: { id: 'reply1', agent_name: 'Bob', text: 'reply text' },
      });

      const state = store.getState();
      expect(state.channelMessages['general'].messages[0].reply_count).toBe(1);
    });
  });

  // ─── reaction.added ────────────────────────────────────────────

  describe('reaction.added', () => {
    it('creates new ReactionGroup if emoji not present', () => {
      const store = createStore();
      store.updateChannelMessages('general', () => ({
        messages: [makeMessage({ id: 'msg1', reactions: [] })],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'reaction.added',
        message_id: 'msg1',
        emoji: 'thumbsup',
        agent_name: 'Alice',
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
        type: 'reaction.added',
        message_id: 'msg1',
        emoji: 'thumbsup',
        agent_name: 'Bob',
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
        type: 'reaction.added',
        message_id: 'msg1',
        emoji: 'thumbsup',
        agent_name: 'Alice',
      });

      const state = store.getState();
      const reactions = state.channelMessages['general'].messages[0].reactions;
      expect(reactions).toHaveLength(1);
      expect(reactions[0].count).toBe(1);
      expect(reactions[0].agents).toEqual(['Alice']);
    });
  });

  // ─── reaction.removed ──────────────────────────────────────────

  describe('reaction.removed', () => {
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
        type: 'reaction.removed',
        message_id: 'msg1',
        emoji: 'thumbsup',
        agent_name: 'Bob',
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
        type: 'reaction.removed',
        message_id: 'msg1',
        emoji: 'thumbsup',
        agent_name: 'Alice',
      });

      const state = store.getState();
      const reactions = state.channelMessages['general'].messages[0].reactions;
      expect(reactions).toHaveLength(0);
    });
  });

  // ─── agent.online / agent.offline ──────────────────────────────

  describe('agent.online', () => {
    it('updates agent status to online', () => {
      const store = createStore();
      const agent = makeAgent({ name: 'Alice', status: 'offline' });
      store.setState({ agents: { data: [agent], loading: false, error: null } });

      handleServerEvent(store, {
        type: 'agent.online',
        agent: { name: 'Alice' },
      });

      const state = store.getState();
      expect(state.agents.data[0].status).toBe('online');
    });
  });

  describe('agent.offline', () => {
    it('updates agent status to offline', () => {
      const store = createStore();
      const agent = makeAgent({ name: 'Alice', status: 'online' });
      store.setState({ agents: { data: [agent], loading: false, error: null } });

      handleServerEvent(store, {
        type: 'agent.offline',
        agent: { name: 'Alice' },
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
      expect(state.channels.data[0].is_archived).toBe(false);
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
    it('sets is_archived true', () => {
      const store = createStore();
      store.setState({
        channels: { data: [makeChannel({ name: 'general', is_archived: false })], loading: false, error: null },
      });

      handleServerEvent(store, {
        type: 'channel.archived',
        channel: { name: 'general' },
      });

      const state = store.getState();
      expect(state.channels.data[0].is_archived).toBe(true);
    });
  });

  // ─── member.joined ─────────────────────────────────────────────

  describe('member.joined', () => {
    it('adds member to channel details', () => {
      const store = createStore();

      handleServerEvent(store, {
        type: 'member.joined',
        channel: 'general',
        agent_name: 'Alice',
      });

      const state = store.getState();
      expect(state.channelDetails['general'].members).toHaveLength(1);
      expect(state.channelDetails['general'].members[0].agent_name).toBe('Alice');
      expect(state.channelDetails['general'].members[0].role).toBe('member');
    });

    it('deduplicates by agent_name', () => {
      const store = createStore();
      store.updateChannelDetail('general', () => ({
        channel: null,
        members: [{ agent_id: '', agent_name: 'Alice', role: 'member' as const, joined_at: '2026-01-01T00:00:00Z' }],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'member.joined',
        channel: 'general',
        agent_name: 'Alice',
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
          { agent_id: '', agent_name: 'Alice', role: 'member' as const, joined_at: '2026-01-01T00:00:00Z' },
          { agent_id: '', agent_name: 'Bob', role: 'member' as const, joined_at: '2026-01-01T00:00:00Z' },
        ],
        loading: false,
        error: null,
      }));

      handleServerEvent(store, {
        type: 'member.left',
        channel: 'general',
        agent_name: 'Alice',
      });

      const state = store.getState();
      expect(state.channelDetails['general'].members).toHaveLength(1);
      expect(state.channelDetails['general'].members[0].agent_name).toBe('Bob');
    });
  });

  // ─── dm.received ───────────────────────────────────────────────

  describe('dm.received', () => {
    it('flags dms as loading', () => {
      const store = createStore();
      store.setState({ dms: { data: [], loading: false, error: null } });

      handleServerEvent(store, {
        type: 'dm.received',
        conversation_id: 'conv1',
        message: { id: 'dm1', agent_name: 'Alice', text: 'hi' },
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
        conversation_id: 'conv1',
        message: { id: 'dm1', agent_name: 'Alice', text: 'hi group' },
      });

      const state = store.getState();
      expect(state.dms.loading).toBe(true);
    });
  });
});
