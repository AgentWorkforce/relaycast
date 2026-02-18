'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from '@relaycast/react';
import type { ActivityEvent, ActivityEventType } from '../types/dashboard';
import type {
  MessageCreatedEvent,
  ThreadReplyEvent,
  ReactionAddedEvent,
  AgentOnlineEvent,
  AgentOfflineEvent,
} from '@relaycast/types';

const POLL_INTERVAL = 10_000; // 10 seconds

export function useActivityFeed(): ActivityEvent[] {
  const [polledEvents, setPolledEvents] = useState<ActivityEvent[]>([]);
  const liveEventsRef = useRef<ActivityEvent[]>([]);
  const [, forceUpdate] = useState(0);
  const polledIdsRef = useRef(new Set<string>());

  // Poll the server-side activity endpoint (uses workspace key, sees everything)
  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const res = await fetch('/api/activity');
        if (!res.ok) return;
        const data = await res.json();
        if (!mounted) return;
        const events: ActivityEvent[] = data.events ?? [];
        setPolledEvents(events);
        // Track polled IDs so we don't duplicate with live events
        polledIdsRef.current = new Set(events.map((e) => e.id));
        // Clear live events that are now covered by the poll
        liveEventsRef.current = liveEventsRef.current.filter(
          (e) => !polledIdsRef.current.has(e.id)
        );
      } catch {
        // Ignore fetch errors
      }
    }

    poll();
    const interval = setInterval(poll, POLL_INTERVAL);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const pushLiveEvent = useCallback(
    (type: ActivityEventType, summary: string, agent?: string) => {
      const event: ActivityEvent = {
        id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        summary,
        timestamp: new Date().toISOString(),
        agent,
      };
      liveEventsRef.current = [...liveEventsRef.current, event].slice(-50);
      forceUpdate((n) => n + 1);
    },
    []
  );

  // Live WS events for instant updates (supplements polling)
  useEvent('message.created', (evt) => {
    const e = evt as MessageCreatedEvent;
    pushLiveEvent('message_sent', `${e.message.agent_name} sent a message in #${e.channel}`, e.message.agent_name);
  });

  useEvent('thread.reply', (evt) => {
    const e = evt as ThreadReplyEvent;
    pushLiveEvent('thread_reply', `${e.message.agent_name} replied in a thread`, e.message.agent_name);
  });

  useEvent('reaction.added', (evt) => {
    const e = evt as ReactionAddedEvent;
    pushLiveEvent('reaction', `${e.agent_name} reacted ${e.emoji}`, e.agent_name);
  });

  useEvent('agent.online', (evt) => {
    const e = evt as AgentOnlineEvent;
    if (!e.agent.name.startsWith('_dashboard_')) {
      pushLiveEvent('connection', `${e.agent.name} is online`, e.agent.name);
    }
  });

  useEvent('agent.offline', (evt) => {
    const e = evt as AgentOfflineEvent;
    if (!e.agent.name.startsWith('_dashboard_')) {
      pushLiveEvent('agent_idle', `${e.agent.name} went offline`, e.agent.name);
    }
  });

  // Merge polled + live events, deduplicate, sort chronologically
  const merged = [...polledEvents, ...liveEventsRef.current];
  merged.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return merged.slice(-200);
}
