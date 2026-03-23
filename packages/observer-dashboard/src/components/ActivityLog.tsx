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

export function ActivityLog({ className }: { className?: string }) {
  const { status, events: wsEvents, latestEventAt } = useWebSocketFeed();

  const statusClasses = {
    connected: 'bg-green-500/15 text-green-400 border-green-500/30',
    connecting: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    reconnecting: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    disconnected: 'bg-red-500/15 text-red-400 border-red-500/30',
  } as const;

  return (
    <div className={cn('flex h-full w-full min-w-0 flex-col bg-[var(--color-bg-primary)] lg:w-[260px] lg:shrink-0 lg:border-l lg:border-[var(--color-border-default)]', className)}>
      <div className="space-y-2 border-b border-[var(--color-border-default)] px-4 py-3 shrink-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--color-text-primary)]">Activity</h2>
          <span
            className={cn(
              'inline-flex items-center rounded border px-2 py-1 text-[10px] font-medium uppercase tracking-wide',
              statusClasses[status]
            )}
            title="Current WebSocket connection status"
          >
            WS {status}
          </span>
        </div>
        <div className="text-xs text-[var(--color-text-dim)]">
          {latestEventAt ? `Last WS event ${relativeTime(latestEventAt)}` : 'No WS events yet'}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto overscroll-contain">
        <WebSocketFeed events={wsEvents} />
      </div>
    </div>
  );
}

function WebSocketFeed({ events }: { events: WebSocketFeedEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[var(--color-text-dim)]">
        <p className="text-sm">No websocket events yet</p>
      </div>
    );
  }

  return (
    <div className="py-1">
      {events.map((event: WebSocketFeedEvent) => (
        <div
          key={event.id}
          className="flex items-start gap-3 px-4 py-3 text-sm"
        >
          <Wifi className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
          <div className="min-w-0 flex-1">
            <div className="break-all font-mono text-[10px] text-[var(--color-text-muted)]">
              {event.eventType}
            </div>
            <div className="text-xs leading-5 text-[var(--color-text-secondary)]">
              {event.summary}
            </div>
          </div>
          <span className="mt-0.5 shrink-0 text-[10px] text-[var(--color-text-dim)]">
            {relativeTime(event.timestamp)}
          </span>
        </div>
      ))}
    </div>
  );
}
