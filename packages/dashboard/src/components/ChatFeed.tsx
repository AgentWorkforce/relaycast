'use client';

import { useEffect, useRef, useState } from 'react';
import { Hash, MessageSquare } from 'lucide-react';
import { useMessages } from '@relaycast/react';
import { MessageCard } from './MessageCard';
import type { MessageWithMeta } from '@relaycast/types';

interface ChatFeedProps {
  selectedChannel: string | null;
  dmLabel?: string;
  onOpenThread?: (messageId: string) => void;
}

export function ChatFeed({ selectedChannel, dmLabel, onOpenThread }: ChatFeedProps) {
  const isDm = selectedChannel?.startsWith('dm:');
  const channelName = selectedChannel && !isDm ? selectedChannel : null;
  const dmId = isDm ? selectedChannel!.slice(3) : null;

  const title = selectedChannel
    ? isDm
      ? dmLabel || 'Direct Message'
      : `#${selectedChannel}`
    : 'Select a channel';

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border-default)] flex items-center gap-2 shrink-0">
        {selectedChannel && !isDm ? (
          <Hash className="h-4 w-4 text-[var(--color-text-muted)]" />
        ) : (
          <MessageSquare className="h-4 w-4 text-[var(--color-text-muted)]" />
        )}
        <h2 className="font-semibold text-sm text-[var(--color-text-primary)]">{title}</h2>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {channelName ? (
          <ChannelMessages channel={channelName} onOpenThread={onOpenThread} />
        ) : dmId ? (
          <DmMessages conversationId={dmId} />
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
}: {
  channel: string;
  onOpenThread?: (messageId: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { messages, loading } = useMessages(channel);

  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

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
          prev.agent_name === msg.agent_name &&
          new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < 300000;
        return (
          <MessageCard
            key={msg.id}
            message={msg}
            compact={compact}
            onOpenThread={onOpenThread}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function DmMessages({ conversationId }: { conversationId: string }) {
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
          agent_name: (m.agent_name as string) || 'unknown',
          agent_id: (m.agent_id as string) || '',
          text: (m.text as string) || '',
          blocks: null,
          attachments: [],
          created_at: (m.created_at as string) || new Date().toISOString(),
          reply_count: 0,
          reactions: [],
          read_by_count: 0,
        }));
        setMessages(msgs);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [conversationId]);

  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );

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
          prev.agent_name === msg.agent_name &&
          new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < 300000;
        return (
          <MessageCard
            key={msg.id}
            message={msg}
            compact={compact}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
