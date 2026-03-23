'use client';

import { useEffect, useRef, useState } from 'react';
import { Hash, MessageSquare, UserRound, PanelLeft, PanelRight } from 'lucide-react';
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
  isMobile?: boolean;
  onToggleSidebar?: () => void;
  onToggleInspector?: () => void;
  inspectorTitle?: string;
}

export function ChatFeed({
  selectedChannel,
  selectedChannelMemberCount,
  selectedChannelArchived = false,
  dmLabel,
  onOpenThread,
  mentionNames,
  onOpenAgent,
  isMobile = false,
  onToggleSidebar,
  onToggleInspector,
  inspectorTitle = 'Activity',
}: ChatFeedProps) {
  const isDm = selectedChannel?.startsWith('dm:');
  const channelName = selectedChannel && !isDm ? selectedChannel : null;
  const dmId = isDm ? selectedChannel!.slice(3) : null;

  const title = selectedChannel
    ? isDm
      ? dmLabel || 'Direct Message'
      : `#${selectedChannel}`
    : 'Select a conversation';
  const memberCount = selectedChannelMemberCount ?? 0;
  const showMemberBadge = !!channelName;

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex min-h-14 items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-3 sm:px-4">
        {isMobile && (
          <button
            type="button"
            onClick={onToggleSidebar}
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)]"
            aria-label="Open channels and agents"
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        )}

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {selectedChannel && !isDm ? (
              <Hash className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
            ) : (
              <MessageSquare className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
            )}
            <h2 className="truncate text-sm font-semibold text-[var(--color-text-primary)] sm:text-base">{title}</h2>
          </div>
          {isMobile && (
            <div className="mt-0.5 text-xs text-[var(--color-text-muted)]">
              {showMemberBadge
                ? `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`
                : selectedChannel
                  ? 'Direct message conversation'
                  : 'Pick a channel, DM, or agent from the menu'}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {showMemberBadge && selectedChannelArchived && (
            <span className="hidden rounded-md border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-text-muted)] sm:inline-flex">
              Archived
            </span>
          )}
          {showMemberBadge && (
            <span className="hidden items-center gap-1.5 rounded-2xl border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-2.5 py-1 text-sm text-[var(--color-text-primary)] sm:inline-flex">
              <UserRound className="h-3.5 w-3.5 text-[var(--color-text-muted)]" />
              <span>{memberCount}</span>
            </span>
          )}
          {isMobile && (
            <button
              type="button"
              onClick={onToggleInspector}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] px-3 text-sm text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)]"
              aria-label={`Open ${inspectorTitle}`}
            >
              <PanelRight className="h-4 w-4" />
              <span className="hidden sm:inline">{inspectorTitle}</span>
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
          <div className="flex h-full flex-col items-center justify-center px-6 text-center text-[var(--color-text-dim)]">
            <MessageSquare className="mb-3 h-10 w-10 opacity-40" />
            <p className="text-sm font-medium text-[var(--color-text-secondary)]">Nothing selected yet</p>
            <p className="mt-1 max-w-sm text-sm text-[var(--color-text-dim)]">
              Open the menu to jump into a channel, direct message, or agent profile.
            </p>
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
    return <FeedState loading label="Loading messages..." />;
  }

  if (sorted.length === 0) {
    return <FeedState label="No messages yet" />;
  }

  return (
    <div className="py-2 sm:py-3">
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

  if (loading && sorted.length === 0) {
    return <FeedState loading label="Loading messages..." />;
  }

  if (sorted.length === 0) {
    return <FeedState label="No messages in this conversation" />;
  }

  return (
    <div className="py-2 sm:py-3">
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

function FeedState({ loading = false, label }: { loading?: boolean; label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center text-[var(--color-text-dim)]">
      {loading ? (
        <div className="mb-3 h-7 w-7 animate-spin rounded-full border-2 border-[var(--color-success)] border-t-transparent" />
      ) : (
        <MessageSquare className="mb-3 h-10 w-10 opacity-40" />
      )}
      <p className={cn('text-sm', loading ? 'text-[var(--color-text-secondary)]' : '')}>{label}</p>
    </div>
  );
}
