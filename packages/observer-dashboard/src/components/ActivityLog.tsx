'use client';

import { Wifi } from 'lucide-react';
import { useWebSocketFeed } from '../hooks/use-websocket-feed';
import type { WebSocketFeedEvent } from '../types/dashboard';
import { cn } from '../lib/utils';

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

interface ActivityLogProps {
  className?: string;
}

export function ActivityLog({ className }: ActivityLogProps) {
  const { status, events: wsEvents, latestEventAt } = useWebSocketFeed();

  const statusClasses = {
    connected: 'bg-green-500/15 text-green-400 border-green-500/30',
    connecting: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    reconnecting: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    disconnected: 'bg-red-500/15 text-red-400 border-red-500/30',
  } as const;

  return (
    <div className={cn(
      'w-[260px] shrink-0 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-bg-primary)]',
      className,
    )}>
      <div className="px-4 py-3 border-b border-[var(--color-border-default)] shrink-0 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold text-sm text-[var(--color-text-primary)]">Activity</h2>
          <span
            className={cn(
              'inline-flex items-center rounded border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
              statusClasses[status]
            )}
            title="Current WebSocket connection status"
          >
            WS {status}
          </span>
        </div>
        <div className="text-[10px] text-[var(--color-text-dim)]">
          {latestEventAt ? `Last WS event ${relativeTime(latestEventAt)}` : 'No WS events yet'}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        <WebSocketFeed events={wsEvents} />
      </div>
    </div>
  );
}

function WebSocketFeed({ events }: { events: WebSocketFeedEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-dim)]">
        <p className="text-sm">No websocket events yet</p>
      </div>
    );
  }

  return (
    <div className="py-1">
      {events.map((event: WebSocketFeedEvent) => (
        <div
          key={event.id}
          className="flex items-start gap-2.5 px-4 py-2 text-sm"
        >
          <Wifi className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[var(--color-text-muted)]" />
          <div className="flex-1 min-w-0">
            <div className="font-mono text-[10px] text-[var(--color-text-muted)] break-all">
              {event.eventType}
            </div>
            <div className="text-xs leading-relaxed text-[var(--color-text-secondary)]">
              {event.summary}
            </div>
          </div>
          <span className="text-[10px] text-[var(--color-text-dim)] shrink-0 mt-0.5">
            {relativeTime(event.timestamp)}
          </span>
        </div>
      ))}
    </div>
  );
}
