import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: unknown, apiOk = true, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    json: () => Promise.resolve(apiOk ? { ok: true, data } : { ok: false, error: data }),
  });
}

describe('Relay dashboard methods', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('stats() calls GET /v1/workspace/stats', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ agents: 5, channels: 3, messages: 100, dm_conversations: 2, files: 1 }),
    );
    const result = await relay.stats();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/workspace/stats');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer rk_live_test123');
    expect(result).toEqual({ agents: 5, channels: 3, messages: 100, dm_conversations: 2, files: 1 });
  });

  it('activity() calls GET /v1/activity without params', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.activity();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/activity');
  });

  it('activity(5) calls GET /v1/activity?limit=5', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.activity(5);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/activity?limit=5');
  });

  it('allDmConversations() calls GET /v1/dm/conversations/all', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.allDmConversations();

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/dm/conversations/all');
    expect(init.method).toBe('GET');
  });

  it('agents.rotateToken() calls POST /v1/agents/:name/rotate-token', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ token: 'at_live_newtoken' }),
    );
    const result = await relay.agents.rotateToken('TestBot');

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/agents/TestBot/rotate-token');
    expect(init.method).toBe('POST');
    expect(result).toEqual({ token: 'at_live_newtoken' });
  });

  it('agents.rotateToken() URL-encodes the agent name', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ token: 'at_live_tok' }),
    );
    await relay.agents.rotateToken('a/b');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/agents/a%2Fb/rotate-token');
  });
});
