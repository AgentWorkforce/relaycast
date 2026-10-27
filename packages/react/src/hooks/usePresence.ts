import { useCallback, useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UsePresenceReturn } from '../types.js';

export function usePresence(): UsePresenceReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('usePresence must be used within <RelayProvider>');

  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshAgents = useCallback(async (showLoading: boolean) => {
    if (showLoading) {
      store.setState({ agents: { ...store.getState().agents, loading: true } });
    }

    try {
      const [list, presence] = await Promise.all([
        ctx.relay.agents.list(),
        ctx.relay.agents.presence().catch(() => null),
      ]);

      const presenceByName = new Map<string, 'online' | 'offline'>();
      if (presence) {
        for (const item of presence) presenceByName.set(item.agentName, item.status);
      }

      const merged = list.map((agent) => ({
        ...agent,
        status: presenceByName.get(agent.name) ?? agent.status,
      }));

      store.setState({ agents: { data: merged, loading: false, error: null } });
    } catch (error: unknown) {
      store.setState({
        agents: {
          ...store.getState().agents,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        },
      });
    }
  }, [ctx.relay, store]);

  useEffect(() => {
    void refreshAgents(true);

    const scheduleRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => {
        refreshTimer.current = null;
        void refreshAgents(false);
      }, 150);
    };

    const offActive = ctx.ws.on('agent.status.active', scheduleRefresh);
    const offOffline = ctx.ws.on('agent.status.offline', scheduleRefresh);
    const offChanged = ctx.ws.on('agent.status.changed', scheduleRefresh);

    return () => {
      offActive();
      offOffline();
      offChanged();
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current);
        refreshTimer.current = null;
      }
    };
  }, [ctx.ws, refreshAgents]);

  const state = useSyncExternalStore(
    store.subscribe,
    () => store.getState().agents,
  );

  return {
    agents: state.data,
    loading: state.loading,
    error: state.error,
  };
}
