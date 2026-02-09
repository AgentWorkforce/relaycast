import { useContext, useEffect, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UsePresenceReturn } from '../types.js';

export function usePresence(): UsePresenceReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('usePresence must be used within <RelayProvider>');

  useEffect(() => {
    store.setState({ agents: { ...store.getState().agents, loading: true } });

    ctx.relay.agents.list()
      .then((data) => {
        store.setState({ agents: { data, loading: false, error: null } });
      })
      .catch((error: unknown) => {
        store.setState({
          agents: {
            ...store.getState().agents,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          },
        });
      });
  }, [ctx.relay, store]);

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
