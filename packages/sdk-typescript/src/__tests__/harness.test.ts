/**
 * Tests for the harness identifier sent to the relaycast server.
 *
 * A caller-supplied harness (public `harness` option or internal origin):
 *   - lands as the `X-Relaycast-Harness` HTTP header
 *   - lands as the `harness` WS query param
 *   - is sanitised (lowercased, length-capped) and accepts UA-style tokens
 *   - is omitted entirely when absent / invalid
 *   - survives `withApiKey()` rotations
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeHarness } from '../origin.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonOk(data: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true, data }),
  });
}

function harnessHeaderFromLastCall(): string | undefined {
  const [, init] = mockFetch.mock.calls.at(-1)!;
  return (init.headers as Record<string, string>)['X-Relaycast-Harness'];
}

describe('sanitizeHarness', () => {
  it('keeps a UA-style token, lowercased', () => {
    expect(sanitizeHarness('Claude-Code/2.3 (model=Opus-4.8; fast)')).toBe(
      'claude-code/2.3 (model=opus-4.8; fast)',
    );
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeHarness('  codex  ')).toBe('codex');
  });

  it('drops empty / whitespace-only input', () => {
    expect(sanitizeHarness('')).toBeUndefined();
    expect(sanitizeHarness('   ')).toBeUndefined();
    expect(sanitizeHarness(undefined)).toBeUndefined();
  });

  it('drops CRLF / control characters rather than sending garbage', () => {
    expect(sanitizeHarness('evil\r\nX-Inject: bad')).toBeUndefined();
    expect(sanitizeHarness('a\tb')).toBeUndefined();
  });

  it('caps at 120 characters', () => {
    expect(sanitizeHarness('a'.repeat(200))).toBe('a'.repeat(120));
  });
});

describe('harness — HTTP', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('stamps X-Relaycast-Harness from the public constructor option', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test', harness: 'human' });

    mockFetch.mockImplementation(() => jsonOk([]));
    await relay.activity();

    expect(harnessHeaderFromLastCall()).toBe('human');
  });

  it('stamps a UA-style harness from the internal origin', async () => {
    const { createInternalRelayCast } = await import('../internal.js');
    const relay = createInternalRelayCast(
      { apiKey: 'rk_live_test' },
      {
        surface: 'mcp',
        client: '@agent-relay/relaycast-mcp',
        version: '6.0.0',
        harness: 'claude-code/2.3 (model=opus-4.8)',
      },
    );

    mockFetch.mockImplementation(() => jsonOk([]));
    await relay.activity();

    expect(harnessHeaderFromLastCall()).toBe('claude-code/2.3 (model=opus-4.8)');
  });

  it('omits the header entirely when no harness is supplied', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test' });

    mockFetch.mockImplementation(() => jsonOk([]));
    await relay.activity();

    const [, init] = mockFetch.mock.calls.at(-1)!;
    expect('X-Relaycast-Harness' in (init.headers as Record<string, string>)).toBe(false);
  });

  it('drops an invalid harness (header omitted) rather than sending garbage', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test', harness: 'evil\r\nX-Inject: bad' });

    mockFetch.mockImplementation(() => jsonOk([]));
    await relay.activity();

    const [, init] = mockFetch.mock.calls.at(-1)!;
    expect('X-Relaycast-Harness' in (init.headers as Record<string, string>)).toBe(false);
  });

  it('preserves the harness across withApiKey()', async () => {
    const { HttpClient } = await import('../client.js');
    const client = new HttpClient({ apiKey: 'rk_live_test', harness: 'cursor' });
    const rotated = client.withApiKey('rk_live_other');

    expect(rotated.apiKey).toBe('rk_live_other');
    expect(rotated.originHarness).toBe('cursor');

    mockFetch.mockImplementation(() => jsonOk([]));
    await rotated.get('/v1/activity');
    expect(harnessHeaderFromLastCall()).toBe('cursor');
  });

  it('lets the internal origin override the public option', async () => {
    const { createInternalRelayCast } = await import('../internal.js');
    const relay = createInternalRelayCast(
      { apiKey: 'rk_live_test', harness: 'human' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0', harness: 'claude-code' },
    );

    mockFetch.mockImplementation(() => jsonOk([]));
    await relay.activity();

    expect(harnessHeaderFromLastCall()).toBe('claude-code');
  });
});

describe('harness — WS', () => {
  it('forwards the harness as a `harness` query param on connect', async () => {
    const constructed: string[] = [];
    class MockWs {
      static readonly OPEN = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor(url: string) {
        constructed.push(url);
      }
    }
    vi.stubGlobal('WebSocket', MockWs);

    const { WsClient } = await import('../ws.js');
    const ws = new WsClient({ token: 'at_live_test', harness: 'claude-code/2.3' });
    ws.connect();
    ws.disconnect();

    expect(constructed).toHaveLength(1);
    const url = new URL(constructed[0]!);
    expect(url.searchParams.get('harness')).toBe('claude-code/2.3');
  });

  it('omits the harness query param when none is supplied', async () => {
    const constructed: string[] = [];
    class MockWs {
      static readonly OPEN = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor(url: string) {
        constructed.push(url);
      }
    }
    vi.stubGlobal('WebSocket', MockWs);

    const { WsClient } = await import('../ws.js');
    const ws = new WsClient({ token: 'at_live_test' });
    ws.connect();
    ws.disconnect();

    const url = new URL(constructed[0]!);
    expect(url.searchParams.has('harness')).toBe(false);
  });
});
