'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEvent } from '@relaycast/react';
import type { ConsoleMessageLog } from '../types/dashboard';

const DEFAULT_LIMIT = 40;
const REFRESH_INTERVAL_MS = 30000;
const EVENT_REFRESH_DEBOUNCE_MS = 350;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

async function fetchConsoleMessages(limit: number): Promise<ConsoleMessageLog[]> {
  const response = await fetch(`/observer/api/console/messages?limit=${limit}`, {
    cache: 'no-store',
  });
  const payload = await response.json() as Envelope<ConsoleMessageLog[]>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new Error(payload.error?.message ?? 'Failed to load console feed');
  }
  return payload.data;
}

export function useConsoleFeed(limit = DEFAULT_LIMIT) {
  const [messages, setMessages] = useState<ConsoleMessageLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const timeoutRef = useRef<number | null>(null);

  const refresh = useCallback(async (showSpinner = false) => {
    try {
      if (showSpinner) {
        setLoading(true);
      }
      const next = await fetchConsoleMessages(limit);
      setMessages(next);
      setError(null);
      setLastUpdatedAt(new Date().toISOString());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load console feed');
    } finally {
      setLoading(false);
    }
  }, [limit]);

  const scheduleRefresh = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      void refresh(false);
    }, EVENT_REFRESH_DEBOUNCE_MS);
  }, [refresh]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh(false);
    }, REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
      }
    };
  }, [refresh]);

  useEvent('message.created', scheduleRefresh);
  useEvent('dm.received', scheduleRefresh);
  useEvent('group_dm.received', scheduleRefresh);
  useEvent('thread.reply', scheduleRefresh);

  return {
    messages,
    loading,
    error,
    lastUpdatedAt,
    refresh,
  };
}
