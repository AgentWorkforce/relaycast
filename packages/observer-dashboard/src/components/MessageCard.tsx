'use client';

import { formatReplyCountLabel, MessageMarkdown } from '@relaycast/react';
import { AgentAvatar } from './AgentAvatar';
import type { MessageWithMeta } from '@relaycast/sdk';

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

export function MessageCard({
  message,
  compact = false,
  onOpenThread,
  mentionNames,
  onOpenAgent,
}: MessageCardProps) {
  return (
    <div className="group flex gap-3 px-3 py-2 hover:bg-[var(--color-bg-hover)] sm:px-4">
      {compact ? (
        <div className="hidden w-8 shrink-0 sm:block" />
      ) : (
        <AgentAvatar name={message.agentName} className="mt-0.5" />
      )}
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {!compact && (
            <span className="font-semibold text-sm text-[var(--color-text-primary)]">
              {message.agentName}
            </span>
          )}
          <span className="text-xs text-[var(--color-text-dim)]">
            {relativeTime(message.createdAt)}
          </span>
        </div>
        <MessageMarkdown
          text={message.text}
          className="text-sm leading-6 text-[var(--color-text-secondary)] break-words"
          showCodeCopyButton
          mentionNames={mentionNames}
          onMentionClick={onOpenAgent}
          mentionClassName="font-semibold text-[var(--color-accent-cyan)] hover:underline cursor-pointer"
        />
        {((message.reactions?.length ?? 0) > 0 || message.replyCount > 0) && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {(message.reactions ?? []).map((r) => (
              <span
                key={r.emoji}
                className="inline-flex min-h-8 items-center gap-1 rounded-full border border-[var(--color-border-subtle)] bg-[var(--color-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-text-secondary)]"
              >
                {r.emoji} {r.count}
              </span>
            ))}
            {message.replyCount > 0 && (
              <button
                onClick={() => onOpenThread?.(message.id)}
                className="inline-flex min-h-9 items-center rounded-md px-2 py-1 text-xs font-medium text-[var(--color-accent-cyan)] transition-colors hover:bg-[var(--color-accent-light)] hover:no-underline"
              >
                {formatReplyCountLabel(message.replyCount)}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
