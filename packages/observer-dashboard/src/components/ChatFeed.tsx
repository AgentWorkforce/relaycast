'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Hash, MessageSquare, UserRound } from 'lucide-react';
import { useMessages, useRelay, sortMessagesChronologically } from '@relaycast/react';
import { MessageCard } from './MessageCard';
import { cn } from '../lib/utils';
import type { DmMessage, MessageWithMeta } from '@relaycast/sdk';

const PAGE_SIZE = 50;

// Avoid the React SSR warning for useLayoutEffect in Next.js client components.
const useIsomorphicLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

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
  const scrollRef = useRef<HTMLDivElement>(null);

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

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto bg-[color-mix(in_srgb,var(--surface-strong)_72%,transparent)]">
        {channelName ? (
          <ChannelMessages key={channelName} channel={channelName} scrollRef={scrollRef} onOpenThread={onOpenThread} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />
        ) : dmId ? (
          <DmMessages key={dmId} conversationId={dmId} scrollRef={scrollRef} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />
        ) : (
          <EmptyState label="Select a channel to view messages" />
        )}
      </div>
    </section>
  );
}

/**
 * Pagination scaffolding shared by the channel and DM feeds: keeps the viewport
 * anchored while older messages are prepended, scrolls to the bottom only when
 * a new latest message arrives, and loads older pages when the top sentinel
 * becomes visible.
 */
function usePaginatedFeed(
  scrollRef: RefObject<HTMLDivElement>,
  sorted: MessageWithMeta[],
  loadOlderPage: () => Promise<number>,
) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const prependHeightRef = useRef<number | null>(null);
  const didInitialScrollRef = useRef(false);

  const newestId = sorted[sorted.length - 1]?.id;
  const oldestId = sorted[0]?.id;

  // Restore the scroll position after older messages are prepended.
  useIsomorphicLayoutEffect(() => {
    if (prependHeightRef.current === null) return;
    const container = scrollRef.current;
    if (container) container.scrollTop += container.scrollHeight - prependHeightRef.current;
    prependHeightRef.current = null;
  }, [oldestId, scrollRef]);

  useEffect(() => {
    if (!newestId) return;
    bottomRef.current?.scrollIntoView({ behavior: didInitialScrollRef.current ? 'smooth' : 'auto' });
    didInitialScrollRef.current = true;
  }, [newestId]);

  const loadOlder = useCallback(async () => {
    if (loadingMoreRef.current) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    prependHeightRef.current = scrollRef.current?.scrollHeight ?? 0;
    try {
      const added = await loadOlderPage();
      if (added < PAGE_SIZE) setHasMore(false);
      if (added === 0) prependHeightRef.current = null;
    } catch {
      prependHeightRef.current = null;
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [loadOlderPage, scrollRef]);

  // The first page may be the whole history; only probe for more once it is full.
  const showSentinel = hasMore && sorted.length >= PAGE_SIZE;

  useEffect(() => {
    const el = topRef.current;
    if (!el || !showSentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadOlder();
      },
      { root: scrollRef.current, rootMargin: '200px 0px 0px 0px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [showSentinel, loadOlder, scrollRef]);

  return { bottomRef, topRef, showSentinel, loadingMore };
}

function FeedList({
  sorted,
  feed,
  onOpenThread,
  mentionNames,
  onOpenAgent,
}: {
  sorted: MessageWithMeta[];
  feed: ReturnType<typeof usePaginatedFeed>;
  onOpenThread?: (messageId: string) => void;
  mentionNames?: string[];
  onOpenAgent?: (agentName: string | null) => void;
}) {
  return (
    <div className="py-3">
      {feed.showSentinel && <div ref={feed.topRef} />}
      {feed.loadingMore && (
        <div className="flex justify-center py-2">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--brand-primary)] border-t-transparent" />
        </div>
      )}
      {sorted.map((msg, i) => {
        const prev = i > 0 ? sorted[i - 1] : null;
        const compact = prev !== null && prev.agentName === msg.agentName && new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() < 300000;
        return <MessageCard key={msg.id} message={msg} compact={compact} onOpenThread={onOpenThread} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />;
      })}
      <div ref={feed.bottomRef} />
    </div>
  );
}

function ChannelMessages({ channel, scrollRef, onOpenThread, mentionNames, onOpenAgent }: { channel: string; scrollRef: RefObject<HTMLDivElement>; onOpenThread?: (messageId: string) => void; mentionNames?: string[]; onOpenAgent?: (agentName: string | null) => void; }) {
  const { messages, loading, fetchMore } = useMessages(channel);
  const sorted = sortMessagesChronologically(messages);
  const feed = usePaginatedFeed(scrollRef, sorted, fetchMore);

  if (loading && sorted.length === 0) return <LoadingState label="Loading messages…" />;
  if (sorted.length === 0) return <EmptyState label="No messages yet" />;

  return <FeedList sorted={sorted} feed={feed} onOpenThread={onOpenThread} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />;
}

function toMessageWithMeta(m: DmMessage): MessageWithMeta {
  return {
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
  };
}

function DmMessages({ conversationId, scrollRef, mentionNames, onOpenAgent }: { conversationId: string; scrollRef: RefObject<HTMLDivElement>; mentionNames?: string[]; onOpenAgent?: (agentName: string | null) => void; }) {
  const relay = useRelay();
  const [messages, setMessages] = useState<MessageWithMeta[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    relay.dmMessages(conversationId, { limit: PAGE_SIZE })
      .then((dms) => setMessages(dms.map(toMessageWithMeta)))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [conversationId, relay]);

  const sorted = sortMessagesChronologically(messages);
  const oldestId = sorted[0]?.id;

  const loadOlderPage = useCallback(async () => {
    if (!oldestId) return 0;
    const older = await relay.dmMessages(conversationId, { before: oldestId, limit: PAGE_SIZE });
    if (older.length > 0) {
      setMessages((prev) => [...older.map(toMessageWithMeta), ...prev]);
    }
    return older.length;
  }, [conversationId, oldestId, relay]);

  const feed = usePaginatedFeed(scrollRef, sorted, loadOlderPage);

  if (loading && sorted.length === 0) return <LoadingState label="Loading messages…" />;
  if (sorted.length === 0) return <EmptyState label="No messages in this conversation" />;

  return <FeedList sorted={sorted} feed={feed} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />;
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
