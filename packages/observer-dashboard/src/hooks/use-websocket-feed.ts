'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEvent, useWebSocket } from '@relaycast/react';
import type { WsClientEvent } from '@relaycast/sdk';
import type { WebSocketFeedCategory, WebSocketFeedEvent } from '../types/dashboard';
import { WS_EVENTS_STORAGE_KEY } from '../lib/activity-store';

const MAX_WS_EVENTS = 300;

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function categorizeEvent(type: string): WebSocketFeedCategory {
  if (type.startsWith('action.')) return 'action';
  if (type.startsWith('agent.status.')) return 'presence';
  if (type === 'message.reacted') return 'reaction';
  if (type.startsWith('channel.') || type.startsWith('member.')) return 'channel';
  if (type.startsWith('delivery.')) return 'delivery';
  if (
    type === 'message.created' ||
    type === 'message.updated' ||
    type === 'thread.reply' ||
    type === 'dm.received' ||
    type === 'group_dm.received'
  ) {
    return 'message';
  }
  return 'system';
}

function loadStoredEvents(): WebSocketFeedEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(WS_EVENTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is WebSocketFeedEvent =>
          !!item &&
          typeof item === 'object' &&
          typeof (item as WebSocketFeedEvent).id === 'string' &&
          typeof (item as WebSocketFeedEvent).eventType === 'string' &&
          typeof (item as WebSocketFeedEvent).summary === 'string' &&
          typeof (item as WebSocketFeedEvent).timestamp === 'string',
      )
      .map((item) => ({ ...item, category: item.category ?? categorizeEvent(item.eventType) }))
      .slice(-MAX_WS_EVENTS);
  } catch {
    return [];
  }
}

function summarizeEvent(event: WsClientEvent): string {
  const record = event as unknown as Record<string, unknown>;
  const type = String(record.type ?? 'unknown');

  switch (type) {
    case 'open':
      return 'WebSocket connected';
    case 'close':
      return 'WebSocket disconnected';
    case 'error':
      return 'WebSocket error';
    case 'pong':
      return 'Keepalive pong from server';
    case 'reconnecting': {
      const attempt = getNumber(record.attempt);
      return attempt ? `Reconnecting (attempt ${attempt})` : 'Reconnecting';
    }
    case 'message.created': {
      const message = (record.message as Record<string, unknown> | undefined) ?? {};
      const agent = getString(message.agentName) ?? 'unknown';
      const channel = getString(record.channel) ?? '?';
      return `${agent} -> #${channel}`;
    }
    case 'thread.reply': {
      const message = (record.message as Record<string, unknown> | undefined) ?? {};
      const agent = getString(message.agentName) ?? 'unknown';
      return `${agent} replied in thread`;
    }
    case 'message.reacted': {
      const agent = getString(record.agentName) ?? 'unknown';
      const emoji = getString(record.emoji) ?? '?';
      const action = getString(record.action) === 'removed' ? 'removed' : 'reacted';
      return `${agent} ${action} ${emoji}`;
    }
    case 'agent.status.active':
    case 'agent.status.idle':
    case 'agent.status.blocked':
    case 'agent.status.waiting':
    case 'agent.status.offline':
    case 'agent.status.changed': {
      const agentObj = (record.agent as Record<string, unknown> | undefined) ?? {};
      const name = getString(agentObj.name) ?? 'unknown';
      const status = getString(record.status) ?? type.replace('agent.status.', '');
      return `${name} ${status}`;
    }
    case 'action.invoked': {
      const action = getString(record.actionName) ?? '?';
      const caller = getString(record.callerName) ?? 'unknown';
      if (action === 'spawn' || action.startsWith('spawn:')) {
        const kind = action.includes(':') ? action.slice(action.indexOf(':') + 1) : null;
        return kind ? `${caller} spawned ${kind}` : `${caller} requested a spawn`;
      }
      if (action === 'release' || action.startsWith('release:')) {
        const kind = action.includes(':') ? action.slice(action.indexOf(':') + 1) : null;
        return kind ? `${caller} released ${kind}` : `${caller} requested a release`;
      }
      return `${caller} called ${action}`;
    }
    case 'action.completed': {
      const action = getString(record.actionName) ?? '?';
      return `${action} completed`;
    }
    case 'action.failed': {
      const action = getString(record.actionName) ?? '?';
      const error = getString(record.error);
      return error ? `${action} failed: ${error}` : `${action} failed`;
    }
    case 'action.denied': {
      const action = getString(record.actionName) ?? '?';
      const caller = getString(record.callerName) ?? 'unknown';
      return `${caller} denied calling ${action}`;
    }
    case 'action.registered': {
      const action = getString(record.actionName) ?? '?';
      return `Action ${action} registered`;
    }
    case 'dm.received': {
      const message = (record.message as Record<string, unknown> | undefined) ?? {};
      const agent = getString(message.agentName) ?? 'unknown';
      return `DM from ${agent}`;
    }
    case 'group_dm.received': {
      const message = (record.message as Record<string, unknown> | undefined) ?? {};
      const agent = getString(message.agentName) ?? 'unknown';
      return `Group DM from ${agent}`;
    }
    case 'channel.created':
    case 'channel.updated':
    case 'channel.archived': {
      const channelObj = (record.channel as Record<string, unknown> | undefined) ?? {};
      const channelName = getString(channelObj.name) ?? getString(record.channelName) ?? '?';
      return `#${channelName}`;
    }
    case 'member.joined':
    case 'member.left': {
      const agent = getString(record.agentName) ?? 'unknown';
      const channel = getString(record.channel) ?? getString(record.channelName) ?? '?';
      return `${agent} ${type === 'member.joined' ? 'joined' : 'left'} #${channel}`;
    }
    default: {
      const detailParts = Object.entries(record)
        .filter(([key]) => key !== 'type')
        .slice(0, 3)
        .map(([key, value]) => {
          if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return `${key}=${String(value)}`;
          }
          return key;
        });
      return detailParts.length > 0 ? detailParts.join(', ') : 'Event received';
    }
  }
}

