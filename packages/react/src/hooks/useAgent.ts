import { useContext } from 'react';
import type { AgentClient } from '@relaycast/sdk';
import { ClientContext } from '../context.js';

export function useAgent(): AgentClient {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useAgent must be used within <RelayProvider>');
  return ctx.agent;
}
