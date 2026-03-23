'use client';

import { X, MessageSquare } from 'lucide-react';
import { MessageMarkdown, useThread } from '@relaycast/react';
import { AgentAvatar } from './AgentAvatar';
import { cn } from '../lib/utils';
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

function ThreadMessageRow({
  msg,
  mentionNames,
  onOpenAgent,
}: {
  msg: MessageWithMeta;
  mentionNames?: string[];
  onOpenAgent?: (agentName: string | null) => void;
}) {
  return (
    <div className="flex gap-3 px-3 py-3 sm:px-4">
      <AgentAvatar name={msg.agentName} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-semibold text-sm text-[var(--color-text-primary)]">
            {msg.agentName}
          </span>
          <span className="text-xs text-[var(--color-text-dim)]">
            {relativeTime(msg.createdAt)}
          </span>
        </div>
        <MessageMarkdown
          text={msg.text}
          className="text-sm leading-6 text-[var(--color-text-secondary)] break-words"
          showCodeCopyButton
          mentionNames={mentionNames}
          onMentionClick={onOpenAgent}
          mentionClassName="font-semibold text-[var(--color-accent-cyan)] hover:underline cursor-pointer"
        />
      </div>
    </div>
  );
}

interface ThreadPanelProps {
  messageId: string;
  onClose: () => void;
  mentionNames?: string[];
  onOpenAgent?: (agentName: string | null) => void;
  className?: string;
}

export function ThreadPanel({
  messageId,
  onClose,
  mentionNames,
  onOpenAgent,
  className,
}: ThreadPanelProps) {
  const { parent, replies, loading } = useThread(messageId);

  return (
    <div className={cn('flex h-full w-full min-w-0 flex-col bg-[var(--color-bg-primary)] lg:w-[360px] lg:shrink-0 lg:border-l lg:border-[var(--color-border-default)]', className)}>
      <div className="flex min-h-14 items-center justify-between gap-3 border-b border-[var(--color-border-default)] px-4 py-3 shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
            <h2 className="truncate text-sm font-semibold text-[var(--color-text-primary)]">Thread</h2>
          </div>
          {parent && (
            <div className="mt-0.5 text-xs text-[var(--color-text-dim)]">
              {parent.replyCount} {parent.replyCount === 1 ? 'reply' : 'replies'}
            </div>
          )}
        </div>
        <button
          onClick={onClose}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {loading ? (
          <PanelState label="Loading thread..." loading />
        ) : !parent ? (
          <PanelState label="Thread not found" />
        ) : (
          <div>
            <div className="mb-1 border-b border-[var(--color-border-subtle)] pb-2">
              <ThreadMessageRow
                msg={parent}
                mentionNames={mentionNames}
                onOpenAgent={onOpenAgent}
              />
            </div>

            {replies.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-[var(--color-text-dim)]">
                No replies yet
              </div>
            ) : (
              <div className="py-1">
                {replies.map((reply) => (
                  <ThreadMessageRow
                    key={reply.id}
                    msg={reply}
                    mentionNames={mentionNames}
                    onOpenAgent={onOpenAgent}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PanelState({ loading = false, label }: { loading?: boolean; label: string }) {
  return (
    <div className="flex h-32 items-center justify-center px-6 text-center text-[var(--color-text-dim)]">
      <p className={cn('text-sm', loading ? 'text-[var(--color-text-secondary)]' : '')}>{label}</p>
    </div>
  );
}
