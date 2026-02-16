import { useContext } from 'react';
import type { RelayCast } from '@relaycast/sdk';
import { ClientContext } from '../context.js';

export function useRelay(): RelayCast {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useRelay must be used within <RelayProvider>');
  return ctx.relay;
}
