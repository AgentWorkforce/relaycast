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

function ThreadMessageRow({ msg, mentionNames, onOpenAgent }: { msg: MessageWithMeta; mentionNames?: string[]; onOpenAgent?: (agentName: string | null) => void; }) {
  return (
    <div className="flex gap-3 px-4 py-3">
      <AgentAvatar name={msg.agentName} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="text-sm font-semibold text-[var(--foreground)]">{msg.agentName}</span>
          <span className="text-xs text-[var(--text-faint)]">{relativeTime(msg.createdAt)}</span>
        </div>
        <MessageMarkdown
          text={msg.text}
          className="text-sm leading-6 text-[var(--text-secondary)] break-words"
          showCodeCopyButton
          mentionNames={mentionNames}
          onMentionClick={onOpenAgent}
          mentionClassName="font-semibold text-[var(--brand-primary-strong)] hover:underline cursor-pointer"
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

export function ThreadPanel({ messageId, onClose, mentionNames, onOpenAgent, className }: ThreadPanelProps) {
  const { parent, replies, loading } = useThread(messageId);

  return (
    <aside className={cn('brand-card flex w-[380px] shrink-0 flex-col overflow-hidden', className)}>
      <div className="flex items-center justify-between border-b border-[var(--border-default)] px-5 py-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-[var(--brand-primary)]" />
          <h2 className="brand-title text-base font-semibold text-[var(--foreground)]">Thread</h2>
          {parent && <span className="text-xs text-[var(--text-faint)]">{parent.replyCount} {parent.replyCount === 1 ? 'reply' : 'replies'}</span>}
        </div>
        <button onClick={onClose} className="rounded-xl p-2 text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-soft)] hover:text-[var(--foreground)]">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto bg-[color-mix(in_srgb,var(--surface-strong)_72%,transparent)]">
        {loading ? (
          <div className="flex h-32 items-center justify-center text-[var(--text-faint)]">Loading thread…</div>
        ) : !parent ? (
          <div className="flex h-32 items-center justify-center text-[var(--text-faint)]">Thread not found</div>
        ) : (
          <div>
            <div className="border-b border-[var(--border-default)] pb-2">
              <ThreadMessageRow msg={parent} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />
            </div>
            {replies.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-[var(--text-faint)]">No replies yet</div>
            ) : (
              <div className="py-2">
                {replies.map((reply) => (
                  <ThreadMessageRow key={reply.id} msg={reply} mentionNames={mentionNames} onOpenAgent={onOpenAgent} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
