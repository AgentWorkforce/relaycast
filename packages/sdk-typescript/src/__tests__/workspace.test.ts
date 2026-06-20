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

  it('workspace.fleetNodes.get() calls GET /v1/workspace/fleet-nodes', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ enabled: true, default_enabled: false, override: true }),
    );
    const result = await relay.workspace.fleetNodes.get();

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/workspace/fleet-nodes');
    expect(init.method).toBe('GET');
    expect(result).toEqual({ enabled: true, defaultEnabled: false, override: true });
  });

  it('workspace.fleetNodes.set() calls PUT /v1/workspace/fleet-nodes with enabled', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ enabled: true, default_enabled: false, override: true }),
    );
    await relay.workspace.fleetNodes.set(true);

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/workspace/fleet-nodes');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ enabled: true });
  });

  it('workspace.fleetNodes.inherit() calls PUT /v1/workspace/fleet-nodes with inherit mode', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ enabled: false, default_enabled: false, override: null }),
    );
    const result = await relay.workspace.fleetNodes.inherit();

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/workspace/fleet-nodes');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body as string)).toEqual({ mode: 'inherit' });
    expect(result).toEqual({ enabled: false, defaultEnabled: false, override: null });
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
    const result = await relay.agents.rotateToken('TestBot');

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/agents/TestBot/rotate-token');
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
    expect(url).toBe('https://cast.agentrelay.com/v1/agents/a%2Fb/rotate-token');
  });
});
