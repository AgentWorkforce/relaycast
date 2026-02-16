import { useContext, useEffect, useRef } from 'react';
import type { WsClientEvent } from '@relaycast/types';
import type { EventHandler } from '@relaycast/sdk';
import { ClientContext } from '../context.js';

export function useEvent(eventType: string, handler: EventHandler<WsClientEvent>): void {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useEvent must be used within <RelayProvider>');

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const off = ctx.ws.on(eventType, (event) => {
      handlerRef.current(event);
    });
    return off;
  }, [eventType, ctx.ws]);
}
