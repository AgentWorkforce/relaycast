import { useContext, useState, useCallback } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { MessageWithMeta } from '@relaycast/sdk';
import type { UseReplyReturn } from '../types.js';

export function useReply(): UseReplyReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useReply must be used within <RelayProvider>');

  const [sending, setSending] = useState(false);

  const reply = useCallback(async (
    messageId: string,
    text: string,
  ): Promise<MessageWithMeta> => {
    setSending(true);
    try {
      const msg = await ctx.agent.reply(messageId, text);
      // Optimistic: append reply to thread (deduplicated when WS event arrives)
      store.updateThread(messageId, (prev) => {
        if (prev.replies.some((r) => r.id === msg.id)) return prev;
        return { ...prev, replies: [...prev.replies, msg] };
      });
      return msg;
    } finally {
      setSending(false);
    }
  }, [ctx.agent, store]);

  return { reply, sending };
}
