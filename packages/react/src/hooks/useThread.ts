import { useContext, useEffect, useRef, useSyncExternalStore } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { UseThreadReturn, ThreadData } from '../types.js';

const EMPTY: ThreadData = { parent: null, replies: [], loading: true, error: null };
const IDLE: ThreadData = { parent: null, replies: [], loading: false, error: null };

export function useThread(messageId: string): UseThreadReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  const requestSeq = useRef(0);
  if (!ctx || !store) throw new Error('useThread must be used within <RelayProvider>');

  useEffect(() => {
    if (!messageId) return;

    const seq = ++requestSeq.current;
    store.updateThread(messageId, (prev) => ({ ...prev, loading: true }));

    ctx.agent.thread(messageId)
      .then(({ parent, replies }) => {
        if (seq !== requestSeq.current) return;
        store.updateThread(messageId, () => ({ parent, replies, loading: false, error: null }));
      })
      .catch((error: unknown) => {
        if (seq !== requestSeq.current) return;
        store.updateThread(messageId, (prev) => ({
          ...prev,
          loading: false,
          error: error instanceof Error ? error : new Error(String(error)),
        }));
      });
    return () => {
      requestSeq.current += 1;
    };
  }, [messageId, ctx.agent, store]);

  const fallback = messageId ? EMPTY : IDLE;
  const data = useSyncExternalStore(
    store.subscribe,
    () => store.getState().threads[messageId] ?? fallback,
  );

  return {
    parent: data.parent,
    replies: data.replies,
    loading: data.loading,
    error: data.error,
  };
}
