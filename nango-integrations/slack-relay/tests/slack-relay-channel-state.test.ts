import { describe, expect, it, vi } from 'vitest';

import sync from '../syncs/fetch-channels.js';

function createNango(overrides: Record<string, unknown> = {}) {
  return {
    setMergingStrategy: vi.fn(),
    batchSave: vi.fn(),
    batchDelete: vi.fn(),
    log: vi.fn(),
    get: vi.fn(),
    ...overrides,
  };
}

describe('slack-relay channel state handling', () => {
  it('saves archived channels as terminal channel records instead of deleting them', async () => {
    const nango = createNango({
      get: vi.fn().mockResolvedValue({
        data: {
          channel: {
            id: 'C123',
            name: 'general',
            is_archived: true,
            is_private: false,
            is_member: true,
          },
        },
      }),
    });

    await sync.onWebhook?.(nango as any, {
      event: {
        type: 'channel_archive',
        channel: 'C123',
      },
    });

    expect(nango.batchSave).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'C123', name: 'general', is_archived: true })],
      'SlackChannel',
    );
    expect(nango.batchDelete).not.toHaveBeenCalled();
  });

  it('still deletes channels on channel_deleted events', async () => {
    const nango = createNango();

    await sync.onWebhook?.(nango as any, {
      event: {
        type: 'channel_deleted',
        channel: 'C123',
      },
    });

    expect(nango.batchDelete).toHaveBeenCalledWith([{ id: 'C123' }], 'SlackChannel');
    expect(nango.batchSave).not.toHaveBeenCalled();
  });
});
