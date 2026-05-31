import type {
  WsClientEvent,
  MessageWithMeta,
} from '@relaycast/sdk';
import type { RelayStore } from './types.js';

type EventMessage = {
  id: string;
  agentName: string;
  agentId?: string;
  text: string;
  attachments?: MessageWithMeta['attachments'];
};

type MessageCreatedEvent = { channel: string; message: EventMessage };
type MessageUpdatedEvent = { channel: string; message: EventMessage };
type ThreadReplyEvent = { parentId: string; message: EventMessage };
type ReactionEvent = {
  messageId: string;
  emoji: string;
  agentName: string;
  threadId?: string;
};
type AgentPresenceEvent = {
  type: 'agent.online' | 'agent.offline';
  agent: { name: string };
};
type ChannelEvent = {
  channel: {
    name: string;
    topic: string | null;
  };
};
type ChannelArchivedEvent = {
  channel: {
    name: string;
  };
};
type MemberEvent = {
  channel: string;
  agentName: string;
};
type ReactionGroupView = {
  emoji: string;
  count: number;
  agents: string[];
};

export function handleServerEvent(store: RelayStore, event: WsClientEvent): void {
  const serverEvent = event as { type?: string };
  switch (serverEvent.type) {
    case 'message.created':
      handleMessageCreated(store, event as MessageCreatedEvent);
      break;
    case 'message.updated':
      handleMessageUpdated(store, event as MessageUpdatedEvent);
      break;
    case 'thread.reply':
      handleThreadReply(store, event as ThreadReplyEvent);
      break;
    case 'reaction.added':
      handleReactionAdded(store, event as ReactionEvent);
      break;
    case 'reaction.removed':
      handleReactionRemoved(store, event as ReactionEvent);
      break;
    case 'agent.online':
    case 'agent.offline':
      handlePresenceChange(store, event as AgentPresenceEvent);
      break;
    case 'channel.created':
      handleChannelCreated(store, event as ChannelEvent);
      break;
    case 'channel.updated':
      handleChannelUpdated(store, event as ChannelEvent);
      break;
    case 'channel.archived':
      handleChannelArchived(store, event as ChannelArchivedEvent);
      break;
    case 'member.joined':
      handleMemberJoined(store, event as MemberEvent);
      break;
    case 'member.left':
      handleMemberLeft(store, event as MemberEvent);
      break;
    case 'dm.received':
    case 'group_dm.received':
      handleDmReceived(store);
      break;
    default:
      break;
  }
}

