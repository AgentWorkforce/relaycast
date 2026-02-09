import { useContext } from 'react';
import type { Relay } from '@relaycast/sdk';
import { ClientContext } from '../context.js';

export function useRelay(): Relay {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useRelay must be used within <RelayProvider>');
  return ctx.relay;
}
