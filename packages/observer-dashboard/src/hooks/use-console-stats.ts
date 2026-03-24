'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  ConsoleAgentStat,
  ConsoleCostStats,
  ConsoleOverview,
} from '../types/dashboard';

const REFRESH_INTERVAL_MS = 30000;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
  };
}

async function fetchConsoleResource<T>(resource: string, searchParams?: URLSearchParams): Promise<T> {
  const suffix = searchParams && Array.from(searchParams).length > 0
    ? `?${searchParams.toString()}`
    : '';
  const response = await fetch(`/observer/api/console/${resource}${suffix}`, {
    cache: 'no-store',
  });
  const payload = await response.json() as Envelope<T>;
  if (!response.ok || !payload.ok || payload.data === undefined) {
    throw new Error(payload.error?.message ?? `Failed to load console ${resource}`);
  }
  return payload.data;
}

function useConsoleResource<T>(resource: string, searchParams?: URLSearchParams) {
  const queryKey = searchParams?.toString() ?? '';
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (showSpinner = false) => {
    try {
      if (showSpinner) {
        setLoading(true);
      }
      const next = await fetchConsoleResource<T>(resource, searchParams);
      setData(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to load console ${resource}`);
    } finally {
      setLoading(false);
    }
  }, [resource, queryKey]);

  useEffect(() => {
    void refresh(true);
  }, [refresh]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refresh(false);
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refresh]);

  return { data, loading, error, refresh };
}

export function useConsoleOverview(days = 7) {
  const params = new URLSearchParams({ days: String(days) });
  return useConsoleResource<ConsoleOverview>('stats', params);
}

export function useConsoleAgentStats(days = 7, limit = 6) {
  const params = new URLSearchParams({
    days: String(days),
    limit: String(limit),
  });
  return useConsoleResource<ConsoleAgentStat[]>('agents', params);
}

export function useConsoleCostStats(days = 7) {
  const params = new URLSearchParams({ days: String(days) });
  return useConsoleResource<ConsoleCostStats>('costs', params);
}