function handleMessageCreated(store: RelayStore, event: MessageCreatedEvent): void {
  store.updateChannelMessages(event.channel, (prev) => {
    if (prev.messages.some((m) => m.id === event.message.id)) return prev;
    const msg: MessageWithMeta = {
      id: event.message.id,
      agentName: event.message.agentName,
      channelId: event.channel,
      agentId: event.message.agentId ?? '',
      text: event.message.text,
      blocks: null,
      hasAttachments: (event.message.attachments?.length ?? 0) > 0,
      threadId: null,
      attachments: event.message.attachments ?? [],
      createdAt: new Date().toISOString(),
      replyCount: 0,
      reactions: [],
      readByCount: 0,
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
  let inserted = false;

  store.updateThread(event.parentId, (prev) => {
    if (prev.replies.some((r) => r.id === event.message.id)) return prev;
    inserted = true;
    const reply: MessageWithMeta = {
      id: event.message.id,
      agentName: event.message.agentName,
      channelId: prev.parent?.channelId ?? '',
      agentId: event.message.agentId ?? '',
      text: event.message.text,
      blocks: null,
      hasAttachments: false,
      threadId: event.parentId,
      attachments: [],
      createdAt: new Date().toISOString(),
      replyCount: 0,
      reactions: [],
      readByCount: 0,
    };
    return { ...prev, replies: [...prev.replies, reply] };
  });

  if (!inserted) return;

  // Increment replyCount on parent in the thread cache
  store.updateThread(event.parentId, (prev) => (
    prev.parent
      ? { ...prev, parent: { ...prev.parent, replyCount: prev.parent.replyCount + 1 } }
      : prev
  ));

  // Increment replyCount on parent in channel timeline cache
  const state = store.getState();
  for (const channel of Object.keys(state.channelMessages)) {
    const msgs = state.channelMessages[channel].messages;
    const parentIdx = msgs.findIndex((m) => m.id === event.parentId);
    if (parentIdx !== -1) {
      store.updateChannelMessages(channel, (prev) => {
        const updated = [...prev.messages];
        const nextCount = Number.isFinite(updated[parentIdx].replyCount)
          ? updated[parentIdx].replyCount + 1
          : 1;
        updated[parentIdx] = { ...updated[parentIdx], replyCount: nextCount };
        return { ...prev, messages: updated };
      });
      break;
    }
  }
}

function updateReactionsOnMessage(
  messages: MessageWithMeta[],
  messageId: string,
  updater: (reactions: ReactionGroupView[]) => ReactionGroupView[],
): MessageWithMeta[] | null {
  const idx = messages.findIndex((m) => m.id === messageId);
  if (idx === -1) return null;
  const updated = [...messages];
  updated[idx] = {
    ...updated[idx],
    reactions: updater(updated[idx].reactions as ReactionGroupView[]) as MessageWithMeta['reactions'],
  };
  return updated;
}

function handleReactionAdded(store: RelayStore, event: ReactionEvent): void {
  const state = store.getState();

  // Update in channel messages
  for (const channel of Object.keys(state.channelMessages)) {
    store.updateChannelMessages(channel, (prev) => {
      const updated = updateReactionsOnMessage(prev.messages, event.messageId, (reactions) => {
        const existing = reactions.find((r) => r.emoji === event.emoji);
        if (existing) {
          if (existing.agents.includes(event.agentName)) return reactions;
          return reactions.map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: r.count + 1, agents: [...r.agents, event.agentName] }
              : r,
          );
        }
        return [...reactions, { emoji: event.emoji, count: 1, agents: [event.agentName] }];
      });
      return updated ? { ...prev, messages: updated } : prev;
    });
  }

  // Update in threads
  for (const threadId of Object.keys(state.threads)) {
    store.updateThread(threadId, (prev) => {
      const updatedReplies = updateReactionsOnMessage(prev.replies, event.messageId, (reactions) => {
        const existing = reactions.find((r) => r.emoji === event.emoji);
        if (existing) {
          if (existing.agents.includes(event.agentName)) return reactions;
          return reactions.map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: r.count + 1, agents: [...r.agents, event.agentName] }
              : r,
          );
        }
        return [...reactions, { emoji: event.emoji, count: 1, agents: [event.agentName] }];
      });
      if (updatedReplies) return { ...prev, replies: updatedReplies };
      // Check parent
      if (prev.parent && prev.parent.id === event.messageId) {
        const parentReactions = prev.parent.reactions as ReactionGroupView[];
        const existing = parentReactions.find((r) => r.emoji === event.emoji);
        let newReactions: ReactionGroupView[];
        if (existing) {
          if (existing.agents.includes(event.agentName)) return prev;
          newReactions = parentReactions.map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: r.count + 1, agents: [...r.agents, event.agentName] }
              : r,
          );
        } else {
          newReactions = [...prev.parent.reactions, { emoji: event.emoji, count: 1, agents: [event.agentName] }];
        }
        return { ...prev, parent: { ...prev.parent, reactions: newReactions } };
      }
      return prev;
    });
  }
}

