import { useContext, useEffect, useCallback, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UseMessagesReturn, ChannelMessages } from '../types.js';

const EMPTY: ChannelMessages = { messages: [], loading: true, error: null };

export function useMessages(channel: string): UseMessagesReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useMessages must be used within <RelayProvider>');

  useEffect(() => {
    store.updateChannelMessages(channel, (prev) => ({ ...prev, loading: true }));

    ctx.agent.messages(channel, { limit: 50 })
      .then((messages) => {
        store.updateChannelMessages(channel, () => ({ messages, loading: false, error: null }));
      })
      .catch((error: unknown) => {
        store.updateChannelMessages(channel, (prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      });

    ctx.ws.subscribe([channel]);
    return () => {
      ctx.ws.unsubscribe([channel]);
    };
  }, [channel, ctx.agent, ctx.ws, store]);

  const data = useSyncExternalStore(
    store.subscribe,
    () => store.getState().channelMessages[channel] ?? EMPTY,
  );

  const fetchMore = useCallback(async () => {
    const current = store.getState().channelMessages[channel];
    if (!current || current.messages.length === 0) return;
    const oldest = current.messages[0];
    const older = await ctx.agent.messages(channel, { before: oldest.id, limit: 50 });
    store.updateChannelMessages(channel, (prev) => ({
      ...prev,
      messages: [...older, ...prev.messages],
    }));
  }, [channel, ctx.agent, store]);

  return {
    messages: data.messages,
    loading: data.loading,
    error: data.error,
    fetchMore,
  };
}
