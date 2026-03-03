import { useContext } from 'react';
import { ClientContext, type ClientContextValue } from '../context.js';

export function useRelayClient(): ClientContextValue | null {
  return useContext(ClientContext);
}
