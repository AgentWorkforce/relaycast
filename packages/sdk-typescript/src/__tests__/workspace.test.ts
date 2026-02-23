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

describe('Relay workspace methods', () => {
  beforeEach(() => {
    mockFetch.mockReset();
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

  it('workspace.listAgents() calls GET /v1/agents', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.workspace.listAgents();

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/agents');
    expect(init.method).toBe('GET');
  });

  it('workspace.listChannels() supports includeArchived', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.workspace.listChannels({ includeArchived: true });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/channels?include_archived=true');
    expect(init.method).toBe('GET');
  });

  it('workspace.listChannelMessages() strips # and supports paging opts', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.workspace.listChannelMessages('#general', { limit: 25, before: 'msg_10' });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/channels/general/messages?limit=25&before=msg_10');
    expect(init.method).toBe('GET');
  });

  it('workspace.listDmConversations() supports local limit option', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse([
        { id: 'conv_1', type: '1:1', participants: ['Lead', 'Worker'], last_message: null, message_count: 12 },
        { id: 'conv_2', type: 'group', participants: ['Lead', 'W1', 'W2'], last_message: null, message_count: 3 },
      ]),
    );
    const conversations = await relay.workspace.listDmConversations({ limit: 1 });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/dm/conversations/all');
    expect(init.method).toBe('GET');
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.id).toBe('conv_1');
  });

  it('workspace.listDmMessages() calls workspace DM endpoint with opts', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.workspace.listDmMessages('conv_1', { limit: 50, after: 'msg_20' });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://api.relaycast.dev/v1/dm/conversations/conv_1/messages?limit=50&after=msg_20');
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
