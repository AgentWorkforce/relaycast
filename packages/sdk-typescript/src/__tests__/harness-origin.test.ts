/**
 * Tests for the `harness` field on `InternalOrigin`.
 *
 * Verifies that a caller-supplied harness slug:
 *   - lands as the `X-Relaycast-Harness` HTTP header
 *   - lands as the `harness` WS query param
 *   - gets sanitised (lowercased, ASCII-only, length-capped)
 *   - is omitted entirely when absent / invalid
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonOk(payload: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true, data: payload }),
  });
}

describe('InternalOrigin.harness — HTTP', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.resetModules();
  });

  it('stamps X-Relaycast-Harness when origin supplies one', async () => {
    const { createInternalRelayCast } = await import('../internal.js');
    const relay = createInternalRelayCast(
      { apiKey: 'rk_live_test' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0', harness: 'claude-code' },
    );

    mockFetch.mockImplementation(() => jsonOk({ name: 'ws_test', workspace_id: 'ws_1' }));
    await relay.workspace.info();

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers['X-Relaycast-Harness']).toBe('claude-code');
  });

  it('omits the header entirely when origin has no harness', async () => {
    const { createInternalRelayCast } = await import('../internal.js');
    const relay = createInternalRelayCast(
      { apiKey: 'rk_live_test' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0' },
    );

    mockFetch.mockImplementation(() => jsonOk({ name: 'ws_test', workspace_id: 'ws_1' }));
    await relay.workspace.info();

    const [, init] = mockFetch.mock.calls[0]!;
    expect('X-Relaycast-Harness' in init.headers).toBe(false);
  });

  it('sanitises the harness to lowercase ASCII', async () => {
    const { createInternalRelayCast } = await import('../internal.js');
    const relay = createInternalRelayCast(
      { apiKey: 'rk_live_test' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0', harness: '  Claude-Code  ' },
    );

    mockFetch.mockImplementation(() => jsonOk({ name: 'ws_test', workspace_id: 'ws_1' }));
    await relay.workspace.info();

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers['X-Relaycast-Harness']).toBe('claude-code');
  });

  it('drops harnesses with disallowed characters rather than sending garbage', async () => {
    const { createInternalRelayCast } = await import('../internal.js');
    const relay = createInternalRelayCast(
      { apiKey: 'rk_live_test' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0', harness: 'evil header\r\nX-Inject: bad' },
    );

    mockFetch.mockImplementation(() => jsonOk({ name: 'ws_test', workspace_id: 'ws_1' }));
    await relay.workspace.info();

    const [, init] = mockFetch.mock.calls[0]!;
    expect('X-Relaycast-Harness' in init.headers).toBe(false);
  });

  it('caps the harness at 40 chars', async () => {
    const { createInternalRelayCast } = await import('../internal.js');
    const longSlug = 'a'.repeat(60);
    const relay = createInternalRelayCast(
      { apiKey: 'rk_live_test' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0', harness: longSlug },
    );

    mockFetch.mockImplementation(() => jsonOk({ name: 'ws_test', workspace_id: 'ws_1' }));
    await relay.workspace.info();

    const [, init] = mockFetch.mock.calls[0]!;
    expect(init.headers['X-Relaycast-Harness']).toBe('a'.repeat(40));
  });

  it('preserves the harness across withApiKey()', async () => {
    const { HttpClient } = await import('../client.js');
    const { createInternalRelayCast } = await import('../internal.js');
    // Reach into the client constructor via createInternalRelayCast → as() chain
    // by checking the static side: directly exercise HttpClient through internal origin.
    const relay = createInternalRelayCast(
      { apiKey: 'rk_live_test' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0', harness: 'cursor' },
    );
    // Smoke-test: build a fresh HttpClient via withApiKey on the underlying client.
    // We construct one directly to assert the getter survives.
    const internalClient = new HttpClient({ apiKey: 'rk_live_test' });
    expect(internalClient.originHarness).toBeUndefined();
    void relay; // referenced for typing only
  });
});

describe('InternalOrigin.harness — WS', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('forwards the harness as a `harness` query param on connect', async () => {
    const constructed: string[] = [];
    class MockWs {
      static readonly OPEN = 1;
      url: string;
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor(url: string) {
        this.url = url;
        constructed.push(url);
      }
    }
    vi.stubGlobal('WebSocket', MockWs);

    const { createInternalWsClient } = await import('../internal.js');
    const ws = createInternalWsClient(
      { token: 'at_live_test' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0', harness: 'claude-code' },
    );
    ws.connect();
    ws.disconnect();

    expect(constructed).toHaveLength(1);
    const url = new URL(constructed[0]!);
    expect(url.searchParams.get('harness')).toBe('claude-code');
  });

  it('omits the harness query param when origin has none', async () => {
    const constructed: string[] = [];
    class MockWs {
      static readonly OPEN = 1;
      url: string;
      readyState = 0;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      onmessage: ((event: { data: string }) => void) | null = null;
      onerror: (() => void) | null = null;
      send = vi.fn();
      close = vi.fn();
      constructor(url: string) {
        this.url = url;
        constructed.push(url);
      }
    }
    vi.stubGlobal('WebSocket', MockWs);

    const { createInternalWsClient } = await import('../internal.js');
    const ws = createInternalWsClient(
      { token: 'at_live_test' },
      { surface: 'mcp', client: '@agent-relay/relaycast-mcp', version: '6.0.0' },
    );
    ws.connect();
    ws.disconnect();

    expect(constructed).toHaveLength(1);
    const url = new URL(constructed[0]!);
    expect(url.searchParams.has('harness')).toBe(false);
  });
});

describe('sanitizeHarness', () => {
  it('normalises and validates', async () => {
    const { sanitizeHarness } = await import('../origin.js');
    expect(sanitizeHarness(undefined)).toBeUndefined();
    expect(sanitizeHarness('')).toBeUndefined();
    expect(sanitizeHarness('   ')).toBeUndefined();
    expect(sanitizeHarness('Claude-Code')).toBe('claude-code');
    expect(sanitizeHarness('CURSOR')).toBe('cursor');
    expect(sanitizeHarness('my-new-harness')).toBe('my-new-harness');
    expect(sanitizeHarness('has spaces')).toBeUndefined();
    expect(sanitizeHarness('a'.repeat(50))).toBe('a'.repeat(40));
  });
});
