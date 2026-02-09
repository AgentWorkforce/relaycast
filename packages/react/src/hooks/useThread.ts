import { useContext, useEffect, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UseThreadReturn, ThreadData } from '../types.js';

const EMPTY: ThreadData = { parent: null, replies: [], loading: true, error: null };

export function useThread(messageId: string): UseThreadReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useThread must be used within <RelayProvider>');

  useEffect(() => {
    store.updateThread(messageId, (prev) => ({ ...prev, loading: true }));

    ctx.agent.thread(messageId)
      .then(({ parent, replies }) => {
        store.updateThread(messageId, () => ({ parent, replies, loading: false, error: null }));
      })
      .catch((error: unknown) => {
        store.updateThread(messageId, (prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      });
  }, [messageId, ctx.agent, store]);

  const data = useSyncExternalStore(
    store.subscribe,
    () => store.getState().threads[messageId] ?? EMPTY,
  );

  return {
    parent: data.parent,
    replies: data.replies,
    loading: data.loading,
    error: data.error,
  };
}
