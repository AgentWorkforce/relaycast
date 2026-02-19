'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useEvent, useWebSocket } from '@relaycast/react';
import type { WsClientEvent } from '@relaycast/types';
import type { WebSocketFeedEvent } from '../types/dashboard';

const MAX_WS_EVENTS = 300;

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function getNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
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
      const agent = getString(message.agent_name) ?? 'unknown';
      const channel = getString(record.channel) ?? '?';
      return `${agent} -> #${channel}`;
    }
    case 'thread.reply': {
      const message = (record.message as Record<string, unknown> | undefined) ?? {};
      const agent = getString(message.agent_name) ?? 'unknown';
      return `${agent} replied in thread`;
    }
    case 'reaction.added': {
      const agent = getString(record.agent_name) ?? 'unknown';
      const emoji = getString(record.emoji) ?? '?';
      return `${agent} reacted ${emoji}`;
    }
    case 'reaction.removed': {
      const agent = getString(record.agent_name) ?? 'unknown';
      const emoji = getString(record.emoji) ?? '?';
      return `${agent} removed ${emoji}`;
    }
    case 'agent.online':
    case 'agent.offline': {
      const agentObj = (record.agent as Record<string, unknown> | undefined) ?? {};
      const name = getString(agentObj.name) ?? 'unknown';
      return `${name} ${type === 'agent.online' ? 'online' : 'offline'}`;
    }
    case 'dm.received': {
      const message = (record.message as Record<string, unknown> | undefined) ?? {};
      const agent = getString(message.agent_name) ?? 'unknown';
      return `DM from ${agent}`;
    }
    case 'group_dm.received': {
      const message = (record.message as Record<string, unknown> | undefined) ?? {};
      const agent = getString(message.agent_name) ?? 'unknown';
      return `Group DM from ${agent}`;
    }
    case 'channel.created':
    case 'channel.updated':
    case 'channel.archived': {
      const channelObj = (record.channel as Record<string, unknown> | undefined) ?? {};
      const channelName = getString(channelObj.name) ?? getString(record.channel_name) ?? '?';
      return `#${channelName}`;
    }
    case 'member.joined':
    case 'member.left': {
      const agent = getString(record.agent_name) ?? 'unknown';
      const channel = getString(record.channel) ?? getString(record.channel_name) ?? '?';
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
  const [events, setEvents] = useState<WebSocketFeedEvent[]>([]);
  const lastStatusRef = useRef<string | null>(null);

  const pushEvent = useCallback((eventType: string, summary: string) => {
    const next: WebSocketFeedEvent = {
      id: `${eventType}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      eventType,
      summary,
      timestamp: new Date().toISOString(),
    };
    setEvents((prev) => [...prev, next].slice(-MAX_WS_EVENTS));
  }, []);

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
  };
}
