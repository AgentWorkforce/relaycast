import { describe, expect, it, vi } from 'vitest';
import { formatUtcTimestamp, loadConnectConversationMessages, sanitizeConnectObserverText } from './connect-observer';
import type { DmMessage, WorkspaceDmConversation } from '@relaycast/sdk';

describe('Relay Connect observer presentation', () => {
  it('renders message timestamps explicitly in UTC', () => {
    expect(formatUtcTimestamp('2026-10-05T05:46:12.000Z')).toBe('2026-10-05 05:46:12 UTC');
    expect(formatUtcTimestamp('2026-10-05T05:46:12.345Z')).toBe('2026-10-05 05:46:12.345 UTC');
  });

  it('redacts capability material and Connect invite URLs from observed text', () => {
    expect(
      sanitizeConnectObserverText(
        'Use https://agentrelay.com/connect/opaque_room.md?x=1 with ot_live_secret and rk_live_admin.',
      ),
    ).toBe('Use [Relay Connect invite redacted] with [credential redacted] and [credential redacted].');
  });

  it('paginates by message id when a full page shares one timestamp', async () => {
    const timestamp = '2026-10-05T05:46:12.000Z';
    const message = (id: string): DmMessage => ({
      id,
      agentId: 'agent-alice',
      agentName: 'alice',
      text: id,
      createdAt: timestamp,
    });
    const firstPage = Array.from({ length: 100 }, (_, index) => message(String(200 - index).padStart(19, '0')));
    const finalMessage = message(String(100).padStart(19, '0'));
    const dmMessages = vi.fn(async (_conversationId: string, options: { before?: string }) =>
      options.before ? [finalMessage] : firstPage,
    );
    const conversation: WorkspaceDmConversation = {
      id: 'conversation-a',
      channelId: 'channel-a',
      type: '1:1',
      participants: ['alice', 'bob'],
      lastMessage: null,
      messageCount: 101,
    };

    const result = await loadConnectConversationMessages({ dmMessages }, conversation);

    expect(result).toHaveLength(101);
    expect(dmMessages).toHaveBeenNthCalledWith(2, 'conversation-a', {
      limit: 100,
      before: firstPage.at(-1)!.id,
    });
  });

  it('requests only messages newer than the cached conversation cursor', async () => {
    const dmMessages = vi.fn(async () => [] as DmMessage[]);
    await loadConnectConversationMessages(
      { dmMessages },
      {
        id: 'conversation-a',
        channelId: 'channel-a',
        type: '1:1',
        participants: ['alice', 'bob'],
        lastMessage: null,
        messageCount: 1,
      },
      '0000000000000000100',
    );
    expect(dmMessages).toHaveBeenCalledWith('conversation-a', {
      limit: 100,
      after: '0000000000000000100',
    });
  });
});
