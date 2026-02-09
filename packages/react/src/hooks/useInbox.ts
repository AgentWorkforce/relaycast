import { useContext, useEffect, useCallback, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UseInboxReturn } from '../types.js';

export function useInbox(): UseInboxReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useInbox must be used within <RelayProvider>');

  const fetchInbox = useCallback(async () => {
    store.setState({ inbox: { ...store.getState().inbox, loading: true } });
    try {
      const data = await ctx.agent.inbox();
      store.setState({ inbox: { data, loading: false, error: null } });
    } catch (error: unknown) {
      store.setState({
        inbox: {
          ...store.getState().inbox,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        },
      });
    }
  }, [ctx.agent, store]);

  useEffect(() => {
    void fetchInbox();
  }, [fetchInbox]);

  const state = useSyncExternalStore(
    store.subscribe,
    () => store.getState().inbox,
  );

  return {
    inbox: state.data,
    loading: state.loading,
    error: state.error,
    refresh: fetchInbox,
  };
}
