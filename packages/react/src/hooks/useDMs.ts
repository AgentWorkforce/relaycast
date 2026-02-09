import { useContext, useEffect, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UseDMsReturn } from '../types.js';

export function useDMs(): UseDMsReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useDMs must be used within <RelayProvider>');

  useEffect(() => {
    store.setState({ dms: { ...store.getState().dms, loading: true } });

    ctx.agent.dms.conversations()
      .then((data) => {
        store.setState({ dms: { data, loading: false, error: null } });
      })
      .catch((error: unknown) => {
        store.setState({
          dms: {
            ...store.getState().dms,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          },
        });
      });
  }, [ctx.agent, store]);

  // Refetch when DM events flag loading: true
  const state = useSyncExternalStore(
    store.subscribe,
    () => store.getState().dms,
  );

  useEffect(() => {
    if (!state.loading) return;
    ctx.agent.dms.conversations()
      .then((data) => {
        store.setState({ dms: { data, loading: false, error: null } });
      })
      .catch(() => {
        // Silently fail on refetch — keep existing data
        store.setState({ dms: { ...store.getState().dms, loading: false } });
      });
  }, [state.loading, ctx.agent, store]);

  return {
    conversations: state.data,
    loading: state.loading,
    error: state.error,
  };
}
