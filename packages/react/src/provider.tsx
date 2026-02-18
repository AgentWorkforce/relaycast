import React, { useEffect, useMemo } from 'react';
import { RelayCast, WsClient } from '@relaycast/sdk';
import type { ServerEvent } from '@relaycast/types';
import { ClientContext, StoreContext } from './context.js';
import { createStore } from './store.js';
import { handleServerEvent } from './reducer.js';

export interface RelayProviderProps {
  apiKey: string;
  agentToken: string;
  baseUrl?: string;
  channels?: string[];
  debug?: boolean;
  children: React.ReactNode;
}

export function RelayProvider({ apiKey, agentToken, baseUrl, channels, debug, children }: RelayProviderProps) {
  const clients = useMemo(() => {
    const relay = new RelayCast({ apiKey, baseUrl });
    const agent = relay.as(agentToken);
    const ws = new WsClient({ token: agentToken, baseUrl, debug });
    return { relay, agent, ws };
  }, [apiKey, agentToken, baseUrl, debug]);

  const store = useMemo(() => createStore(), []);

  useEffect(() => {
    const { ws } = clients;
    store.setState({ connectionStatus: 'connecting' });
    ws.connect();

    const offOpen = ws.on('open', () => {
      store.setState({ connectionStatus: 'connected' });
      if (channels && channels.length > 0) {
        ws.subscribe(channels);
      }
    });

    const offClose = ws.on('close', () => {
      const current = store.getState().connectionStatus;
      store.setState({
        connectionStatus: current === 'disconnected' ? 'disconnected' : 'reconnecting',
      });
    });

    const offAll = ws.on('*', (event) => {
      const t = event.type as string;
      // Filter out client-only events and pong
      if (t !== 'pong' && t !== 'open' && t !== 'close' && t !== 'error' && t !== 'reconnecting') {
        handleServerEvent(store, event as ServerEvent);
      }
    });

    return () => {
      offOpen();
      offClose();
      offAll();
      store.setState({ connectionStatus: 'disconnected' });
      ws.disconnect();
    };
  }, [clients, store, channels]);

  return (
    <ClientContext.Provider value={clients}>
      <StoreContext.Provider value={store}>
        {children}
      </StoreContext.Provider>
    </ClientContext.Provider>
  );
}
