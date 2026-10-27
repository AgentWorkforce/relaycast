import type {
  MessageWithMeta,
  SearchMessageResult,
  Channel,
  ChannelMemberInfo,
  Agent,
  InboxResponse,
  DmConversationSummary,
  MessageBlock,
} from '@relaycast/sdk';

// === Connection status ===

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

// === Store slices ===

export interface ChannelMessages {
  messages: MessageWithMeta[];
  loading: boolean;
  error: Error | null;
}

export interface ThreadData {
  parent: MessageWithMeta | null;
  replies: MessageWithMeta[];
  loading: boolean;
  error: Error | null;
}

export interface ChannelDetail {
  channel: Channel | null;
  members: ChannelMemberInfo[];
  loading: boolean;
  error: Error | null;
}

// === Store state ===

export interface StoreState {
  channelMessages: Record<string, ChannelMessages>;
  threads: Record<string, ThreadData>;
  channels: { data: Channel[]; loading: boolean; error: Error | null };
  channelDetails: Record<string, ChannelDetail>;
  agents: { data: Agent[]; loading: boolean; error: Error | null };
  inbox: { data: InboxResponse | null; loading: boolean; error: Error | null };
  dms: { data: DmConversationSummary[]; loading: boolean; error: Error | null };
  connectionStatus: ConnectionStatus;
}

// === Store interface ===

export type Listener = () => void;

export interface RelayStore {
  getState(): StoreState;
  setState(partial: Partial<StoreState>): void;
  updateChannelMessages(channel: string, updater: (prev: ChannelMessages) => ChannelMessages): void;
  updateThread(messageId: string, updater: (prev: ThreadData) => ThreadData): void;
  updateChannelDetail(name: string, updater: (prev: ChannelDetail) => ChannelDetail): void;
  subscribe(listener: Listener): () => void;
}

// === Hook return types ===

export interface UseMessagesReturn {
  messages: MessageWithMeta[];
  loading: boolean;
  error: Error | null;
  /** Fetch the previous page of messages. Resolves with the number of older messages added (0 = history exhausted). */
  fetchMore: () => Promise<number>;
}

export interface UseThreadReturn {
  parent: MessageWithMeta | null;
  replies: MessageWithMeta[];
  loading: boolean;
  error: Error | null;
}

export interface UseChannelsReturn {
  channels: Channel[];
  loading: boolean;
  error: Error | null;
}

export interface UseChannelsOptions {
  includeArchived?: boolean;
}

export interface UseChannelReturn {
  channel: Channel | null;
  members: ChannelMemberInfo[];
  loading: boolean;
  error: Error | null;
}

export interface UseInboxReturn {
  inbox: InboxResponse | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

export interface UsePresenceReturn {
  agents: Agent[];
  loading: boolean;
  error: Error | null;
}

export interface UseDMsReturn {
  conversations: DmConversationSummary[];
  loading: boolean;
  error: Error | null;
}

export interface UseSearchReturn {
  results: SearchMessageResult[];
  loading: boolean;
  error: Error | null;
}

export interface UseWebSocketReturn {
  status: ConnectionStatus;
}

export interface UseSendMessageReturn {
  send: (channel: string, text: string, opts?: { attachments?: string[]; blocks?: MessageBlock[] }) => Promise<MessageWithMeta>;
  sending: boolean;
}

export interface UseReplyReturn {
  reply: (messageId: string, text: string) => Promise<MessageWithMeta>;
  sending: boolean;
}

export interface UseReactionReturn {
  react: (messageId: string, emoji: string) => Promise<void>;
  unreact: (messageId: string, emoji: string) => Promise<void>;
}

export interface UseSendDMReturn {
  send: (agent: string, text: string) => Promise<void>;
  sending: boolean;
}
