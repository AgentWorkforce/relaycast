import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock global fetch once for this file.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: unknown, apiOk = true, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(apiOk ? { ok: true, data } : { ok: false, error: data }),
  });
}

describe('RelayCast', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  describe('workspace', () => {
    it('info() calls GET /v1/workspace', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ id: 'ws_1' }));
      await relay.workspace.info();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspace');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer rk_live_test123');
      expect(init.headers['X-SDK-Version']).toBeDefined();
      expect(init.headers['X-Relaycast-Origin-Surface']).toBe('sdk');
      expect(init.headers['X-Relaycast-Origin-Client']).toBe('@relaycast/sdk');
      expect(init.headers['X-Relaycast-Origin-Version']).toBeDefined();
    });

    it('update() calls PATCH /v1/workspace with JSON body', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ id: 'ws_1', name: 'new' }));
      await relay.workspace.update({ name: 'new' } as any);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspace');
      expect(init.method).toBe('PATCH');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ name: 'new' }));
    });

    it('ignores user-supplied origin metadata and keeps sdk defaults', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({
        apiKey: 'rk_live_test123',
        origin: { surface: 'mcp', client: '@relaycast/mcp', version: '0.1.2' },
      } as any);

      mockFetch.mockImplementation(() => mockResponse({ id: 'ws_1' }));
      await relay.workspace.info();

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers['X-Relaycast-Origin-Surface']).toBe('sdk');
      expect(init.headers['X-Relaycast-Origin-Client']).toBe('@relaycast/sdk');
      expect(init.headers['X-Relaycast-Origin-Version']).toBeDefined();
    });

    it('stream.get() maps default_enabled to defaultEnabled', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ enabled: true, default_enabled: false, override: null }),
      );
      const result = await relay.workspace.stream.get();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspace/stream');
      expect(init.method).toBe('GET');
      expect(result).toEqual({ enabled: true, defaultEnabled: false, override: null });
    });

    it('stream.set() maps default_enabled to defaultEnabled', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ enabled: false, default_enabled: false, override: true }),
      );
      const result = await relay.workspace.stream.set(false);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspace/stream');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ enabled: false }));
      expect(result).toEqual({ enabled: false, defaultEnabled: false, override: true });
    });

    it('stream.inherit() maps default_enabled to defaultEnabled', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ enabled: true, default_enabled: true, override: null }),
      );
      const result = await relay.workspace.stream.inherit();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspace/stream');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ mode: 'inherit' }));
      expect(result).toEqual({ enabled: true, defaultEnabled: true, override: null });
    });
  });

  describe('agents', () => {
    it('register() calls POST /v1/agents', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ ok: true }));
      await relay.agents.register({ name: 'Worker' } as any);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/agents');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'Worker' }));
    });

    it('list() calls GET /v1/agents', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.agents.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/agents');
      expect(init.method).toBe('GET');
    });

    it('list() with status filter adds query params', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.agents.list({ status: 'active' } as any);

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/agents?status=active');
    });

    it('get() calls GET /v1/agents/:name with URL encoding', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ name: 'a/b' }));
      await relay.agents.get('a/b');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/agents/a%2Fb');
    });
  });

  describe('error handling', () => {
    it('throws RelayError on API error', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../client.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'bad_request', message: 'Nope' }, false, 400),
      );

      await expect(relay.workspace.info()).rejects.toBeInstanceOf(RelayError);
      await expect(relay.workspace.info()).rejects.toMatchObject({
        code: 'bad_request',
        status: 400,
      });
    });

    it('retries on configured 5xx policy with deterministic backoff', async () => {
      vi.useFakeTimers();
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({
        apiKey: 'rk_live_test123',
        retryPolicy: {
          maxRetries: 3,
          backoffMs: 200,
          backoffMultiplier: 2,
          jitter: false,
          retryOn: [500, 502, 503],
        },
      });

      mockFetch
        .mockImplementationOnce(() => mockResponse({ code: 'e', message: 'x' }, false, 500))
        .mockImplementationOnce(() => mockResponse({ code: 'e', message: 'x' }, false, 502))
        .mockImplementationOnce(() => mockResponse({ code: 'e', message: 'x' }, false, 503))
        .mockImplementationOnce(() => mockResponse({ id: 'ws_1' }, true, 200));

      const promise = relay.workspace.info();

      // 3 retries -> 3 sleeps.
      await vi.advanceTimersByTimeAsync(200);
      await vi.advanceTimersByTimeAsync(400);
      await vi.advanceTimersByTimeAsync(800);

      await expect(promise).resolves.toEqual({ id: 'ws_1' });
      expect(mockFetch).toHaveBeenCalledTimes(4);
    });

    it('uses Retry-After for 429 responses', async () => {
      vi.useFakeTimers();
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({
        apiKey: 'rk_live_test123',
        retryPolicy: {
          maxRetries: 1,
          backoffMs: 25,
          backoffMultiplier: 1,
          jitter: false,
          retryOn: [429],
        },
      });

      mockFetch
        .mockImplementationOnce(() =>
          Promise.resolve({
            ok: false,
            status: 429,
            headers: new Headers({ 'Retry-After': '2' }),
            json: () =>
              Promise.resolve({
                ok: false,
                error: { code: 'rate_limited', message: 'slow down' },
              }),
          }),
        )
        .mockImplementationOnce(() => mockResponse({ id: 'ws_1' }, true, 200));

      const promise = relay.workspace.info();

      await vi.advanceTimersByTimeAsync(1999);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(promise).resolves.toEqual({ id: 'ws_1' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('accepts retry policy overrides via RelayCast constructor options', async () => {
      vi.useFakeTimers();
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({
        apiKey: 'rk_live_test123',
        retryPolicy: {
          maxRetries: 1,
          backoffMs: 10,
          backoffMultiplier: 1,
          jitter: false,
          retryOn: [418],
        },
      });

      mockFetch
        .mockImplementationOnce(() => mockResponse({ code: 'teapot', message: 'brew' }, false, 418))
        .mockImplementationOnce(() => mockResponse({ id: 'ws_1' }, true, 200));

      const promise = relay.workspace.info();

      await vi.advanceTimersByTimeAsync(10);
      await expect(promise).resolves.toEqual({ id: 'ws_1' });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('workspace.delete', () => {
    it('delete() calls DELETE /v1/workspace', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(undefined) }),
      );
      await relay.workspace.delete();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspace');
      expect(init.method).toBe('DELETE');
    });
  });

  describe('systemPrompt', () => {
    it('get() calls GET /v1/workspace/system-prompt', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ prompt: 'Be helpful', is_default: false }),
      );
      const result = await relay.systemPrompt.get();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspace/system-prompt');
      expect(init.method).toBe('GET');
      expect(result).toEqual({ prompt: 'Be helpful', isDefault: false });
    });

    it('set() calls PUT /v1/workspace/system-prompt', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ prompt: 'New prompt', is_default: false }),
      );
      await relay.systemPrompt.set({ prompt: 'New prompt' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspace/system-prompt');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({ prompt: 'New prompt' }));
    });
  });

  describe('agents.update', () => {
    it('update() calls PATCH /v1/agents/:name', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ name: 'Bot', status: 'online' }));
      await relay.agents.update('Bot', { status: 'online' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/agents/Bot');
      expect(init.method).toBe('PATCH');
      expect(init.body).toBe(JSON.stringify({ status: 'online' }));
    });
  });

  describe('agents.delete', () => {
    it('delete() calls DELETE /v1/agents/:name', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(undefined) }),
      );
      await relay.agents.delete('Bot');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/agents/Bot');
      expect(init.method).toBe('DELETE');
    });
  });

  describe('agents.presence', () => {
    it('presence() calls GET /v1/agents/presence', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      const rawData = [{ agent_id: 'a_1', agent_name: 'Bot', status: 'online' }];
      mockFetch.mockImplementation(() => mockResponse(rawData));
      const result = await relay.agents.presence();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/agents/presence');
      expect(init.method).toBe('GET');
      expect(result).toEqual([{ agentId: 'a_1', agentName: 'Bot', status: 'online' }]);
    });
  });

  describe('RelayCast.createWorkspace', () => {
    it('calls POST /v1/workspaces without auth', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_1', api_key: 'rk_live_new', created_at: '2024-01-01' },
            }),
        }),
      );

      const result = await RelayCast.createWorkspace('My Workspace');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/workspaces');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'My Workspace' }));
      expect(init.headers.Authorization).toBeUndefined();
      expect(init.headers['X-Relaycast-Origin-Surface']).toBe('sdk');
      expect(init.headers['X-Relaycast-Origin-Client']).toBe('@relaycast/sdk');
      expect(init.headers['X-Relaycast-Origin-Version']).toBeDefined();
      expect(result.workspaceId).toBe('ws_1');
    });

    it('uses custom baseUrl', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_1', api_key: 'rk_live_new', created_at: '2024-01-01' },
            }),
        }),
      );

      await RelayCast.createWorkspace('Test', 'http://localhost:3000');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('http://localhost:3000/v1/workspaces');
    });

    it('throws RelayError on failure', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../client.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 409,
          json: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'workspace_exists', message: 'Already exists' },
            }),
        }),
      );

      await expect(RelayCast.createWorkspace('Dup')).rejects.toBeInstanceOf(RelayError);
    });
  });

  describe('agents.registerOrGet', () => {
    it('returns register result when agent does not exist', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      const created = { id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' };
      mockFetch.mockImplementation(() => mockResponse(created));

      const result = await relay.agents.registerOrGet({ name: 'Bot' });
      expect(result).toEqual({ id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', createdAt: '2024-01-01' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('falls back to get + rotateToken on agent_already_exists', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch
        .mockImplementationOnce(() =>
          mockResponse({ code: 'agent_already_exists', message: 'exists' }, false, 409),
        )
        .mockImplementationOnce(() =>
          mockResponse({ id: 'a_1', name: 'Bot', status: 'online', created_at: '2024-01-01' }),
        )
        .mockImplementationOnce(() =>
          mockResponse({ token: 'at_live_rotated' }),
        );

      const result = await relay.agents.registerOrGet({ name: 'Bot' });
      expect(result.token).toBe('at_live_rotated');
      expect(result.name).toBe('Bot');
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });

    it('rethrows non-conflict errors', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../client.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'internal_error', message: 'boom' }, false, 400),
      );

      await expect(relay.agents.registerOrGet({ name: 'Bot' })).rejects.toBeInstanceOf(RelayError);
    });
  });

  describe('channels', () => {
    it('list() calls GET /v1/channels', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.channels.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels');
      expect(init.method).toBe('GET');
    });

    it('list() with includeArchived adds query param', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.channels.list({ includeArchived: true });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels?include_archived=true');
    });

    it('get() calls GET /v1/channels/:name', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ name: 'general', members: [] }));
      await relay.channels.get('general');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/general');
      expect(init.method).toBe('GET');
    });
  });

  describe('dmMessages', () => {
    it('maps snake_case response fields to camelCase', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse([
          {
            id: 'm_1',
            agent_id: 'a_1',
            agent_name: 'Bot',
            text: 'hello',
            created_at: '2026-02-20T00:00:00.000Z',
          },
        ]),
      );
      const result = await relay.dmMessages('conv_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/dm/conversations/conv_1/messages');
      expect(init.method).toBe('GET');
      expect(result).toEqual([
        {
          id: 'm_1',
          agentId: 'a_1',
          agentName: 'Bot',
          text: 'hello',
          createdAt: '2026-02-20T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('messages', () => {
    it('list() calls GET /v1/channels/:name/messages', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.messages.list('general');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/general/messages');
      expect(init.method).toBe('GET');
    });

    it('list() with opts adds query params', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.messages.list('general', { limit: 50 });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/general/messages?limit=50');
    });

    it('list() strips # prefix from channel name', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.messages.list('#general');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/channels/general/messages');
    });

    it('get() calls GET /v1/messages/:id', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ id: 'msg_1' }));
      await relay.messages.get('msg_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/msg_1');
      expect(init.method).toBe('GET');
    });

    it('thread() calls GET /v1/messages/:id/replies', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ parent: {}, replies: [] }));
      await relay.messages.thread('msg_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/msg_1/replies');
      expect(init.method).toBe('GET');
    });

    it('thread() with opts adds query params', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ parent: {}, replies: [] }));
      await relay.messages.thread('msg_1', { limit: 20 });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/msg_1/replies?limit=20');
    });

    it('reactions() calls GET /v1/messages/:id/reactions', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.messages.reactions('msg_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.relaycast.dev/v1/messages/msg_1/reactions');
      expect(init.method).toBe('GET');
    });
  });

  describe('as()', () => {
    it('returns an AgentClient that uses the agent token for Authorization', async () => {
      const { RelayCast } = await import('../relay.js');
      const { AgentClient } = await import('../agent.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ ok: true }));
      const agentClient = relay.as('at_live_agent123');

      expect(agentClient).toBeInstanceOf(AgentClient);
      // Trigger a request via the scoped client.
      await (agentClient as any).client.get('/v1/workspace');

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers.Authorization).toBe('Bearer at_live_agent123');
    });
  });
});
