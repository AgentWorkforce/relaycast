'use client';

import { useEffect, useRef } from 'react';
import { Hash, MessageSquare } from 'lucide-react';
import { MessageCard } from './MessageCard';
import type { Message } from '../types/dashboard';

interface ChatFeedProps {
  messages: Message[];
  selectedChannel: string | null;
  selectedAgent: string | null;
  onOpenThread?: (messageId: string) => void;
}

export function ChatFeed({ messages, selectedChannel, selectedAgent, onOpenThread }: ChatFeedProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  const filtered = messages.filter((msg) => {
    if (selectedChannel) return msg.to === `#${selectedChannel}`;
    if (selectedAgent) return msg.from === selectedAgent || msg.to === selectedAgent;
    return true;
  });

  const sorted = [...filtered].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sorted.length]);

  const title = selectedChannel
    ? `#${selectedChannel}`
    : selectedAgent
      ? selectedAgent
      : 'All messages';

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border-default)] flex items-center gap-2 shrink-0">
        {selectedChannel ? (
          <Hash className="h-4 w-4 text-[var(--color-text-muted)]" />
        ) : (
          <MessageSquare className="h-4 w-4 text-[var(--color-text-muted)]" />
        )}
        <h2 className="font-semibold text-sm text-[var(--color-text-primary)]">{title}</h2>
        <span className="text-xs text-[var(--color-text-dim)] ml-2">
          {sorted.length} {sorted.length === 1 ? 'message' : 'messages'}
        </span>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[var(--color-text-dim)]">
            <MessageSquare className="h-8 w-8 mb-2 opacity-40" />
            <p className="text-sm">No messages yet</p>
          </div>
        ) : (
          <div className="py-2">
            {sorted.map((msg, i) => {
              const prev = i > 0 ? sorted[i - 1] : null;
              const compact =
                prev !== null &&
                prev.from === msg.from &&
                new Date(msg.timestamp).getTime() - new Date(prev.timestamp).getTime() < 300000;
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
        )}
      </div>
    </div>
  );
}
