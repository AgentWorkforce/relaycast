import { useContext, useCallback } from 'react';
import { ClientContext } from '../context.js';
import type { UseReactionReturn } from '../types.js';

export function useReaction(): UseReactionReturn {
  const ctx = useContext(ClientContext);
  if (!ctx) throw new Error('useReaction must be used within <RelayProvider>');

  const react = useCallback(async (messageId: string, emoji: string): Promise<void> => {
    await ctx.agent.react(messageId, emoji);
  }, [ctx.agent]);

  const unreact = useCallback(async (messageId: string, emoji: string): Promise<void> => {
    await ctx.agent.unreact(messageId, emoji);
  }, [ctx.agent]);

  return { react, unreact };
}
