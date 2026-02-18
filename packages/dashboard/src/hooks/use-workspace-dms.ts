'use client';

import { useEffect, useState } from 'react';
import { useEvent } from '@relaycast/react';
import type { DmConversationSummary } from '@relaycast/types';

const POLL_INTERVAL = 15_000; // 15 seconds

/**
 * Fetches DM conversations via the workspace-level API endpoint.
 * The observer agent isn't a DM participant, so we poll the server-side
 * endpoint which uses the workspace key for full visibility.
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
        setLoading(false);
      } catch {
        // Ignore fetch errors
      }
    }

    fetchDMs();
    const interval = setInterval(fetchDMs, POLL_INTERVAL);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  // Refetch when DM events come in via WebSocket
  useEvent('dm.received', () => {
    fetch('/api/dms')
      .then((res) => res.json())
      .then((data) => setConversations(data.conversations ?? []))
      .catch(() => {});
  });

  useEvent('group_dm.received', () => {
    fetch('/api/dms')
      .then((res) => res.json())
      .then((data) => setConversations(data.conversations ?? []))
      .catch(() => {});
  });

  return { conversations, loading };
}
