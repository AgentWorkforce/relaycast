// Provider
export { RelayProvider } from './provider.js';
export type { RelayProviderProps } from './provider.js';

// Data hooks
export { useMessages } from './hooks/useMessages.js';
export { useThread } from './hooks/useThread.js';
export { useChannels } from './hooks/useChannels.js';
export { useChannel } from './hooks/useChannel.js';
export { useInbox } from './hooks/useInbox.js';
export { usePresence } from './hooks/usePresence.js';
export { useDMs } from './hooks/useDMs.js';
export { useSearch } from './hooks/useSearch.js';

// Mutation hooks
export { useSendMessage } from './hooks/useSendMessage.js';
export { useReply } from './hooks/useReply.js';
export { useReaction } from './hooks/useReaction.js';
export { useSendDM } from './hooks/useSendDM.js';

// Utility hooks
export { useRelay } from './hooks/useRelay.js';
export { useAgent } from './hooks/useAgent.js';
export { useRelayClient } from './hooks/useRelayClient.js';
export { useWebSocket } from './hooks/useWebSocket.js';
export { useEvent } from './hooks/useEvent.js';
export type { ClientContextValue } from './context.js';

// Types
export type {
  UseMessagesReturn,
  UseThreadReturn,
  UseChannelsReturn,
  UseChannelReturn,
  UseInboxReturn,
  UsePresenceReturn,
  UseDMsReturn,
  UseSearchReturn,
  UseWebSocketReturn,
  UseSendMessageReturn,
  UseReplyReturn,
  UseReactionReturn,
  UseSendDMReturn,
  ConnectionStatus,
} from './types.js';
