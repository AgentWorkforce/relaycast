import React, { useEffect, useMemo, useRef } from 'react';
import { RelayCast, WsClient } from '@relaycast/sdk';
import type { WsClientEvent } from '@relaycast/sdk';
import { ClientContext, StoreContext } from './context.js';
import { createStore } from './store.js';
import { handleServerEvent } from './reducer.js';

export interface RelayProviderProps {
  apiKey: string;
  agentToken: string;
  wsToken?: string;
  baseUrl?: string;
  channels?: string[];
  debug?: boolean;
  children: React.ReactNode;
}

export function RelayProvider({ apiKey, agentToken, wsToken, baseUrl, channels, debug, children }: RelayProviderProps) {
  const channelKey = JSON.stringify(channels ?? []);
  const subscribedChannels = useMemo(() => JSON.parse(channelKey) as string[], [channelKey]);
  const subscribedChannelsRef = useRef<string[]>(subscribedChannels);

  const clients = useMemo(() => {
    const relay = new RelayCast({ apiKey, baseUrl });
    const agent = relay.as(agentToken);
    const ws = new WsClient({ token: wsToken ?? agentToken, baseUrl, debug });
    return { relay, agent, ws };
  }, [apiKey, agentToken, wsToken, baseUrl, debug]);

  const store = useMemo(() => createStore(), []);

  useEffect(() => {
    subscribedChannelsRef.current = subscribedChannels;
  }, [subscribedChannels]);

  useEffect(() => {
    const { ws } = clients;
    store.setState({ connectionStatus: 'connecting' });
    ws.connect();

    const offOpen = ws.on('open', () => {
      store.setState({ connectionStatus: 'connected' });
      const currentChannels = subscribedChannelsRef.current;
      if (currentChannels.length > 0) {
        ws.subscribe(currentChannels);
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
        handleServerEvent(store, event as WsClientEvent);
      }
    });

    return () => {
      offOpen();
      offClose();
      offAll();
      store.setState({ connectionStatus: 'disconnected' });
      ws.disconnect();
    };
  }, [clients, store]);

  useEffect(() => {
    const { ws } = clients;
    if (!ws.connected || subscribedChannels.length === 0) {
      return;
    }

    ws.subscribe(subscribedChannels);
    return () => {
      ws.unsubscribe(subscribedChannels);
    };
  }, [clients, subscribedChannels]);

  return (
    <ClientContext.Provider value={clients}>
      <StoreContext.Provider value={store}>
        {children}
      </StoreContext.Provider>
    </ClientContext.Provider>
  );
}
