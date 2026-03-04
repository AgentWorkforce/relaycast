'use client';

import { useEffect, useRef, useState } from 'react';
import { Hash, MessageSquare, UserRound } from 'lucide-react';
import { useMessages, sortMessagesChronologically } from '@relaycast/react';
import { MessageCard } from './MessageCard';
import type { MessageWithMeta } from '@relaycast/sdk';

interface ChatFeedProps {
  selectedChannel: string | null;
  selectedChannelMemberCount?: number | null;
  dmLabel?: string;
  onOpenThread?: (messageId: string) => void;
  mentionNames?: string[];
  onOpenAgent?: (agentName: string | null) => void;
}

export function ChatFeed({
  selectedChannel,
  selectedChannelMemberCount,
  dmLabel,
  onOpenThread,
  mentionNames,
  onOpenAgent,
}: ChatFeedProps) {
  const isDm = selectedChannel?.startsWith('dm:');
  const channelName = selectedChannel && !isDm ? selectedChannel : null;
  const dmId = isDm ? selectedChannel!.slice(3) : null;

  const title = selectedChannel
    ? isDm
      ? dmLabel || 'Direct Message'
      : `#${selectedChannel}`
    : 'Select a channel';
  const memberCount = selectedChannelMemberCount ?? 0;
  const showMemberBadge = !!channelName;

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border-default)] flex items-center gap-2 shrink-0">
        {selectedChannel && !isDm ? (
          <Hash className="h-4 w-4 text-[var(--color-text-muted)]" />
        ) : (
          <MessageSquare className="h-4 w-4 text-[var(--color-text-muted)]" />
        )}
        <h2 className="font-semibold text-sm text-[var(--color-text-primary)] flex-1">{title}</h2>
        {showMemberBadge && (
          <span className="inline-flex items-center gap-1.5 rounded-2xl border border-[var(--color-border-default)] px-2.5 py-1 text-sm text-[var(--color-text-primary)] bg-[var(--color-bg-secondary)] shrink-0">
            <UserRound className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
            <span>{memberCount}</span>
          </span>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {channelName ? (
          <ChannelMessages
            channel={channelName}
            onOpenThread={onOpenThread}
            mentionNames={mentionNames}
            onOpenAgent={onOpenAgent}
          />
        ) : dmId ? (
          <DmMessages
            conversationId={dmId}
            mentionNames={mentionNames}
            onOpenAgent={onOpenAgent}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-dim)]">
            <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">Select a channel to view messages</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ChannelMessages({
  channel,
  onOpenThread,
  mentionNames,
  onOpenAgent,
}: {
  channel: string;
  onOpenThread?: (messageId: string) => void;
  mentionNames?: string[];
  onOpenAgent?: (agentName: string | null) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { messages, loading } = useMessages(channel);

  const sorted = sortMessagesChronologically(messages);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sorted.length]);

  if (loading && sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-dim)]">
        <div className="animate-spin h-6 w-6 border-2 border-indigo-500 border-t-transparent rounded-full mb-2" />
        <p className="text-sm">Loading messages...</p>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-dim)]">
        <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
        <p className="text-sm">No messages yet</p>
      </div>
    );
  }

  return (
    <div className="py-2">
      {sorted.map((msg, i) => {
        const prev = i > 0 ? sorted[i - 1] : null;
        const compact =
          prev !== null &&
          prev.agentName === msg.agentName &&
          new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 300000;
        return (
          <MessageCard
            key={msg.id}
            message={msg}
            compact={compact}
            onOpenThread={onOpenThread}
            mentionNames={mentionNames}
            onOpenAgent={onOpenAgent}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function DmMessages({
  conversationId,
  mentionNames,
  onOpenAgent,
}: {
  conversationId: string;
  mentionNames?: string[];
  onOpenAgent?: (agentName: string | null) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<MessageWithMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/dms/${encodeURIComponent(conversationId)}/messages`)
      .then((res) => res.json())
      .then((data) => {
        const msgs = (data.messages ?? []).map((m: Record<string, unknown>) => ({
          id: m.id as string,
          agentName: (m.agentName as string) || 'unknown',
          agentId: (m.agentId as string) || '',
          text: (m.text as string) || '',
          blocks: null,
          attachments: [],
          createdAt: (m.createdAt as string) || new Date().toISOString(),
          replyCount: 0,
          reactions: [],
          readByCount: 0,
        }));
        setMessages(msgs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [conversationId]);

  const sorted = sortMessagesChronologically(messages);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sorted.length]);

  if (loading && sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-dim)]">
        <div className="animate-spin h-6 w-6 border-2 border-indigo-500 border-t-transparent rounded-full mb-2" />
        <p className="text-sm">Loading messages...</p>
      </div>
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-dim)]">
        <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
        <p className="text-sm">No messages in this conversation</p>
      </div>
    );
  }

  return (
    <div className="py-2">
      {sorted.map((msg, i) => {
        const prev = i > 0 ? sorted[i - 1] : null;
        const compact =
          prev !== null &&
          prev.agentName === msg.agentName &&
          new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 300000;
        return (
          <MessageCard
            key={msg.id}
            message={msg}
            compact={compact}
            mentionNames={mentionNames}
            onOpenAgent={onOpenAgent}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
