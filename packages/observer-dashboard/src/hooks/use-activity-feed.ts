'use client';

import { useCallback, useRef, useState } from 'react';
import { useEvent } from '@relaycast/react';
import type { ActivityEvent, ActivityEventType } from '../types/dashboard';
import type {
  MessageCreatedEvent,
  ThreadReplyEvent,
  MessageReactedEvent,
  AgentStatusActiveEvent,
  AgentStatusOfflineEvent,
  DmReceivedEvent,
  GroupDmReceivedEvent,
} from '@relaycast/sdk';

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
    pushLiveEvent('message_sent', `${e.message.agentName} sent a message in #${e.channel}`, e.message.agentName);
  });

  useEvent('thread.reply', (evt) => {
    const e = evt as ThreadReplyEvent;
    pushLiveEvent('thread_reply', `${e.message.agentName} replied in a thread`, e.message.agentName);
  });

  useEvent('message.reacted', (evt) => {
    const e = evt as MessageReactedEvent;
    pushLiveEvent('reaction', `${e.agentName} reacted ${e.emoji}`, e.agentName);
  });

  useEvent('agent.status.active', (evt) => {
    const e = evt as AgentStatusActiveEvent;
    if (!e.agent.name.startsWith('_dashboard_')) {
      pushLiveEvent('connection', `${e.agent.name} is online`, e.agent.name);
    }
  });

  useEvent('agent.status.offline', (evt) => {
    const e = evt as AgentStatusOfflineEvent;
    if (!e.agent.name.startsWith('_dashboard_')) {
      pushLiveEvent('agent_idle', `${e.agent.name} went offline`, e.agent.name);
    }
  });

  useEvent('dm.received', (evt) => {
    const e = evt as DmReceivedEvent;
    pushLiveEvent('message_sent', `${e.message.agentName} sent a DM`, e.message.agentName);
  });

  useEvent('group_dm.received', (evt) => {
    const e = evt as GroupDmReceivedEvent;
    pushLiveEvent('message_sent', `${e.message.agentName} sent a group DM`, e.message.agentName);
  });

  return eventsRef.current;
}
