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
    connected: 'bg-emerald-500/12 text-emerald-300 border-emerald-500/25',
    connecting: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
    reconnecting: 'bg-amber-500/12 text-amber-300 border-amber-500/25',
    disconnected: 'bg-rose-500/12 text-rose-300 border-rose-500/25',
  } as const;

  return (
    <div className={cn('console-subtle flex h-full min-h-[420px] flex-col overflow-hidden', className)}>
      <div className="space-y-2 border-b border-[color-mix(in_srgb,var(--console-accent)_14%,transparent)] px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-[var(--console-fg)]">Activity</h2>
          <span className={cn('inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide', statusClasses[status])}>
            WS {status}
          </span>
        </div>
        <div className="text-[10px] text-[var(--console-muted)]">
          {latestEventAt ? `Last WS event ${relativeTime(latestEventAt)}` : 'No WS events yet'}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">{wsEvents.length === 0 ? <Empty /> : <WebSocketFeed events={wsEvents} />}</div>
    </div>
  );
}

function Empty() {
  return <div className="flex h-full items-center justify-center text-sm text-[var(--console-muted)]">No websocket events yet</div>;
}

function WebSocketFeed({ events }: { events: WebSocketFeedEvent[] }) {
  return (
    <div className="py-2">
      {events.map((event) => (
        <div key={event.id} className="flex items-start gap-2.5 px-4 py-3 text-sm hover:bg-white/2">
          <Wifi className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--console-accent)]" />
          <div className="min-w-0 flex-1">
            <div className="break-all font-mono text-[10px] text-[var(--console-muted)]">{event.eventType}</div>
            <div className="text-xs leading-relaxed text-[var(--console-fg)]/82">{event.summary}</div>
          </div>
          <span className="mt-0.5 shrink-0 text-[10px] text-[var(--console-muted)]">{relativeTime(event.timestamp)}</span>
        </div>
      ))}
    </div>
  );
}
