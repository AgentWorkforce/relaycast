// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_OBSERVER_MAX_RETRIES } from '../lib/connect-observer';

const relay = {
  allDmConversations: vi.fn(),
  dmMessagePage: vi.fn(),
};

vi.mock('@relaycast/react', () => ({ useRelay: () => relay, useEvent: () => undefined }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams('expires_at=2999-01-01T00:00:00Z') }));

const { ConnectObserverLayout } = await import('./ConnectObserverLayout');

const failure = (statusCode: number) => Object.assign(new Error(`HTTP ${statusCode}`), { statusCode });
const conversation = { id: 'dm_1', participants: ['alice', 'bob'] };
const message = { id: '100', agentName: 'alice', text: 'Canberra', createdAt: '2026-10-11T00:04:32Z' };

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('ConnectObserverLayout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    relay.allDmConversations.mockReset();
    relay.dmMessagePage.mockReset();
    relay.dmMessagePage.mockResolvedValue({ messages: [message], nextBefore: null, exhausted: true });
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
    relay.allDmConversations
      .mockRejectedValueOnce(Object.assign(failure(429), { retryAfterMs: 60_000 }))
      .mockResolvedValue([conversation]);
    render(<ConnectObserverLayout />);
    await flush();
    // The 15s poll ticks three times inside the server's 60s wait without reading.
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
    // Neither backoff nor the 15s live poll keeps hitting a busy workspace.
    await flush(5 * 60_000);
    expect(relay.allDmConversations).toHaveBeenCalledTimes(1 + CONNECT_OBSERVER_MAX_RETRIES);

    relay.allDmConversations.mockResolvedValue([conversation]);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await flush();
    expect(relay.allDmConversations).toHaveBeenCalledTimes(2 + CONNECT_OBSERVER_MAX_RETRIES);
    expect(screen.getByText('Canberra')).toBeTruthy();
  });

  it('keeps loaded history visible during a temporary failure', async () => {
    relay.allDmConversations.mockResolvedValueOnce([conversation]).mockRejectedValue(failure(429));
    render(<ConnectObserverLayout />);
    await flush();
    expect(screen.getByText('Canberra')).toBeTruthy();
    await flush(15_000);
    expect(screen.getByText('Canberra')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Agent Relay is busy');
    expect(screen.queryByText('Observer link unavailable')).toBeNull();
  });
});