export function useWebSocketFeed() {
  const { status } = useWebSocket();
  // Hydrate from localStorage so the live feed survives a page refresh. This
  // subtree only renders client-side (behind the session gate), so reading
  // storage in the initializer cannot cause an SSR hydration mismatch.
  const [events, setEvents] = useState<WebSocketFeedEvent[]>(loadStoredEvents);
  const lastStatusRef = useRef<string | null>(null);

  const pushEvent = useCallback((eventType: string, summary: string) => {
    const next: WebSocketFeedEvent = {
      id: `${eventType}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      eventType,
      summary,
      category: categorizeEvent(eventType),
      timestamp: new Date().toISOString(),
    };
    setEvents((prev) => [...prev, next].slice(-MAX_WS_EVENTS));
  }, []);

  const clearEvents = useCallback(() => {
    setEvents([]);
    try {
      window.localStorage.removeItem(WS_EVENTS_STORAGE_KEY);
    } catch {
      // Ignore storage failures (private mode / quota); state is still cleared.
    }
  }, []);

  // Persist the rolling window so a refresh restores recent activity.
  useEffect(() => {
    try {
      window.localStorage.setItem(WS_EVENTS_STORAGE_KEY, JSON.stringify(events));
    } catch {
      // Ignore storage failures (private mode / quota).
    }
  }, [events]);

  useEffect(() => {
    if (lastStatusRef.current === status) return;
    lastStatusRef.current = status;
    pushEvent(`status.${status}`, `Connection status: ${status}`);
  }, [pushEvent, status]);

  useEvent('*', (evt) => {
    const event = evt as WsClientEvent;
    const type = String((event as unknown as Record<string, unknown>).type ?? 'unknown');
    pushEvent(type, summarizeEvent(event));
  });

  const latest = useMemo(() => events[events.length - 1] ?? null, [events]);
  const newestFirst = useMemo(() => [...events].reverse(), [events]);

  return {
    status,
    events: newestFirst,
    latestEventAt: latest?.timestamp ?? null,
    clearEvents,
  };
}