function handleReactionRemoved(store: RelayStore, event: ReactionEvent): void {
  const state = store.getState();

  for (const channel of Object.keys(state.channelMessages)) {
    store.updateChannelMessages(channel, (prev) => {
      const updated = updateReactionsOnMessage(prev.messages, event.messageId, (reactions) => {
        return reactions
          .map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: Math.max(0, r.count - 1), agents: r.agents.filter((a) => a !== event.agentName) }
              : r,
          )
          .filter((r) => r.count > 0);
      });
      return updated ? { ...prev, messages: updated } : prev;
    });
  }

  for (const threadId of Object.keys(state.threads)) {
    store.updateThread(threadId, (prev) => {
      const updatedReplies = updateReactionsOnMessage(prev.replies, event.messageId, (reactions) => {
        return reactions
          .map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: Math.max(0, r.count - 1), agents: r.agents.filter((a) => a !== event.agentName) }
              : r,
          )
          .filter((r) => r.count > 0);
      });
      if (updatedReplies) return { ...prev, replies: updatedReplies };
      if (prev.parent && prev.parent.id === event.messageId) {
        const newReactions = (prev.parent.reactions as ReactionGroupView[])
          .map((r) =>
            r.emoji === event.emoji
              ? { ...r, count: Math.max(0, r.count - 1), agents: r.agents.filter((a) => a !== event.agentName) }
              : r,
          )
          .filter((r) => r.count > 0);
        return { ...prev, parent: { ...prev.parent, reactions: newReactions } };
      }
      return prev;
    });
  }
}

function handlePresenceChange(store: RelayStore, event: AgentPresenceEvent): void {
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
      workspaceId: '',
      name: event.agent.name,
      type: 'agent' as const,
      tokenHash: '',
      status: 'online' as const,
      persona: null,
      metadata: {},
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
    store.setState({ agents: { ...state.agents, data: [...state.agents.data, stub] } });
  }
}

function handleChannelCreated(store: RelayStore, event: ChannelEvent): void {
  const state = store.getState();
  const exists = state.channels.data.some((c) => c.name === event.channel.name);
  if (exists) return;
  const newChannel = {
    id: '',
    workspaceId: '',
    name: event.channel.name,
    channelType: 0,
    topic: event.channel.topic,
    createdBy: null,
    createdAt: new Date().toISOString(),
    isArchived: false,
    memberCount: 1,
  };
  store.setState({
    channels: { ...state.channels, data: [...state.channels.data, newChannel] },
  });
}

function handleChannelUpdated(store: RelayStore, event: ChannelEvent): void {
  const state = store.getState();
  const updated = state.channels.data.map((c) =>
    c.name === event.channel.name ? { ...c, topic: event.channel.topic } : c,
  );
  store.setState({ channels: { ...state.channels, data: updated } });
}

function handleChannelArchived(store: RelayStore, event: ChannelArchivedEvent): void {
  const state = store.getState();
  const updated = state.channels.data.map((c) =>
    c.name === event.channel.name ? { ...c, isArchived: true } : c,
  );
  store.setState({ channels: { ...state.channels, data: updated } });
}

function handleMemberJoined(store: RelayStore, event: MemberEvent): void {
  store.updateChannelDetail(event.channel, (prev) => {
    if (prev.members.some((m) => m.agentName === event.agentName)) return prev;
    const newMember = {
      agentId: '',
      agentName: event.agentName,
      role: 'member' as const,
      joinedAt: new Date().toISOString(),
    };
    return { ...prev, members: [...prev.members, newMember] };
  });
  // Increment memberCount on the channel list entry
  const state = store.getState();
  const updated = state.channels.data.map((c) =>
    c.name === event.channel ? { ...c, memberCount: (c.memberCount ?? 0) + 1 } : c,
  );
  store.setState({ channels: { ...state.channels, data: updated } });
}

function handleMemberLeft(store: RelayStore, event: MemberEvent): void {
  store.updateChannelDetail(event.channel, (prev) => ({
    ...prev,
    members: prev.members.filter((m) => m.agentName !== event.agentName),
  }));
  // Decrement memberCount on the channel list entry
  const state = store.getState();
  const updated = state.channels.data.map((c) =>
    c.name === event.channel ? { ...c, memberCount: Math.max(0, (c.memberCount ?? 1) - 1) } : c,
  );
  store.setState({ channels: { ...state.channels, data: updated } });
}

function handleDmReceived(store: RelayStore): void {
  // Flag DMs as needing refresh — the useDMs hook will detect loading: true
  // and the next time it renders, it will refetch
  const state = store.getState();
  store.setState({ dms: { ...state.dms, loading: true } });
}
