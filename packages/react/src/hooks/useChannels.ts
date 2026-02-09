import { useContext, useEffect, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UseChannelsReturn } from '../types.js';

export function useChannels(): UseChannelsReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useChannels must be used within <RelayProvider>');

  useEffect(() => {
    store.setState({ channels: { ...store.getState().channels, loading: true } });

    ctx.agent.channels.list()
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
  }, [ctx.agent, store]);

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
