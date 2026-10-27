import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { RelayProvider } from '../provider.js';

const sdkMock = vi.hoisted(() => {
  const wsInstances: Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    emit(type: string): void;
  }> = [];

  class MockRelayCast {
    as = vi.fn(() => ({}));
  }

  class MockWsClient {
    connect = vi.fn();
    disconnect = vi.fn(() => {
      this.isConnected = false;
    });
    subscribe = vi.fn();
    unsubscribe = vi.fn();
    private handlers = new Map<string, Set<(event: { type: string }) => void>>();
    private isConnected = false;

    constructor() {
      wsInstances.push(this);
    }

    get connected(): boolean {
      return this.isConnected;
    }

    on(event: string, handler: (event: { type: string }) => void): () => void {
      if (!this.handlers.has(event)) {
        this.handlers.set(event, new Set());
      }
      this.handlers.get(event)!.add(handler);
      return () => {
        this.handlers.get(event)?.delete(handler);
      };
    }

    emit(type: string): void {
      if (type === 'open') {
        this.isConnected = true;
      }
      const event = { type };
      this.handlers.get(type)?.forEach((handler) => handler(event));
      this.handlers.get('*')?.forEach((handler) => handler(event));
    }
  }

  return { MockRelayCast, MockWsClient, wsInstances };
});

vi.mock('@relaycast/sdk', () => ({
  RelayCast: sdkMock.MockRelayCast,
  WsClient: sdkMock.MockWsClient,
}));

beforeEach(() => {
  sdkMock.wsInstances.length = 0;
  vi.clearAllMocks();
});

describe('RelayProvider', () => {
  it('does not reconnect when channels receives a new array with the same contents', async () => {
    const { rerender, unmount } = render(
      <RelayProvider apiKey="rk_live_test" agentToken="at_test" channels={['general']}>
        <div />
      </RelayProvider>,
    );

    await waitFor(() => {
      expect(sdkMock.wsInstances[0]?.connect).toHaveBeenCalledTimes(1);
    });

    act(() => {
      sdkMock.wsInstances[0]!.emit('open');
    });

    expect(sdkMock.wsInstances[0]!.subscribe).toHaveBeenCalledWith(['general']);

    rerender(
      <RelayProvider apiKey="rk_live_test" agentToken="at_test" channels={['general']}>
        <div />
      </RelayProvider>,
    );

    expect(sdkMock.wsInstances).toHaveLength(1);
    expect(sdkMock.wsInstances[0]!.connect).toHaveBeenCalledTimes(1);
    expect(sdkMock.wsInstances[0]!.disconnect).not.toHaveBeenCalled();
    expect(sdkMock.wsInstances[0]!.subscribe).toHaveBeenCalledTimes(1);

    unmount();
    expect(sdkMock.wsInstances[0]!.disconnect).toHaveBeenCalledTimes(1);
  });
});
