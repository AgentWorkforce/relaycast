import { describe, it, expect } from 'vitest';
import type { MessageWithMeta } from '@relaycast/sdk';
import {
  mapMessageWithMetaToChannelMessage,
  sortMessagesChronologically,
  formatReplyCountLabel,
} from '../adapters/messages.js';

function makeMessage(overrides: Partial<MessageWithMeta> = {}): MessageWithMeta {
  return {
    id: 'm1',
    agentName: 'Alice',
    agentId: 'a1',
    text: 'hello',
    blocks: null,
    attachments: [],
    createdAt: '2026-01-01T00:00:01.000Z',
    replyCount: 0,
    reactions: [],
    readByCount: 0,
    ...overrides,
  };
}

describe('message adapters', () => {
  it('maps MessageWithMeta to a channel message view model including thread summary', () => {
    const mapped = mapMessageWithMetaToChannelMessage(
      '#general',
      makeMessage({
        id: 'm42',
        agentName: 'Dashboard',
        text: 'thread parent',
        createdAt: '2026-01-01T00:00:42.000Z',
        replyCount: 2,
        reactions: [{ emoji: 'thumbsup', count: 2, agents: ['A', 'B'] }],
      }),
      { currentUserName: 'Dashboard' },
    );

    expect(mapped).toMatchObject({
      id: 'm42',
      channelId: '#general',
      from: 'Dashboard',
      fromEntityType: 'user',
      content: 'thread parent',
      timestamp: '2026-01-01T00:00:42.000Z',
      threadSummary: {
        threadId: 'm42',
        replyCount: 2,
      },
      reactions: {
        thumbsup: ['A', 'B'],
      },
      isRead: true,
    });
  });

  it('sorts messages chronologically (oldest to newest)', () => {
    const sorted = sortMessagesChronologically([
      makeMessage({ id: 'm3', createdAt: '2026-01-01T00:00:03.000Z' }),
      makeMessage({ id: 'm1', createdAt: '2026-01-01T00:00:01.000Z' }),
      makeMessage({ id: 'm2', createdAt: '2026-01-01T00:00:02.000Z' }),
    ]);

    expect(sorted.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('formats reply labels with correct singular/plural', () => {
    expect(formatReplyCountLabel(0)).toBe('0 replies');
    expect(formatReplyCountLabel(1)).toBe('1 reply');
    expect(formatReplyCountLabel(2)).toBe('2 replies');
  });
});
