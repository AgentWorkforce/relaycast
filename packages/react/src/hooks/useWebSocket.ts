import { useContext, useCallback, useSyncExternalStore } from 'react';
import type { WsClient } from '@relaycast/sdk';
import { ClientContext, StoreContext } from '../context.js';
import type { UseWebSocketReturn } from '../types.js';

export function useWebSocket(): UseWebSocketReturn & { ws: WsClient } {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useWebSocket must be used within <RelayProvider>');

  const status = useSyncExternalStore(
    store.subscribe,
    useCallback(() => store.getState().connectionStatus, [store]),
  );

  return { status, ws: ctx.ws };
}
