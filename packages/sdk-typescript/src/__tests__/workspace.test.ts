import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(
  data: unknown,
  apiOk = true,
  status = 200,
  cursor?: { next: string | null; has_more: boolean },
) {
  return Promise.resolve({
    ok: true,
    status,
    json: () => Promise.resolve(apiOk ? { ok: true, data, ...(cursor ? { cursor } : {}) } : { ok: false, error: data }),
  });
}

describe('Relay workspace methods', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each(['create', 'ensure'])('%s forwards workspace metadata verbatim', async (method) => {
    const { RelayCast } = await import('../relay.js');
    const metadata = { project_id: 'p1', nested: { camelKey: true }, list: [null, 4] };
    mockFetch.mockImplementation(() => mockResponse({
      workspace_id: 'ws_1', api_key: 'rk_live_test', created_at: '2026-10-01',
    }));
    const create = method === 'create' ? RelayCast.createWorkspace : RelayCast.ensureWorkspace;
    await create('Test', { metadata });
    expect(JSON.parse(mockFetch.mock.calls[0]![1].body).metadata).toEqual(metadata);
  });

  it('workspace.info and update preserve metadata and null deletion values', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });
    const metadata = { project_id: 'p1', nested: { camelKey: true }, retained_key: [false, 3] };
    const mergedMetadata = { nested: { snake_key: null }, retained_key: [false, 3] };
    const workspace = { id: 'ws_1', name: 'Test', created_at: '2026-10-01' };
    mockFetch
      .mockImplementationOnce(() => mockResponse({ ...workspace, metadata }))
      .mockImplementationOnce(() => mockResponse({ ...workspace, metadata: mergedMetadata }));
    const loaded = await relay.workspace.info();
    expect(mockFetch.mock.calls[0]![1].method).toBe('GET');
    expect(loaded.metadata).toEqual(metadata);
    const updated = await relay.workspace.update({
      metadata: { nested: { snake_key: null }, project_id: null },
    });
    expect(mockFetch.mock.calls[1]![1].method).toBe('PATCH');
    expect(updated.metadata).toEqual(mergedMetadata);
    expect(updated.metadata).not.toHaveProperty('project_id');
    expect(JSON.parse(mockFetch.mock.calls[1]![1].body)).toEqual({
      metadata: { nested: { snake_key: null }, project_id: null },
    });
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

  it('allDmConversations() uses bounded pages and aggregates the legacy full result', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });

    const first = [{
      id: 'dm_1', channel_id: 'channel_1', type: 'dm', participants: ['alice', 'bob'],
      last_message: null, message_count: 1,
    }];
    const second = [{
      id: 'dm_2', channel_id: 'channel_2', type: 'dm', participants: ['alice', 'carol'],
      last_message: null, message_count: 1,
    }];
    mockFetch
      .mockImplementationOnce(() => mockResponse(first, true, 200, { next: 'dm_1', has_more: true }))
      .mockImplementationOnce(() => mockResponse(second, true, 200, { next: null, has_more: false }));
    await expect(relay.allDmConversations()).resolves.toEqual([
      {
        id: 'dm_1', channelId: 'channel_1', type: 'dm', participants: ['alice', 'bob'],
        lastMessage: null, messageCount: 1,
      },
      {
        id: 'dm_2', channelId: 'channel_2', type: 'dm', participants: ['alice', 'carol'],
        lastMessage: null, messageCount: 1,
      },
    ]);

    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual([
      'https://cast.agentrelay.com/v1/dm/conversations/all?limit=90',
      'https://cast.agentrelay.com/v1/dm/conversations/all?limit=90&cursor=dm_1',
    ]);
    expect(mockFetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });

  it('allDmConversations() rejects a repeated pagination cursor', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });
    mockFetch.mockImplementation(() => (
      mockResponse([], true, 200, { next: 'dm_repeat', has_more: true })
    ));

    await expect(relay.allDmConversations()).rejects.toThrow('pagination did not advance');
    expect(mockFetch).toHaveBeenCalledTimes(2);
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

  it('dmMessagePage() returns the raw-page cursor used for filtered pagination', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'ot_live_test123' });

    mockFetch.mockImplementation(() =>
      mockResponse({ messages: [], next_before: 'msg_100', exhausted: false }),
    );
    await expect(relay.dmMessagePage('c_1', { limit: 100 })).resolves.toEqual({
      messages: [],
      nextBefore: 'msg_100',
      exhausted: false,
    });

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://cast.agentrelay.com/v1/dm/conversations/c_1/messages?page=1&limit=100');
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
