import { describe, it, expect, vi } from 'vitest';
import React, { type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MessageWithMeta } from '@relaycast/sdk';
import { ClientContext } from '../context.js';
import { StoreContext } from '../context.js';
import { createStore } from '../store.js';
import { useChannel } from '../hooks/useChannel.js';
import { useMessages } from '../hooks/useMessages.js';
import { useThread } from '../hooks/useThread.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

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

function createWrapper(agent: Record<string, unknown>) {
  const store = createStore();
  const client = {
    relay: {},
    agent,
    ws: {
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
    },
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <ClientContext.Provider value={client as any}>
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    </ClientContext.Provider>
  );

  return { wrapper, store };
}

describe('React data fetch race guards', () => {
  it('ignores stale useMessages responses after the channel changes', async () => {
    const general = deferred<MessageWithMeta[]>();
    const random = deferred<MessageWithMeta[]>();
    const messages = vi.fn()
      .mockReturnValueOnce(general.promise)
      .mockReturnValueOnce(random.promise);
    const { wrapper, store } = createWrapper({ messages });

    const { result, rerender } = renderHook(({ channel }) => useMessages(channel), {
      wrapper,
      initialProps: { channel: 'general' },
    });

    rerender({ channel: 'random' });

    await act(async () => {
      random.resolve([makeMessage('r1', '2026-01-01T00:00:01.000Z')]);
      await random.promise;
    });

    await waitFor(() => {
      expect(result.current.messages.map((message) => message.id)).toEqual(['r1']);
    });

    await act(async () => {
      general.resolve([makeMessage('g1', '2026-01-01T00:00:02.000Z')]);
      await general.promise;
    });

    expect(result.current.messages.map((message) => message.id)).toEqual(['r1']);
    expect(store.getState().channelMessages.general?.messages).toEqual([]);
  });

  it('ignores stale useChannel responses after the channel changes', async () => {
    const alpha = deferred<any>();
    const beta = deferred<any>();
    const get = vi.fn()
      .mockReturnValueOnce(alpha.promise)
      .mockReturnValueOnce(beta.promise);
    const { wrapper, store } = createWrapper({ channels: { get } });

    const { result, rerender } = renderHook(({ name }) => useChannel(name), {
      wrapper,
      initialProps: { name: 'alpha' },
    });

    rerender({ name: 'beta' });

    await act(async () => {
      beta.resolve({ name: 'beta', topic: null, members: [] });
      await beta.promise;
    });

    await waitFor(() => {
      expect(result.current.channel?.name).toBe('beta');
    });

    await act(async () => {
      alpha.resolve({ name: 'alpha', topic: null, members: [] });
      await alpha.promise;
    });

    expect(result.current.channel?.name).toBe('beta');
    expect(store.getState().channelDetails.alpha?.channel).toBeNull();
  });

  it('ignores stale useThread responses after the message id changes', async () => {
    const first = deferred<any>();
    const second = deferred<any>();
    const thread = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { wrapper, store } = createWrapper({ thread });

    const { result, rerender } = renderHook(({ messageId }) => useThread(messageId), {
      wrapper,
      initialProps: { messageId: 'm1' },
    });

    rerender({ messageId: 'm2' });

    await act(async () => {
      second.resolve({ parent: makeMessage('m2', '2026-01-01T00:00:02.000Z'), replies: [] });
      await second.promise;
    });

    await waitFor(() => {
      expect(result.current.parent?.id).toBe('m2');
    });

    await act(async () => {
      first.resolve({ parent: makeMessage('m1', '2026-01-01T00:00:01.000Z'), replies: [] });
      await first.promise;
    });

    expect(result.current.parent?.id).toBe('m2');
    expect(store.getState().threads.m1?.parent).toBeNull();
  });
});
