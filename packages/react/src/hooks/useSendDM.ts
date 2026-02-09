import { useContext, useState, useCallback } from 'react';
import { ClientContext } from '../context.js';
import type { UseSendDMReturn } from '../types.js';

export function useSendDM(): UseSendDMReturn {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useSendDM must be used within <RelayProvider>');

  const [sending, setSending] = useState(false);

  const send = useCallback(async (agent: string, text: string): Promise<void> => {
    setSending(true);
    try {
      await ctx.agent.dm(agent, text);
    } finally {
      setSending(false);
    }
  }, [ctx.agent]);

  return { send, sending };
}
