import React, { useEffect, useMemo } from 'react';
import { Relay, WsClient } from '@relaycast/sdk';
import { ClientContext, StoreContext } from './context.js';
import { createStore } from './store.js';
import { handleServerEvent } from './reducer.js';

export interface RelayProviderProps {
  apiKey: string;
  agentToken: string;
  baseUrl?: string;
  channels?: string[];
  children: React.ReactNode;
}

export function RelayProvider({ apiKey, agentToken, baseUrl, channels, children }: RelayProviderProps) {
  const clients = useMemo(() => {
    const relay = new Relay({ apiKey, baseUrl });
    const agent = relay.as(agentToken);
    const ws = new WsClient({ token: agentToken, baseUrl });
    return { relay, agent, ws };
  }, [apiKey, agentToken, baseUrl]);

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
      if (t !== 'pong' && t !== 'open' && t !== 'close') {
        handleServerEvent(store, event);
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
