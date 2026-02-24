import { describe, it, expect, vi, afterEach } from 'vitest';
import React, { type ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { MessageWithMeta } from '@relaycast/sdk';
import { ClientContext, StoreContext } from '../context.js';
import { createStore } from '../store.js';
import { useMessages } from '../hooks/useMessages.js';

function makeMessage(id: string, createdAt: string): MessageWithMeta {
  return {
    id,
    agentName: 'Alice',
    agentId: 'a1',
    text: `message-${id}`,
    blocks: null,
    attachments: [],
    createdAt,
    replyCount: 0,
    reactions: [],
    readByCount: 0,
  };
}

function createWrapper(messagesMock: ReturnType<typeof vi.fn>) {
  const store = createStore();
  const ws = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };

  const client = {
    relay: {},
    agent: {
      messages: messagesMock,
    },
    ws,
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientContext.Provider value={client as any}>
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    </ClientContext.Provider>
  );

  return { wrapper, ws };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('useMessages', () => {
  it('normalizes initial history to chronological order', async () => {
    const messagesMock = vi.fn().mockResolvedValueOnce([
      makeMessage('m3', '2026-01-01T00:00:03.000Z'),
      makeMessage('m2', '2026-01-01T00:00:02.000Z'),
      makeMessage('m1', '2026-01-01T00:00:01.000Z'),
    ]);

    const { wrapper, ws } = createWrapper(messagesMock);
    const { result, unmount } = renderHook(() => useMessages('general'), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
    expect(ws.subscribe).toHaveBeenCalledWith(['general']);

    unmount();
    expect(ws.unsubscribe).toHaveBeenCalledWith(['general']);
  });

  it('keeps chronological order when fetching older pages', async () => {
    const messagesMock = vi
      .fn()
      .mockResolvedValueOnce([
        makeMessage('m3', '2026-01-01T00:00:03.000Z'),
        makeMessage('m2', '2026-01-01T00:00:02.000Z'),
        makeMessage('m1', '2026-01-01T00:00:01.000Z'),
      ])
      .mockResolvedValueOnce([
        makeMessage('m0', '2026-01-01T00:00:00.000Z'),
        makeMessage('m-1', '2025-12-31T23:59:59.000Z'),
      ]);

    const { wrapper } = createWrapper(messagesMock);
    const { result } = renderHook(() => useMessages('general'), { wrapper });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    await act(async () => {
      await result.current.fetchMore();
    });

    expect(messagesMock).toHaveBeenNthCalledWith(2, 'general', { before: 'm1', limit: 50 });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.id)).toEqual([
        'm-1',
        'm0',
        'm1',
        'm2',
        'm3',
      ]);
    });
  });
});
