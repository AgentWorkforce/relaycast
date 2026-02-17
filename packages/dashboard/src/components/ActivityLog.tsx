'use client';

import { Send, Wifi, Clock, SmilePlus, Reply } from 'lucide-react';
import type { ActivityEvent } from '../types/dashboard';

function relativeTime(timestamp: string): string {
  const diff = Date.now() - new Date(timestamp).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

const EVENT_ICONS: Record<string, typeof Send> = {
  message_sent: Send,
  connection: Wifi,
  agent_idle: Clock,
  reaction: SmilePlus,
  thread_reply: Reply,
};

interface ActivityLogProps {
  events: ActivityEvent[];
}

export function ActivityLog({ events }: ActivityLogProps) {
  return (
    <div className="w-[320px] shrink-0 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
      <div className="px-4 py-3 border-b border-[var(--color-border-default)] shrink-0">
        <h2 className="font-semibold text-sm text-[var(--color-text-primary)]">Activity</h2>
      </div>
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[var(--color-text-dim)]">
            <p className="text-sm">No activity yet</p>
          </div>
        ) : (
          <div className="py-1">
            {events.map((event) => {
              const Icon = EVENT_ICONS[event.type] || Send;
              return (
                <div
                  key={event.id}
                  className="flex items-start gap-2.5 px-4 py-2 text-sm"
                >
                  <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
                  <span className="flex-1 text-[var(--color-text-secondary)] text-xs leading-relaxed">
                    {event.summary}
                  </span>
                  <span className="text-[10px] text-[var(--color-text-dim)] shrink-0 mt-0.5">
                    {relativeTime(event.timestamp)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
