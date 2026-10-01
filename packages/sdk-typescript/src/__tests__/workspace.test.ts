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
    expect(url).toBe('https://cast.agentrelay.com/v1/activity');
  });

  it('activity(5) calls GET /v1/activity?limit=5', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.activity(5);

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/activity?limit=5');
  });

  it('allDmConversations() calls GET /v1/dm/conversations/all', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([]));
    await relay.allDmConversations();

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/dm/conversations/all');
    expect(init.method).toBe('GET');
  });

  it('dmMessages() camelizes DM message fields', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() => mockResponse([{
      id: 'msg_1',
      agent_id: 'a_1',
      agent_name: 'Alice',
      text: 'hello',
      created_at: '2025-01-01T00:00:00.000Z',
    }]));
    const result = await relay.dmMessages('c_1', { limit: 10, before: 'msg_9' });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/dm/conversations/c_1/messages?limit=10&before=msg_9');
    expect(init.method).toBe('GET');
    expect(result[0]).toEqual({
      id: 'msg_1',
      agentId: 'a_1',
      agentName: 'Alice',
      text: 'hello',
      createdAt: '2025-01-01T00:00:00.000Z',
    });
  });

  it('agents.rotateToken() calls POST /v1/agents/:name/rotate-token', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ token: 'at_live_newtoken' }),
    );
    const result = await relay.agents.rotateToken('TestBot', 'at_live_current');

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/agents/TestBot/rotate-token');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer at_live_current');
    expect(result).toEqual({ token: 'at_live_newtoken' });
  });

  it('agents.rotateToken() URL-encodes the agent name', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ token: 'at_live_tok' }),
    );
    await relay.agents.rotateToken('a/b', 'at_live_current');

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/agents/a%2Fb/rotate-token');
  });
});
