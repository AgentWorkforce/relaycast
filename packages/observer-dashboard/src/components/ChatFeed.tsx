'use client';

import { useEffect, useRef, useState } from 'react';
import { Hash, MessageSquare, UserRound } from 'lucide-react';
import { useMessages, useRelay, sortMessagesChronologically } from '@relaycast/react';
import { MessageCard } from './MessageCard';
import { cn } from '../lib/utils';
import type { MessageWithMeta } from '@relaycast/sdk';

interface ChatFeedProps {
  selectedChannel: string | null;
  selectedChannelMemberCount?: number | null;
  selectedChannelArchived?: boolean;
  dmLabel?: string;
  onOpenThread?: (messageId: string) => void;
  mentionNames?: string[];
  onOpenAgent?: (agentName: string | null) => void;
  className?: string;
}

export function ChatFeed({
  selectedChannel,
  selectedChannelMemberCount,
  selectedChannelArchived = false,
  dmLabel,
  onOpenThread,
  mentionNames,
  onOpenAgent,
  className,
}: ChatFeedProps) {
  const isDm = selectedChannel?.startsWith('dm:');
  const channelName = selectedChannel && !isDm ? selectedChannel : null;
  const dmId = isDm ? selectedChannel!.slice(3) : null;

  const title = selectedChannel ? (isDm ? dmLabel || 'Direct Message' : `#${selectedChannel}`) : 'Select a channel';
  const memberCount = selectedChannelMemberCount ?? 0;
  const showMemberBadge = !!channelName;

  return (
    <section className={cn('brand-card flex min-w-0 flex-1 flex-col overflow-hidden', className)}>
      <div className="border-b border-[var(--border-default)] px-5 py-4">
        <div className="flex items-center gap-2">
          {selectedChannel && !isDm ? (
            <Hash className="h-4 w-4 text-[var(--brand-primary)]" />
          ) : (
            <MessageSquare className="h-4 w-4 text-[var(--brand-primary)]" />
          )}
          <h2 className="brand-title flex-1 text-base font-semibold text-[var(--foreground)]">{title}</h2>
          {showMemberBadge && selectedChannelArchived && (
            <span className="brand-pill text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--text-secondary)]">
              Archived
            </span>
          )}
          {showMemberBadge && (
            <span className="brand-pill text-sm text-[var(--foreground)]">
              <UserRound className="h-3.5 w-3.5 text-[var(--text-muted)]" />
              <span>{memberCount}</span>
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[color-mix(in_srgb,var(--surface-strong)_72%,transparent)]">
        {channelName ? (
          <ChannelMessages channel={channelName} onOpenThread={onOpenThread} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />
        ) : dmId ? (
          <DmMessages conversationId={dmId} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />
        ) : (
          <EmptyState label="Select a channel to view messages" />
        )}
      </div>
    </section>
  );
}

function ChannelMessages({ channel, onOpenThread, mentionNames, onOpenAgent }: { channel: string; onOpenThread?: (messageId: string) => void; mentionNames?: string[]; onOpenAgent?: (agentName: string | null) => void; }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { messages, loading } = useMessages(channel);
  const sorted = sortMessagesChronologically(messages);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sorted.length]);

  if (loading && sorted.length === 0) return <LoadingState label="Loading messages…" />;
  if (sorted.length === 0) return <EmptyState label="No messages yet" />;

  return (
    <div className="py-3">
      {sorted.map((msg, i) => {
        const prev = i > 0 ? sorted[i - 1] : null;
        const compact = prev !== null && prev.agentName === msg.agentName && new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 300000;
        return <MessageCard key={msg.id} message={msg} compact={compact} onOpenThread={onOpenThread} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />;
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function DmMessages({ conversationId, mentionNames, onOpenAgent }: { conversationId: string; mentionNames?: string[]; onOpenAgent?: (agentName: string | null) => void; }) {
  const relay = useRelay();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [messages, setMessages] = useState<MessageWithMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    relay.dmMessages(conversationId, { limit: 50 })
      .then((dms) => {
        setMessages(dms.map((m) => ({
          id: m.id,
          channelId: '',
          agentName: m.agentName,
          agentId: m.agentId,
          text: m.text,
          blocks: null,
          metadata: {},
          hasAttachments: (m.attachments?.length ?? 0) > 0,
          threadId: null,
          attachments: m.attachments ?? [],
          createdAt: m.createdAt,
          replyCount: 0,
          reactions: [],
          readByCount: 0,
        })));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [conversationId, relay]);

  const sorted = sortMessagesChronologically(messages);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sorted.length]);

  if (loading && sorted.length === 0) return <LoadingState label="Loading messages…" />;
  if (sorted.length === 0) return <EmptyState label="No messages in this conversation" />;

  return (
    <div className="py-3">
      {sorted.map((msg, i) => {
        const prev = i > 0 ? sorted[i - 1] : null;
        const compact = prev !== null && prev.agentName === msg.agentName && new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 300000;
        return <MessageCard key={msg.id} message={msg} compact={compact} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />;
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-[var(--text-faint)]">
      <div className="mb-3 h-7 w-7 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
      <p className="text-sm">{label}</p>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center text-[var(--text-faint)]">
      <MessageSquare className="mb-3 h-8 w-8 opacity-50" />
      <p className="text-sm">{label}</p>
    </div>
  );
}
