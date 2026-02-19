import type {
  ServerEvent,
  MessageCreatedEvent,
  MessageUpdatedEvent,
  ThreadReplyEvent,
  ReactionAddedEvent,
  ReactionRemovedEvent,
  AgentOnlineEvent,
  AgentOfflineEvent,
  ChannelCreatedEvent,
  ChannelUpdatedEvent,
  ChannelArchivedEvent,
  MemberJoinedEvent,
  MemberLeftEvent,
  MessageWithMeta,
  ReactionGroup,
} from '@relaycast/types';
import type { RelayStore } from './types.js';

export function handleServerEvent(store: RelayStore, event: ServerEvent): void {
  switch (event.type) {
    case 'message.created':
      handleMessageCreated(store, event);
      break;
    case 'message.updated':
      handleMessageUpdated(store, event);
      break;
    case 'thread.reply':
      handleThreadReply(store, event);
      break;
    case 'reaction.added':
      handleReactionAdded(store, event);
      break;
    case 'reaction.removed':
      handleReactionRemoved(store, event);
      break;
    case 'agent.online':
    case 'agent.offline':
      handlePresenceChange(store, event);
      break;
    case 'channel.created':
      handleChannelCreated(store, event);
      break;
    case 'channel.updated':
      handleChannelUpdated(store, event);
      break;
    case 'channel.archived':
      handleChannelArchived(store, event);
      break;
    case 'member.joined':
      handleMemberJoined(store, event);
      break;
    case 'member.left':
      handleMemberLeft(store, event);
      break;
    case 'dm.received':
    case 'group_dm.received':
      handleDmReceived(store);
      break;
  }
}

function handleMessageCreated(store: RelayStore, event: MessageCreatedEvent): void {
  store.updateChannelMessages(event.channel, (prev) => {
    if (prev.messages.some((m) => m.id === event.message.id)) return prev;
    const msg: MessageWithMeta = {
      id: event.message.id,
      agent_name: event.message.agent_name,
      agent_id: '',
      text: event.message.text,
      blocks: null,
      attachments: event.message.attachments ?? [],
      created_at: new Date().toISOString(),
      reply_count: 0,
      reactions: [],
      read_by_count: 0,
    };
    return { ...prev, messages: [...prev.messages, msg] };
  });
}

function handleMessageUpdated(store: RelayStore, event: MessageUpdatedEvent): void {
  store.updateChannelMessages(event.channel, (prev) => {
    const idx = prev.messages.findIndex((m) => m.id === event.message.id);
    if (idx === -1) return prev;
    const updated = [...prev.messages];
    updated[idx] = { ...updated[idx], text: event.message.text };
    return { ...prev, messages: updated };
  });
}

function handleThreadReply(store: RelayStore, event: ThreadReplyEvent): void {
  store.updateThread(event.parent_id, (prev) => {
    if (prev.replies.some((r) => r.id === event.message.id)) return prev;
    const reply: MessageWithMeta = {
      id: event.message.id,
      agent_name: event.message.agent_name,
      agent_id: '',
      text: event.message.text,
      blocks: null,
      attachments: [],
      created_at: new Date().toISOString(),
      reply_count: 0,
      reactions: [],
      read_by_count: 0,
    };
    return { ...prev, replies: [...prev.replies, reply] };
  });

  // Increment reply_count on parent in all channel caches
  const state = store.getState();
  for (const channel of Object.keys(state.channelMessages)) {
    const msgs = state.channelMessages[channel].messages;
    const parentIdx = msgs.findIndex((m) => m.id === event.parent_id);
    if (parentIdx !== -1) {
      store.updateChannelMessages(channel, (prev) => {
        const updated = [...prev.messages];
        updated[parentIdx] = { ...updated[parentIdx], reply_count: updated[parentIdx].reply_count + 1 };
        return { ...prev, messages: updated };
      });
      break;
    }
  }
}

