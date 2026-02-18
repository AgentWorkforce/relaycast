'use client';

import { X, MessageSquare } from 'lucide-react';
import { useThread } from '@relaycast/react';
import { AgentAvatar } from './AgentAvatar';
import type { MessageWithMeta } from '@relaycast/types';

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

function ThreadMessageRow({ msg }: { msg: MessageWithMeta }) {
  return (
    <div className="flex gap-3 px-4 py-2">
      <AgentAvatar name={msg.agent_name} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="font-semibold text-sm text-[var(--color-text-primary)]">
            {msg.agent_name}
          </span>
          <span className="text-xs text-[var(--color-text-dim)]">
            {relativeTime(msg.created_at)}
          </span>
        </div>
        <p className="text-sm text-[var(--color-text-secondary)] break-words whitespace-pre-wrap">
          {msg.text}
        </p>
      </div>
    </div>
  );
}

interface ThreadPanelProps {
  messageId: string;
  onClose: () => void;
}

export function ThreadPanel({ messageId, onClose }: ThreadPanelProps) {
  const { parent, replies, loading } = useThread(messageId);

  return (
    <div className="w-[360px] shrink-0 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--color-border-default)] flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-4 w-4 text-[var(--color-text-muted)]" />
          <h2 className="font-semibold text-sm text-[var(--color-text-primary)]">Thread</h2>
          {parent && (
            <span className="text-xs text-[var(--color-text-dim)]">
              {parent.reply_count} {parent.reply_count === 1 ? 'reply' : 'replies'}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md cursor-pointer text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-[var(--color-text-dim)]">
            <p className="text-sm">Loading thread...</p>
          </div>
        ) : !parent ? (
          <div className="flex items-center justify-center h-32 text-[var(--color-text-dim)]">
            <p className="text-sm">Thread not found</p>
          </div>
        ) : (
          <div>
            {/* Parent message */}
            <div className="border-b border-[var(--color-border-subtle)] pb-2 mb-1">
              <ThreadMessageRow msg={parent} />
            </div>

            {/* Replies */}
            {replies.length === 0 ? (
              <div className="px-4 py-6 text-center text-xs text-[var(--color-text-dim)]">
                No replies yet
              </div>
            ) : (
              <div className="py-1">
                {replies.map((reply) => (
                  <ThreadMessageRow key={reply.id} msg={reply} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
