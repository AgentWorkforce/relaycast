'use client';

import useSWR from 'swr';
import type { DashboardData, Channel } from '../types/dashboard';

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export function useDashboardData() {
  const { data, error, isLoading } = useSWR<DashboardData>('/api/data', fetcher, {
    refreshInterval: 5000,
  });

  return {
    agents: data?.agents ?? [],
    messages: data?.messages ?? [],
    isLoading,
    error,
  };
}

export function useChannels() {
  const { data, error, isLoading } = useSWR<{ ok: boolean; channels: Channel[] }>(
    '/api/channels',
    fetcher,
    { refreshInterval: 10000 }
  );

  return {
    channels: data?.channels ?? [],
    isLoading,
    error,
  };
}
