import { createContext } from 'react';
import type { RelayCast, AgentClient, WsClient } from '@relaycast/sdk';
import type { RelayStore } from './types.js';

export interface ClientContextValue {
  relay: RelayCast;
  agent: AgentClient;
  ws: WsClient;
}

export const ClientContext = createContext<ClientContextValue | null>(null);

export const StoreContext = createContext<RelayStore | null>(null);