function updateReactionsOnMessage(
  messages: MessageWithMeta[],
  messageId: string,
  updater: (reactions: ReactionGroup[]) => ReactionGroup[],
): MessageWithMeta[] | null {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return null;
  const updated = [...messages];
  updated[idx] = { ...updated[idx], reactions: updater(updated[idx].reactions) };
  return updated;
}

function handleReactionAdded(store: RelayStore, event: ReactionAddedEvent): void {
  const state = store.getState();

  // Update in channel messages
  for (const channel of Object.keys(state.channelMessages)) {
    store.updateChannelMessages(channel, (prev) => {
      const updated = updateReactionsOnMessage(prev.messages, event.message_id, (reactions) => {
        const existing = reactions.find((r) => r.emoji === event.emoji);
        if (existing) {
          if (existing.agents.includes(event.agent_name)) return reactions;
          return reactions.map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: r.count + 1, agents: [...r.agents, event.agent_name] }
              : r,
          );
        }
        return [...reactions, { emoji: event.emoji, count: 1, agents: [event.agent_name] }];
      });
      return updated ? { ...prev, messages: updated } : prev;
    });
  }

  // Update in threads
  for (const threadId of Object.keys(state.threads)) {
    store.updateThread(threadId, (prev) => {
      const updatedReplies = updateReactionsOnMessage(prev.replies, event.message_id, (reactions) => {
        const existing = reactions.find((r) => r.emoji === event.emoji);
        if (existing) {
          if (existing.agents.includes(event.agent_name)) return reactions;
          return reactions.map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: r.count + 1, agents: [...r.agents, event.agent_name] }
              : r,
          );
        }
        return [...reactions, { emoji: event.emoji, count: 1, agents: [event.agent_name] }];
      });
      if (updatedReplies) return { ...prev, replies: updatedReplies };
      // Check parent
      if (prev.parent && prev.parent.id === event.message_id) {
        const existing = prev.parent.reactions.find((r) => r.emoji === event.emoji);
        let newReactions: ReactionGroup[];
        if (existing) {
          if (existing.agents.includes(event.agent_name)) return prev;
          newReactions = prev.parent.reactions.map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: r.count + 1, agents: [...r.agents, event.agent_name] }
              : r,
          );
        } else {
          newReactions = [...prev.parent.reactions, { emoji: event.emoji, count: 1, agents: [event.agent_name] }];
        }
        return { ...prev, parent: { ...prev.parent, reactions: newReactions } };
      }
      return prev;
    });
  }
}

function handleReactionRemoved(store: RelayStore, event: ReactionRemovedEvent): void {
  const state = store.getState();

  for (const channel of Object.keys(state.channelMessages)) {
    store.updateChannelMessages(channel, (prev) => {
      const updated = updateReactionsOnMessage(prev.messages, event.message_id, (reactions) => {
        return reactions
          .map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: Math.max(0, r.count - 1), agents: r.agents.filter((a) => a !== event.agent_name) }
              : r,
          )
          .filter((r) => r.count > 0);
      });
      return updated ? { ...prev, messages: updated } : prev;
    });
  }

  for (const threadId of Object.keys(state.threads)) {
    store.updateThread(threadId, (prev) => {
      const updatedReplies = updateReactionsOnMessage(prev.replies, event.message_id, (reactions) => {
        return reactions
          .map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: Math.max(0, r.count - 1), agents: r.agents.filter((a) => a !== event.agent_name) }
              : r,
          )
          .filter((r) => r.count > 0);
      });
      if (updatedReplies) return { ...prev, replies: updatedReplies };
      if (prev.parent && prev.parent.id === event.message_id) {
        const newReactions = prev.parent.reactions
          .map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: Math.max(0, r.count - 1), agents: r.agents.filter((a) => a !== event.agent_name) }
              : r,
          )
          .filter((r) => r.count > 0);
        return { ...prev, parent: { ...prev.parent, reactions: newReactions } };
      }
      return prev;
    });
  }
}

