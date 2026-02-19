'use client';

import { useCallback, useRef, useState } from 'react';
import { useEvent } from '@relaycast/react';
import type { ActivityEvent, ActivityEventType } from '../types/dashboard';
import type {
  MessageCreatedEvent,
  ThreadReplyEvent,
  ReactionAddedEvent,
  AgentOnlineEvent,
  AgentOfflineEvent,
  DmReceivedEvent,
  GroupDmReceivedEvent,
} from '@relaycast/types';

export function useActivityFeed(): ActivityEvent[] {
  const eventsRef = useRef<ActivityEvent[]>([]);
  const [, forceUpdate] = useState(0);

  const pushLiveEvent = useCallback(
    (type: ActivityEventType, summary: string, agent?: string) => {
      const event: ActivityEvent = {
        id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type,
        summary,
        timestamp: new Date().toISOString(),
        agent,
      };
      eventsRef.current = [...eventsRef.current, event].slice(-200);
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

  useEvent('dm.received', (evt) => {
    const e = evt as DmReceivedEvent;
    pushLiveEvent('message_sent', `${e.message.agent_name} sent a DM`, e.message.agent_name);
  });

  useEvent('group_dm.received', (evt) => {
    const e = evt as GroupDmReceivedEvent;
    pushLiveEvent('message_sent', `${e.message.agent_name} sent a group DM`, e.message.agent_name);
  });

  return eventsRef.current;
}
