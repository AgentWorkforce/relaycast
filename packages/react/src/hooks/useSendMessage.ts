import { useContext, useState, useCallback } from 'react';
import { ClientContext, StoreContext } from '../context.js';
import type { MessageWithMeta, MessageBlock } from '@relaycast/types';
import type { UseSendMessageReturn } from '../types.js';

export function useSendMessage(): UseSendMessageReturn {
  const ctx = useContext(ClientContext);
  const store = useContext(StoreContext);
  if (!ctx || !store) throw new Error('useSendMessage must be used within <RelayProvider>');

  const [sending, setSending] = useState(false);

  const send = useCallback(async (
    channel: string,
    text: string,
    opts?: { attachments?: string[]; blocks?: MessageBlock[] },
  ): Promise<MessageWithMeta> => {
    setSending(true);
    try {
      const msg = await ctx.agent.send(channel, text, opts);
      // Optimistic: append to local state (deduplicated when WS event arrives)
      store.updateChannelMessages(channel, (prev) => {
        if (prev.messages.some((m) => m.id === msg.id)) return prev;
        return { ...prev, messages: [...prev.messages, msg] };
      });
      return msg;
    } finally {
      setSending(false);
    }
  }, [ctx.agent, store]);

  return { send, sending };
}
