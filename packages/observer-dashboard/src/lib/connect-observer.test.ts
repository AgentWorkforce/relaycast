import { describe, expect, it, vi } from 'vitest';
import {
  connectObserverExpiryDelay,
  connectObserverIdentity,
  connectObserverUrlWithoutCapability,
  formatUtcTimestamp,
  loadConnectConversationMessages,
  sanitizeConnectObserverText,
  shouldInitializeConnectObserver,
} from './connect-observer';
import type { DmMessage, WorkspaceDmConversation } from '@relaycast/sdk';

describe('Relay Connect observer presentation', () => {
  it('renders message timestamps explicitly in UTC', () => {
    expect(formatUtcTimestamp('2026-10-05T05:46:12.000Z')).toBe('2026-10-05 05:46:12 UTC');
    expect(formatUtcTimestamp('2026-10-05T05:46:12.345Z')).toBe('2026-10-05 05:46:12.345 UTC');
  });

  it('redacts capability material and Connect invite URLs from observed text', () => {
    expect(
      sanitizeConnectObserverText(
        'Use https://agentrelay.com/connect/opaque_room.md?x=1 with ot_live_secret, rk_live_admin, and wh_live_hook.',
      ),
    ).toBe(
      'Use [Relay Connect invite redacted] with [credential redacted], [credential redacted], and [credential redacted].',
    );
  });

  it('removes query and fragment capabilities without removing the room binding', () => {
    expect(
      connectObserverUrlWithoutCapability(
        'https://agentrelay.com/observer/connect?observer_id=ot_room&key=ot_live_query#key=ot_live_fragment',
      ),
    ).toBe('https://agentrelay.com/observer/connect?observer_id=ot_room');
  });

  it('schedules long-lived expiry checks without overflowing browser timers', () => {
    const now = Date.parse('2026-10-05T00:00:00.000Z');
    expect(connectObserverExpiryDelay('2026-11-05T00:00:00.000Z', now)).toBe(2_147_000_000);
    expect(connectObserverExpiryDelay('2026-10-05T00:00:01.000Z', now)).toBe(1_000);
    expect(connectObserverExpiryDelay('2026-10-04T00:00:00.000Z', now)).toBe(0);
    expect(connectObserverExpiryDelay('not-a-date', now)).toBeNull();
  });

  it('does not restart Connect authentication when capability scrubbing rerenders the route', () => {
    const identity = connectObserverIdentity('ot_room', '2026-11-05T00:00:00.000Z');
    expect(
      shouldInitializeConnectObserver('connect', identity, 'ot_room', '2026-11-05T00:00:00.000Z', null),
    ).toBe(false);
    expect(
      shouldInitializeConnectObserver(null, null, 'ot_room', '2026-11-05T00:00:00.000Z', 'ot_live_new'),
    ).toBe(true);
    expect(
      shouldInitializeConnectObserver('connect', identity, 'ot_other', '2026-11-05T00:00:00.000Z', null),
    ).toBe(true);
    expect(
      shouldInitializeConnectObserver('workspace', identity, 'ot_room', '2026-11-05T00:00:00.000Z', null),
    ).toBe(true);
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
    const dmMessagePage = vi.fn(async (_conversationId: string, options: { before?: string }) =>
      options.before
        ? { messages: [finalMessage], nextBefore: finalMessage.id, exhausted: true }
        : { messages: firstPage, nextBefore: firstPage.at(-1)!.id, exhausted: false },
    );
    const conversation: WorkspaceDmConversation = {
      id: 'conversation-a',
      channelId: 'channel-a',
      type: '1:1',
      participants: ['alice', 'bob'],
      lastMessage: null,
      messageCount: 101,
    };

    const result = await loadConnectConversationMessages({ dmMessagePage }, conversation);

    expect(result).toHaveLength(101);
    expect(dmMessagePage).toHaveBeenNthCalledWith(2, 'conversation-a', {
      limit: 100,
      before: firstPage.at(-1)!.id,
    });
  });

  it('requests only messages newer than the cached conversation cursor', async () => {
    const dmMessagePage = vi.fn(async () => ({ messages: [] as DmMessage[], nextBefore: null, exhausted: true }));
    await loadConnectConversationMessages(
      { dmMessagePage },
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
    expect(dmMessagePage).toHaveBeenCalledWith('conversation-a', {
      limit: 100,
      after: '0000000000000000100',
    });
  });

  it('continues past a raw page hidden entirely by observer agent filters', async () => {
    const allowed: DmMessage = {
      id: '0000000000000000001',
      agentId: 'allowed-agent',
      agentName: 'alice',
      text: 'older allowed message',
      createdAt: '2026-10-05T05:46:12.000Z',
    };
    const dmMessagePage = vi
      .fn()
      .mockResolvedValueOnce({ messages: [], nextBefore: '0000000000000000100', exhausted: false })
      .mockResolvedValueOnce({ messages: [allowed], nextBefore: allowed.id, exhausted: true });
    const conversation: WorkspaceDmConversation = {
      id: 'conversation-a',
      channelId: 'channel-a',
      type: '1:1',
      participants: ['alice', 'bob'],
      lastMessage: null,
      messageCount: 101,
    };

    await expect(loadConnectConversationMessages({ dmMessagePage }, conversation)).resolves.toMatchObject([
      { id: allowed.id, text: allowed.text },
    ]);
    expect(dmMessagePage).toHaveBeenNthCalledWith(2, conversation.id, {
      limit: 100,
      before: '0000000000000000100',
    });
  });
});
