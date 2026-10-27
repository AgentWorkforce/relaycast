// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_OBSERVER_MAX_RETRIES } from '../lib/connect-observer';

Object.assign(globalThis, { React });

const relay = {
  allDmConversations: vi.fn(),
  dmMessagePage: vi.fn(),
};
const eventHandlers = new Map<string, (event: Record<string, unknown>) => void>();

vi.mock('@relaycast/react', () => ({
  useRelay: () => relay,
  useEvent: (eventType: string, handler: (event: Record<string, unknown>) => void) => {
    eventHandlers.set(eventType, handler);
  },
}));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('expires_at=2999-01-01T00:00:00Z'),
}));

const { ConnectObserverLayout } = await import('./ConnectObserverLayout');

const failure = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
const conversation = { id: 'dm_1', participants: ['alice', 'bob'] };
const message = {
  id: '100',
  agentName: 'alice',
  text: 'Canberra',
  createdAt: '2026-10-11T00:04:32Z',
};
const RECONCILIATION_INTERVAL_MS = 5 * 60_000;

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('ConnectObserverLayout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    eventHandlers.clear();
    relay.allDmConversations.mockReset();
    relay.dmMessagePage.mockReset();
    relay.dmMessagePage.mockResolvedValue({
      messages: [message],
      nextBefore: null,
      exhausted: true,
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  for (const status of [401, 403]) {
    it(`shows the revoked state for ${status} and does not retry`, async () => {
      relay.allDmConversations.mockRejectedValue(failure(status));
      render(<ConnectObserverLayout />);
      await flush();
      expect(screen.getByText('Observer link unavailable')).toBeTruthy();
      await flush(60_000);
      expect(relay.allDmConversations).toHaveBeenCalledTimes(1);
    });
  }

  for (const status of [429, 503]) {
    it(`shows a retrying state for ${status}, never the revoked one, and recovers`, async () => {
      relay.allDmConversations.mockRejectedValueOnce(failure(status)).mockResolvedValue([conversation]);
      render(<ConnectObserverLayout />);
      await flush();
      expect(screen.getByText('Observer temporarily unavailable')).toBeTruthy();
      expect(screen.getByText('Agent Relay is busy. Retrying automatically…')).toBeTruthy();
      expect(screen.queryByText('Observer link unavailable')).toBeNull();
      await flush(2_000);
      expect(relay.allDmConversations).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Canberra')).toBeTruthy();
    });
  }

  it('holds the live poll until a longer Retry-After retry runs', async () => {
    relay.allDmConversations.mockRejectedValueOnce(Object.assign(failure(429), { retryAfterMs: 60_000 })).mockResolvedValue([conversation]);
    render(<ConnectObserverLayout />);
    await flush();
    // No reconciliation or retry runs before the server's 60s wait.
    await flush(59_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1);
    await flush(1_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Canberra')).toBeTruthy();
  });

  it('stops after the retry budget, stays paused, and retries again only on request', async () => {
    relay.allDmConversations.mockRejectedValue(failure(503));
    render(<ConnectObserverLayout />);
    await flush();
    // 2s + 4s + 8s + 16s + 30s of backoff spends the budget.
    await flush(60_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1 + CONNECT_OBSERVER_MAX_RETRIES);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
    // Neither backoff nor reconciliation keeps hitting a busy workspace.
    await flush(5 * 60_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1 + CONNECT_OBSERVER_MAX_RETRIES);

    relay.allDmConversations.mockResolvedValue([conversation]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(relay.allDmConversations).toHaveBeenCalledTimes(2 + CONNECT_OBSERVER_MAX_RETRIES);
    expect(screen.getByText('Canberra')).toBeTruthy();
  });

  it('does not schedule a retry for a read that fails after unmount', async () => {
    let failRead!: (error: Error) => void;
    relay.allDmConversations.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          failRead = reject;
        }),
    );
    render(<ConnectObserverLayout />);
    await flush();
    cleanup();
    failRead(failure(503));
    await flush(10 * 60_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1);
  });

  it('skips a conversation the observer can no longer see, and keeps the link and other conversations', async () => {
    const gone = { id: 'dm_2', participants: ['carol', 'dave'] };
    relay.allDmConversations.mockResolvedValue([conversation, gone]);
    relay.dmMessagePage.mockImplementation(async (conversationId: string) => {
      if (conversationId === 'dm_2')
        throw Object.assign(failure(404), {
          rawCode: 'dm_conversation_not_found',
        });
      return { messages: [message], nextBefore: null, exhausted: true };
    });
    render(<ConnectObserverLayout />);
    await flush();
    expect(screen.getByText('Canberra')).toBeTruthy();
    expect(screen.queryByText('Observer link unavailable')).toBeNull();
    // Still observing: periodic reconciliation keeps reading.
    await flush(RECONCILIATION_INTERVAL_MS);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(2);
  });

  it('keeps loaded history visible during a temporary failure', async () => {
    relay.allDmConversations.mockResolvedValueOnce([conversation]).mockRejectedValue(failure(429));
    render(<ConnectObserverLayout />);
    await flush();
    expect(screen.getByText('Canberra')).toBeTruthy();
    await flush(RECONCILIATION_INTERVAL_MS);
    expect(screen.getByText('Canberra')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Agent Relay is busy');
    expect(screen.queryByText('Observer link unavailable')).toBeNull();
  });

  for (const eventType of ['dm.received', 'group_dm.received']) {
    it(`fetches only ${eventType} conversation messages after the cached cursor`, async () => {
      const liveMessage = {
        id: '101',
        agentName: 'bob',
        text: 'Darwin',
        createdAt: '2026-10-11T00:04:33Z',
      };
      relay.allDmConversations.mockResolvedValue([conversation]);
      relay.dmMessagePage
        .mockResolvedValueOnce({
          messages: [message],
          nextBefore: null,
          exhausted: true,
        })
        .mockResolvedValueOnce({
          messages: [liveMessage],
          nextBefore: null,
          exhausted: true,
        });
      render(<ConnectObserverLayout />);
      await flush();

      await act(async () => {
        eventHandlers.get(eventType)?.({
          type: eventType,
          conversationId: conversation.id,
        });
        await Promise.resolve();
      });

      expect(relay.allDmConversations).toHaveBeenCalledTimes(1);
      expect(relay.dmMessagePage).toHaveBeenCalledTimes(2);
      expect(relay.dmMessagePage).toHaveBeenLastCalledWith(conversation.id, {
        limit: 100,
        after: message.id,
      });
      expect(screen.getByText('Darwin')).toBeTruthy();
    });
  }

  it('retries an incremental event read without reloading the conversation list', async () => {
    const liveMessage = {
      id: '101',
      agentName: 'bob',
      text: 'Darwin',
      createdAt: '2026-10-11T00:04:33Z',
    };
    relay.allDmConversations.mockResolvedValue([conversation]);
    relay.dmMessagePage
      .mockResolvedValueOnce({
        messages: [message],
        nextBefore: null,
        exhausted: true,
      })
      .mockRejectedValueOnce(failure(503))
      .mockResolvedValueOnce({
        messages: [liveMessage],
        nextBefore: null,
        exhausted: true,
      });
    render(<ConnectObserverLayout />);
    await flush();

    await act(async () => {
      eventHandlers.get('dm.received')?.({
        type: 'dm.received',
        conversationId: conversation.id,
      });
      await Promise.resolve();
    });
    expect(screen.getByRole('status').textContent).toContain('Agent Relay is busy');

    await flush(2_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1);
    expect(relay.dmMessagePage).toHaveBeenLastCalledWith(conversation.id, {
      limit: 100,
      after: message.id,
    });
    expect(screen.getByText('Darwin')).toBeTruthy();
  });

  it('keeps a due reconciliation queued behind an incremental read', async () => {
    let finishIncrementalRead!: (page: { messages: (typeof message)[]; nextBefore: null; exhausted: true }) => void;
    relay.allDmConversations.mockResolvedValue([conversation]);
    relay.dmMessagePage
      .mockResolvedValueOnce({
        messages: [message],
        nextBefore: null,
        exhausted: true,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishIncrementalRead = resolve;
          }),
      )
      .mockResolvedValue({ messages: [], nextBefore: null, exhausted: true });
    render(<ConnectObserverLayout />);
    await flush();

    await act(async () => {
      eventHandlers.get('dm.received')?.({
        type: 'dm.received',
        conversationId: conversation.id,
      });
      await Promise.resolve();
    });
    await flush(RECONCILIATION_INTERVAL_MS);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishIncrementalRead({ messages: [], nextBefore: null, exhausted: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(relay.allDmConversations).toHaveBeenCalledTimes(2);
  });

  it('does not reconcile on a 15-second tick and eventually reconciles after five minutes', async () => {
    relay.allDmConversations.mockResolvedValue([conversation]);
    render(<ConnectObserverLayout />);
    await flush();
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1);

    await flush(15_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1);

    await flush(RECONCILIATION_INTERVAL_MS - 15_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(2);
    expect(relay.dmMessagePage).toHaveBeenLastCalledWith(conversation.id, {
      limit: 100,
      after: message.id,
    });
  });
});
