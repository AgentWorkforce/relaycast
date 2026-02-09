import { useContext, useEffect, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UseChannelReturn, ChannelDetail } from '../types.js';

const EMPTY: ChannelDetail = { channel: null, members: [], loading: true, error: null };

export function useChannel(name: string): UseChannelReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useChannel must be used within <RelayProvider>');

  useEffect(() => {
    store.updateChannelDetail(name, (prev) => ({ ...prev, loading: true }));

    ctx.agent.channels.get(name)
      .then((result) => {
        const { members, ...channel } = result;
        store.updateChannelDetail(name, () => ({ channel, members, loading: false, error: null }));
      })
      .catch((error: unknown) => {
        store.updateChannelDetail(name, (prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      });
  }, [name, ctx.agent, store]);

  const data = useSyncExternalStore(
    store.subscribe,
    () => store.getState().channelDetails[name] ?? EMPTY,
  );

  return {
    channel: data.channel,
    members: data.members,
    loading: data.loading,
    error: data.error,
  };
}
