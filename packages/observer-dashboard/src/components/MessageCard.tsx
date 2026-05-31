'use client';

import { formatReplyCountLabel, MessageMarkdown } from '@relaycast/react';
import { AgentAvatar } from './AgentAvatar';
import type { MessageWithMeta } from '@relaycast/sdk';

type MessageReaction = {
  emoji: string;
  count: number;
};

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

interface MessageCardProps {
  message: MessageWithMeta;
  compact?: boolean;
  onOpenThread?: (messageId: string) => void;
  mentionNames?: string[];
  onOpenAgent?: (agentName: string | null) => void;
}

export function MessageCard({ message, compact = false, onOpenThread, mentionNames, onOpenAgent }: MessageCardProps) {
  const reactions = (message.reactions ?? []) as MessageReaction[];
  return (
    <div className="group mx-3 rounded-2xl px-4 py-3 transition-colors hover:bg-[var(--brand-primary-faint)]">
      <div className="flex gap-3">
        {compact ? <div className="w-8 shrink-0" /> : <AgentAvatar name={message.agentName} />}
        <div className="min-w-0 flex-1">
          {!compact && (
            <div className="mb-1 flex items-baseline gap-2">
              <span className="text-sm font-semibold text-[var(--foreground)]">{message.agentName}</span>
              <span className="ml-auto shrink-0 text-xs text-[var(--text-faint)]">{relativeTime(message.createdAt)}</span>
            </div>
          )}
          <MessageMarkdown
            text={message.text}
            className="text-sm leading-6 text-[var(--text-secondary)] break-words"
            showCodeCopyButton
            mentionNames={mentionNames}
            onMentionClick={onOpenAgent}
            mentionClassName="font-semibold text-[var(--brand-primary-strong)] hover:underline cursor-pointer"
          />
          {(reactions.length > 0 || message.replyCount > 0) && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {reactions.map((r) => (
                <span key={r.emoji} className="rounded-full border border-[var(--border-default)] bg-[var(--surface-soft)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                  {r.emoji} {r.count}
                </span>
              ))}
              {message.replyCount > 0 && (
                <button onClick={() => onOpenThread?.(message.id)} className="text-xs font-medium text-[var(--brand-primary-strong)] hover:underline">
                  {formatReplyCountLabel(message.replyCount)}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