function handlePresenceChange(store: RelayStore, event: AgentOnlineEvent | AgentOfflineEvent): void {
  const state = store.getState();
  const newStatus = event.type === 'agent.online' ? 'online' : 'offline';
  const exists = state.agents.data.some((a) => a.name === event.agent.name);

  if (exists) {
    const updated = state.agents.data.map((a) =>
      a.name === event.agent.name ? { ...a, status: newStatus as typeof a.status } : a,
    );
    store.setState({ agents: { ...state.agents, data: updated } });
  } else if (event.type === 'agent.online') {
    // Agent came online but wasn't in the initial fetch — add a stub entry
    const stub = {
      id: '',
      workspace_id: '',
      name: event.agent.name,
      type: 'agent' as const,
      token_hash: '',
      status: 'online' as const,
      persona: null,
      metadata: {},
      created_at: new Date().toISOString(),
      last_seen: new Date().toISOString(),
    };
    store.setState({ agents: { ...state.agents, data: [...state.agents.data, stub] } });
  }
}

function handleChannelCreated(store: RelayStore, event: ChannelCreatedEvent): void {
  const state = store.getState();
  const exists = state.channels.data.some((c) => c.name === event.channel.name);
  if (exists) return;
  const newChannel = {
    id: '',
    workspace_id: '',
    name: event.channel.name,
    channel_type: 0,
    topic: event.channel.topic,
    created_by: null,
    created_at: new Date().toISOString(),
    is_archived: false,
    member_count: 1,
  };
  store.setState({
    channels: { ...state.channels, data: [...state.channels.data, newChannel] },
  });
}

function handleChannelUpdated(store: RelayStore, event: ChannelUpdatedEvent): void {
  const state = store.getState();
  const updated = state.channels.data.map((c) =>
    c.name === event.channel.name ? { ...c, topic: event.channel.topic } : c,
  );
  store.setState({ channels: { ...state.channels, data: updated } });
}

function handleChannelArchived(store: RelayStore, event: ChannelArchivedEvent): void {
  const state = store.getState();
  const updated = state.channels.data.map((c) =>
    c.name === event.channel.name ? { ...c, is_archived: true } : c,
  );
  store.setState({ channels: { ...state.channels, data: updated } });
}

function handleMemberJoined(store: RelayStore, event: MemberJoinedEvent): void {
  store.updateChannelDetail(event.channel, (prev) => {
    if (prev.members.some((m) => m.agent_name === event.agent_name)) return prev;
    const newMember = {
      agent_id: '',
      agent_name: event.agent_name,
      role: 'member' as const,
      joined_at: new Date().toISOString(),
    };
    return { ...prev, members: [...prev.members, newMember] };
  });
  // Increment member_count on the channel list entry
  const state = store.getState();
  const updated = state.channels.data.map((c) =>
    c.name === event.channel ? { ...c, member_count: (c.member_count ?? 0) + 1 } : c,
  );
  store.setState({ channels: { ...state.channels, data: updated } });
}

function handleMemberLeft(store: RelayStore, event: MemberLeftEvent): void {
  store.updateChannelDetail(event.channel, (prev) => ({
    ...prev,
    members: prev.members.filter((m) => m.agent_name !== event.agent_name),
  }));
  // Decrement member_count on the channel list entry
  const state = store.getState();
  const updated = state.channels.data.map((c) =>
    c.name === event.channel ? { ...c, member_count: Math.max(0, (c.member_count ?? 1) - 1) } : c,
  );
  store.setState({ channels: { ...state.channels, data: updated } });
}

function handleDmReceived(store: RelayStore): void {
  // Flag DMs as needing refresh — the useDMs hook will detect loading: true
  // and the next time it renders, it will refetch
  const state = store.getState();
  store.setState({ dms: { ...state.dms, loading: true } });
}
