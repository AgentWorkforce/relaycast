'use client';

import { useEffect, useState } from 'react';
import { useEvent } from '@relaycast/react';
import type { DmConversationSummary, DmReceivedEvent, GroupDmReceivedEvent } from '@relaycast/sdk';

/**
 * Workspace DM list for observer dashboard.
 * No polling: initial snapshot + websocket-driven updates only.
 */
export function useWorkspaceDMs() {
  const [conversations, setConversations] = useState<DmConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    async function fetchDMs() {
      try {
        const res = await fetch('/api/dms');
        if (!res.ok) return;
        const data = await res.json();
        if (!mounted) return;
        setConversations(data.conversations ?? []);
      } catch {
        // Ignore fetch errors
      } finally {
        if (mounted) setLoading(false);
      }
    }

    void fetchDMs();
    return () => {
      mounted = false;
    };
  }, []);

  function updateConversation(
    id: string,
    type: '1:1' | 'group',
    senderName: string,
    text: string,
  ) {
    setConversations((prev) => {
      const idx = prev.findIndex((c) => c.id === id);
      if (idx === -1) {
        const created: DmConversationSummary = {
          id,
          type,
          name: type === 'group' ? null : senderName,
          participants: [senderName],
          lastMessage: text,
          unreadCount: 1,
        };
        return [created, ...prev];
      }

      const existing = prev[idx];
      const participants = existing.participants.includes(senderName)
        ? existing.participants
        : [...existing.participants, senderName];
      const updated: DmConversationSummary = {
        ...existing,
        participants,
        lastMessage: text,
        unreadCount: existing.unreadCount + 1,
      };
      const next = [...prev];
      next.splice(idx, 1);
      return [updated, ...next];
    });
  }

  useEvent('dm.received', (evt) => {
    const e = evt as DmReceivedEvent;
    updateConversation(e.conversationId, '1:1', e.message.agentName, e.message.text);
  });

  useEvent('group_dm.received', (evt) => {
    const e = evt as GroupDmReceivedEvent;
    updateConversation(e.conversationId, 'group', e.message.agentName, e.message.text);
  });

  return { conversations, loading };
}
