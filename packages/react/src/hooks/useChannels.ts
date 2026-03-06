import { useContext, useEffect, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UseChannelsOptions, UseChannelsReturn } from '../types.js';

export function useChannels(options?: UseChannelsOptions): UseChannelsReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useChannels must be used within <RelayProvider>');
  const includeArchived = options?.includeArchived === true;

  useEffect(() => {
    store.setState({ channels: { ...store.getState().channels, loading: true } });

    ctx.agent.channels.list(includeArchived ? { includeArchived: true } : undefined)
      .then((data) => {
        store.setState({ channels: { data, loading: false, error: null } });
      })
      .catch((error: unknown) => {
        store.setState({
          channels: {
            ...store.getState().channels,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          },
        });
      });
  }, [ctx.agent, includeArchived, store]);

  const state = useSyncExternalStore(
    store.subscribe,
    () => store.getState().channels,
  );

  return {
    channels: state.data,
    loading: state.loading,
    error: state.error,
  };
}
