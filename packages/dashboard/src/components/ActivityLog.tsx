'use client';

import { useState } from 'react';
import { Send, Wifi, Clock, SmilePlus, Reply } from 'lucide-react';
import { useActivityFeed } from '../hooks/use-activity-feed';
import { useWebSocketFeed } from '../hooks/use-websocket-feed';
import type { ActivityEvent, WebSocketFeedEvent } from '../types/dashboard';
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

const EVENT_ICONS: Record<string, typeof Send> = {
  message_sent: Send,
  connection: Wifi,
  agent_idle: Clock,
  reaction: SmilePlus,
  thread_reply: Reply,
};

export function ActivityLog() {
  const [tab, setTab] = useState<'activity' | 'websocket'>('activity');
  const events = useActivityFeed();
  const { status, events: wsEvents, latestEventAt } = useWebSocketFeed();

  const statusClasses = {
    connected: 'bg-green-500/15 text-green-400 border-green-500/30',
    connecting: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    reconnecting: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    disconnected: 'bg-red-500/15 text-red-400 border-red-500/30',
  } as const;

  return (
    <div className="w-[320px] shrink-0 flex flex-col border-l border-[var(--color-border-default)] bg-[var(--color-bg-primary)]">
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
        <div className="inline-flex rounded-md border border-[var(--color-border-default)] p-0.5">
          <button
            onClick={() => setTab('activity')}
            className={cn(
              'px-2 py-1 text-[11px] rounded cursor-pointer transition-colors',
              tab === 'activity'
                ? 'bg-[var(--color-bg-active)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
            )}
          >
            App
          </button>
          <button
            onClick={() => setTab('websocket')}
            className={cn(
              'px-2 py-1 text-[11px] rounded cursor-pointer transition-colors',
              tab === 'websocket'
                ? 'bg-[var(--color-bg-active)] text-[var(--color-text-primary)]'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]'
            )}
          >
            WebSocket
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === 'activity' ? (
          <ActivityFeed events={events} />
        ) : (
          <WebSocketFeed events={wsEvents} />
        )}
      </div>
    </div>
  );
}

function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-[var(--color-text-dim)]">
        <p className="text-sm">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="py-1">
      {events.map((event: ActivityEvent) => {
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
