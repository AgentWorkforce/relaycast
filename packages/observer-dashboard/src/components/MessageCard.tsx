'use client';

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
}

export function MessageCard({ message, compact = false, onOpenThread }: MessageCardProps) {
  return (
    <div className="flex gap-3 px-4 py-2 hover:bg-[var(--color-bg-hover)] group">
      {compact ? (
        <div className="w-8 shrink-0" />
      ) : (
        <AgentAvatar name={message.agentName} />
      )}
      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="font-semibold text-sm text-[var(--color-text-primary)]">
              {message.agentName}
            </span>
            <span className="text-xs text-[var(--color-text-dim)] ml-auto shrink-0">
              {relativeTime(message.createdAt)}
            </span>
          </div>
        )}
        <p className="text-sm text-[var(--color-text-secondary)] break-words whitespace-pre-wrap">
          {message.text}
        </p>
        {((message.reactions?.length ?? 0) > 0 || message.replyCount > 0) && (
          <div className="flex items-center gap-2 mt-1">
            {(message.reactions ?? []).map((r) => (
              <span
                key={r.emoji}
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs bg-[var(--color-bg-tertiary)] border border-[var(--color-border-subtle)] text-[var(--color-text-secondary)]"
              >
                {r.emoji} {r.count}
              </span>
            ))}
            {message.replyCount > 0 && (
              <button
                onClick={() => onOpenThread?.(message.id)}
                className="text-xs text-[var(--color-accent-cyan)] cursor-pointer hover:underline"
              >
                {message.replyCount} {message.replyCount === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
