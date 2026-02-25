import type { MessageWithMeta } from '@relaycast/sdk';

export interface ThreadSummaryViewModel {
  threadId: string;
  replyCount: number;
  participants: string[];
  lastReplyAt: number;
}

export interface ChannelMessageViewModel {
  id: string;
  channelId: string;
  from: string;
  fromEntityType: 'agent' | 'user';
  content: string;
  timestamp: string;
  threadId?: string;
  threadSummary?: ThreadSummaryViewModel;
  reactions?: Record<string, string[]>;
  isRead: boolean;
}

export interface ChannelMessageAdapterOptions {
  currentUserName?: string;
}

function toMessageTimestampMs(message: MessageWithMeta): number {
  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortMessagesChronologically(messages: MessageWithMeta[]): MessageWithMeta[] {
  return [...messages].sort((a, b) => {
    const tsDiff = toMessageTimestampMs(a) - toMessageTimestampMs(b);
    if (tsDiff !== 0) return tsDiff;
    return a.id.localeCompare(b.id);
  });
}

export function formatReplyCountLabel(replyCount: number): string {
  const normalized = Number.isFinite(replyCount) ? Math.max(0, Math.floor(replyCount)) : 0;
  return normalized === 1 ? '1 reply' : `${normalized} replies`;
}

export function mapMessageWithMetaToChannelMessage(
  channelId: string,
  message: MessageWithMeta,
  options?: ChannelMessageAdapterOptions,
): ChannelMessageViewModel {
  const replyCount = typeof message.replyCount === 'number' ? message.replyCount : 0;
  const rawThreadId = (message as { threadId?: string | null }).threadId;
  const threadId = typeof rawThreadId === 'string' && rawThreadId.trim().length > 0
    ? rawThreadId
    : undefined;

  return {
    id: message.id,
    channelId,
    from: message.agentName,
    fromEntityType: message.agentName === options?.currentUserName ? 'user' : 'agent',
    content: message.text,
    timestamp: message.createdAt,
    threadId,
    threadSummary: replyCount > 0
      ? {
        threadId: message.id,
        replyCount,
        participants: [],
        lastReplyAt: Date.parse(message.createdAt) || 0,
      }
      : undefined,
    reactions: message.reactions
      ? Object.fromEntries(message.reactions.map((reaction) => [reaction.emoji, reaction.agents]))
      : undefined,
    isRead: true,
  };
}
