import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock global fetch once for this file.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

class MockWebSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  url: string;
  readyState = MockWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = MockWebSocket.CLOSED;
  });

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }
}

vi.stubGlobal('WebSocket', MockWebSocket);

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
    MockWebSocket.instances = [];
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires apiKey', async () => {
    const { RelayCast } = await import('../relay.js');
    expect(() => new RelayCast({} as any)).toThrow('RelayCast apiKey is required');
  });

  it('must-fire: reports a failed session query as unknown, never retained', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({
      apiKey: 'rk_live_test123',
      retryPolicy: { maxRetries: 0 },
    });
    mockFetch.mockImplementation(() => mockResponse(
      { code: 'internal_error', message: 'query failed' },
      false,
      503,
    ));

    const result = await relay.messages.bySessionRef('session-1');

    expect(result.availability).toBe('unknown');
    expect(result.availability).not.toBe('retained');
    expect(result.messages).toEqual([]);
  });

  it('must-fire: treats retained availability with an unknown boundary as unknown', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });
    mockFetch.mockImplementation(() => mockResponse({
      session_ref: 'session-1',
      availability: 'retained',
      retention: {
        policy: 'unknown',
        message_ttl_days: null,
        retained_since: null,
        source: 'unknown',
        reason: 'boundary_unavailable',
      },
      session_started_at: '2026-08-18T00:00:00.000Z',
      session_last_message_at: '2026-08-18T00:01:00.000Z',
      messages: [],
      page: { next_cursor: null, has_more: false },
    }));

    const result = await relay.messages.bySessionRef('session-1');

    expect(result.availability).toBe('unknown');
    expect(result.availability).not.toBe('retained');
    expect(result.reason).toBe('response_invalid');
  });

  it('must-not-fire: resolves a retained session with bounded cursor options', async () => {
    const { RelayCast } = await import('../relay.js');
    const relay = new RelayCast({ apiKey: 'rk_live_test123' });
    mockFetch.mockImplementation(() => mockResponse({
      session_ref: 'session/one',
      availability: 'retained',
      retention: {
        policy: 'window',
        message_ttl_days: 30,
        retained_since: '2026-07-19T00:00:00.000Z',
        source: 'workspace_override',
      },
      session_started_at: '2026-08-18T00:00:00.000Z',
      session_last_message_at: '2026-08-18T00:01:00.000Z',
      messages: [{
        id: '2',
        channel_id: '1',
        channel_name: 'general',
        conversation_id: null,
        agent_id: '3',
        agent_name: 'writer',
        thread_id: null,
        text: 'hello',
        blocks: null,
        metadata: { session_ref: 'session/one' },
        has_attachments: false,
        created_at: '2026-08-18T00:00:00.000Z',
      }],
      page: { next_cursor: null, has_more: false },
    }));

    const result = await relay.messages.bySessionRef('session/one', {
      limit: 10,
      after: '1',
    });

    const requested = new URL(String(mockFetch.mock.calls[0]?.[0]));
    expect(requested.pathname).toBe('/v1/sessions/session%2Fone/messages');
    expect(requested.searchParams.get('limit')).toBe('10');
    expect(requested.searchParams.get('after')).toBe('1');
    expect(result).toMatchObject({
      sessionRef: 'session/one',
      availability: 'retained',
      retention: { messageTtlDays: 30, retainedSince: expect.any(String) },
      messages: [{ channelId: '1', metadata: { session_ref: 'session/one' } }],
      page: { nextCursor: null, hasMore: false },
    });
  });

  describe('workspace realtime', () => {
    it('connect() opens /v1/ws with an observer token and SDK origin metadata', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({
        apiKey: 'ot_live_test123',
        baseUrl: 'http://localhost:8080',
        ws: {
          token: 'ot_live_wrong',
          baseUrl: 'https://wrong.example',
        } as any,
      });

      relay.connect();

      expect(MockWebSocket.instances).toHaveLength(1);
      const url = new URL(MockWebSocket.instances[0]!.url);
      expect(url.origin).toBe('ws://localhost:8080');
      expect(url.pathname).toBe('/v1/ws');
      expect(url.searchParams.get('token')).toBe('ot_live_test123');
      expect(url.searchParams.get('origin_client')).toBe('@relaycast/sdk');
      expect(url.searchParams.get('origin_version')).toBeDefined();
      expect(mockFetch).not.toHaveBeenCalled();

      relay.disconnect();
    });

    it('connect() is idempotent and disconnect() allows a fresh workspace socket with existing handlers', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'ot_live_test123' });
      const handler = vi.fn();
      relay.on.messageCreated(handler);

      relay.connect();
      relay.connect();
      expect(MockWebSocket.instances).toHaveLength(1);

      const ws1 = MockWebSocket.instances[0]!;
      relay.disconnect();
      expect(ws1.close).toHaveBeenCalled();

      relay.connect();
      expect(MockWebSocket.instances).toHaveLength(2);
      const ws2 = MockWebSocket.instances[1]!;
      ws2.simulateOpen();
      ws2.simulateMessage({
        type: 'message.created',
        channel: 'general',
        message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
      });
      expect(handler).toHaveBeenCalledTimes(1);

      relay.disconnect();
    });

    it('on.messageCreated fires with camelized workspace stream events', async () => {
      vi.useFakeTimers();
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'ot_live_test123' });
      const handler = vi.fn();
      relay.on.messageCreated(handler);

      relay.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.simulateOpen();

      ws.simulateMessage({
        type: 'message.created',
        channel: 'general',
        message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'message.created',
          channel: 'general',
          message: expect.objectContaining({ agentName: 'Bot' }),
        }),
      );

      relay.disconnect();
    });

    it('connect() restarts the workspace stream after permanent disconnection', async () => {
      vi.useFakeTimers();
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({
        apiKey: 'ot_live_test123',
        ws: { maxReconnectAttempts: 0, reconnectJitter: false },
      });
      const permanentlyDisconnected = vi.fn();
      relay.on.permanentlyDisconnected(permanentlyDisconnected);

      relay.connect();
      const ws1 = MockWebSocket.instances[0]!;
      ws1.simulateOpen();
      ws1.simulateClose();

      expect(permanentlyDisconnected).toHaveBeenCalledWith(0);

      relay.connect();
      expect(MockWebSocket.instances).toHaveLength(2);

      relay.disconnect();
    });

    it('on.actionCompleted fires with camelized action completion events', async () => {
      vi.useFakeTimers();
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'ot_live_test123' });
      relay.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.simulateOpen();

      const handler = vi.fn();
      relay.on.actionCompleted(handler);

      ws.simulateMessage({
        type: 'action.completed',
        invocation_id: 'inv_1',
        action_name: 'deploy',
        status: 'completed',
        output: { ok: true },
        error: null,
      });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'action.completed',
          invocationId: 'inv_1',
          actionName: 'deploy',
        }),
      );

      relay.disconnect();
    });

    it('on.any returns an unsubscribe function for workspace events', async () => {
      vi.useFakeTimers();
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'ot_live_test123' });
      relay.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.simulateOpen();

      const handler = vi.fn();
      const unsubscribe = relay.on.any(handler);

      ws.simulateMessage({ type: 'pong' });
      expect(handler).toHaveBeenCalledTimes(1);

      unsubscribe();
      ws.simulateMessage({ type: 'pong' });
      expect(handler).toHaveBeenCalledTimes(1);

      relay.disconnect();
    });

    it('on.reconnecting exposes the reconnect attempt number', async () => {
      vi.useFakeTimers();
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({
        apiKey: 'ot_live_test123',
        ws: { reconnectJitter: false },
      });
      relay.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.simulateOpen();

      const handler = vi.fn();
      relay.on.reconnecting(handler);

      ws.simulateClose();
      expect(handler).toHaveBeenCalledWith(1);

      relay.disconnect();
    });

    it('allows registering event handlers before connect()', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'ot_live_test123' });
      const handler = vi.fn();

      expect(() => relay.on.messageCreated(handler)).not.toThrow();

      relay.connect();
      const ws = MockWebSocket.instances[0]!;
      ws.simulateOpen();
      ws.simulateMessage({
        type: 'message.created',
        channel: 'general',
        message: { id: 'm_1', agent_name: 'Bot', text: 'hi', attachments: [] },
      });
      expect(handler).toHaveBeenCalledTimes(1);

      relay.disconnect();
    });
  });

  describe('workspace', () => {
    it('info() calls GET /v1/workspace', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ id: 'ws_1' }));
      await relay.workspace.info();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/workspace');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer rk_live_test123');
      expect(init.headers['X-SDK-Version']).toBeDefined();
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
      expect(url).toBe('https://cast.agentrelay.com/v1/workspace');
      expect(init.method).toBe('PATCH');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ name: 'new' }));
    });

    it('ignores user-supplied origin metadata and keeps sdk defaults', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({
        apiKey: 'rk_live_test123',
        origin: { client: '@relaycast/mcp', version: '0.1.2' },
      } as any);

      mockFetch.mockImplementation(() => mockResponse({ id: 'ws_1' }));
      await relay.workspace.info();

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers['X-Relaycast-Origin-Client']).toBe('@relaycast/sdk');
      expect(init.headers['X-Relaycast-Origin-Version']).toBeDefined();
    });

  });

  describe('observerTokens', () => {
    it('create() calls POST /v1/observer-tokens with snake_case filters', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({
        id: 'ot_1',
        name: 'dash',
        token: 'ot_live_secret',
        scopes: ['stream:read'],
        filters: { channel_names: ['general'], include_dms: false },
        status: 'active',
        description: null,
        expires_at: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: null,
        revoked_at: null,
        last_used_at: null,
      }));

      const result = await relay.observerTokens.create({
        name: 'dash',
        scopes: ['stream:read'],
        filters: { channelNames: ['general'], includeDms: false },
      });

      expect(result.token).toBe('ot_live_secret');
      expect(result.filters.channelNames).toEqual(['general']);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/observer-tokens');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({
        name: 'dash',
        scopes: ['stream:read'],
        filters: { channel_names: ['general'], include_dms: false },
      }));
    });

    it('list/get/update/rotate/revoke call observer token endpoints', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse({ id: 'ot_1' }));

      await relay.observerTokens.list();
      await relay.observerTokens.get('ot_1');
      await relay.observerTokens.update('ot_1', { scopes: ['messages:read'] });
      await relay.observerTokens.rotate('ot_1');
      mockFetch.mockImplementationOnce(() => mockResponse(undefined, true, 204));
      await relay.observerTokens.revoke('ot_1');

      expect(mockFetch.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
        ['https://cast.agentrelay.com/v1/observer-tokens', 'GET'],
        ['https://cast.agentrelay.com/v1/observer-tokens/ot_1', 'GET'],
        ['https://cast.agentrelay.com/v1/observer-tokens/ot_1', 'PATCH'],
        ['https://cast.agentrelay.com/v1/observer-tokens/ot_1/rotate', 'POST'],
        ['https://cast.agentrelay.com/v1/observer-tokens/ot_1', 'DELETE'],
      ]);
    });
  });

  describe('agents', () => {
    it('register() calls POST /v1/agents', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ ok: true }));
      await relay.agents.register({ name: 'Worker' } as any);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agents');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'Worker' }));
    });

    it('system() registers a system identity', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ ok: true }));
      await relay.system({ name: 'System' } as any);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agents');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'System', type: 'system' }));
    });

    it('list() calls GET /v1/agents', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.agents.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agents');
      expect(init.method).toBe('GET');
    });

    it('list() with status filter adds query params', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.agents.list({ status: 'active' } as any);

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agents?status=active');
    });

    it('get() calls GET /v1/agents/:name with URL encoding', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ name: 'a/b' }));
      await relay.agents.get('a/b');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agents/a%2Fb');
    });
  });

  describe('a2a', () => {
    it('registerA2a() calls POST /v1/a2a/register with JSON body', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({
        relay_name: 'ext-weather-123',
        relay_token: 'rt_test',
        webhook_url: 'https://cast.agentrelay.com/a2a/webhook/ext-weather-123',
        certification: 'level_1',
      }));

      const result = await relay.registerA2a({
        agentCardUrl: 'https://agent.example/.well-known/agent-card.json',
        authScheme: 'bearer',
        authCredential: 'secret',
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/a2a/register');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({
        agent_card_url: 'https://agent.example/.well-known/agent-card.json',
        auth_scheme: 'bearer',
        auth_credential: 'secret',
      }));
      expect(result).toEqual({
        relayName: 'ext-weather-123',
        relayToken: 'rt_test',
        webhookUrl: 'https://cast.agentrelay.com/a2a/webhook/ext-weather-123',
        certification: 'level_1',
      });
    });

    it('listA2aAgents() calls GET /v1/a2a/agents', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.listA2aAgents();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/a2a/agents');
      expect(init.method).toBe('GET');
    });

    it('removeA2aAgent() calls DELETE /v1/a2a/agents/:name and returns removal payload', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ name: 'a/b', removed: true }));
      const result = await relay.removeA2aAgent('a/b');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/a2a/agents/a%2Fb');
      expect(init.method).toBe('DELETE');
      expect(result).toEqual({ name: 'a/b', removed: true });
    });

    it('getA2aAgentCard() calls GET /v1/a2a/agents/:name/card and returns envelope-wrapped card', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve({
            ok: true,
            data: {
              name: 'Weather Agent',
              url: 'https://agent.example',
              version: '1.0.0',
              skills: [{ name: 'forecast_lookup' }],
              default_input_modes: ['text/plain'],
              default_output_modes: ['text/plain'],
            },
          }),
        }));

      const result = await relay.getA2aAgentCard('a/b');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/a2a/agents/a%2Fb/card');
      expect(init.method).toBe('GET');
      expect(result).toEqual({
        name: 'Weather Agent',
        url: 'https://agent.example',
        version: '1.0.0',
        skills: [{ name: 'forecast_lookup' }],
        defaultInputModes: ['text/plain'],
        defaultOutputModes: ['text/plain'],
      });
    });
  });

  describe('directory and routing', () => {
    it('route() calls POST /v1/route with JSON body', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({
        agent_name: 'router',
        score: 0.98,
        fallback: false,
      }));

      const result = await relay.route('refund_lookup', 'Need a refund decision');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/route');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({
        skill: 'refund_lookup',
        message: 'Need a refund decision',
      }));
      expect(result).toEqual({
        agentName: 'router',
        score: 0.98,
        fallback: false,
      });
    });

    it('searchDirectory() calls GET /v1/directory/search with serialized query params', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.searchDirectory({
        q: 'refund',
        tags: ['billing', 'priority'],
        status: 'active',
        limit: 5,
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/directory/search?q=refund&tags=billing%2Cpriority&status=active&limit=5');
      expect(init.method).toBe('GET');
    });

    it('publishToDirectory() calls POST /v1/directory/agents with snake_case body', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({
        id: 'dir_1',
        source_agent_id: 'agent_1',
        slug: 'billing-router',
        name: 'Billing Router',
        description: 'Routes billing work',
        provider: 'relaycast',
        endpoint_url: 'https://agent.example',
        documentation_url: 'https://docs.example',
        version: '1.0.0',
        tags: ['billing'],
        capabilities: { handoff: true },
        metadata: { team: 'payments' },
        status: 'active',
        rating_avg: 4.5,
        rating_count: 2,
        skills: [],
        created_at: '2026-03-24T00:00:00.000Z',
        updated_at: '2026-03-24T00:00:00.000Z',
      }));

      const result = await relay.publishToDirectory({
        sourceAgentName: 'billing-router',
        name: 'Billing Router',
        endpointUrl: 'https://agent.example',
        documentationUrl: 'https://docs.example',
        skills: [{ name: 'refund_lookup', tags: ['billing'] }],
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/directory/agents');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({
        source_agent_name: 'billing-router',
        name: 'Billing Router',
        endpoint_url: 'https://agent.example',
        documentation_url: 'https://docs.example',
        skills: [{ name: 'refund_lookup', tags: ['billing'] }],
      }));
      expect(result.sourceAgentId).toBe('agent_1');
      expect(result.endpointUrl).toBe('https://agent.example');
      expect(result.documentationUrl).toBe('https://docs.example');
      expect(result.ratingAvg).toBe(4.5);
    });

    it('importSkills() calls POST /v1/skills/sync with snake_case body', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse(null));
      const result = await relay.importSkills({
        agentName: 'billing-router',
        status: 'active',
        metadata: { provider: 'relaycast' },
        skills: [{ name: 'refund_lookup' }],
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/skills/sync');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({
        agent_name: 'billing-router',
        status: 'active',
        metadata: { provider: 'relaycast' },
        skills: [{ name: 'refund_lookup' }],
      }));
      expect(result).toBeNull();
    });

    it('getRoutingConfig() calls GET /v1/routing/config and camelizes response', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({
        weights: {
          skill_match: 0.45,
          message_match: 0.2,
          tag_match: 0.15,
          rating: 0.1,
          availability: 0.1,
        },
        circuit_breaker_threshold: 3,
        circuit_breaker_cooldown_seconds: 300,
        updated_at: '2026-03-24T00:00:00.000Z',
      }));

      const result = await relay.getRoutingConfig();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/routing/config');
      expect(init.method).toBe('GET');
      expect(result).toEqual({
        weights: {
          skillMatch: 0.45,
          messageMatch: 0.2,
          tagMatch: 0.15,
          rating: 0.1,
          availability: 0.1,
        },
        circuitBreakerThreshold: 3,
        circuitBreakerCooldownSeconds: 300,
        updatedAt: '2026-03-24T00:00:00.000Z',
      });
    });

    it('updateRoutingConfig() calls PUT /v1/routing/config with snake_case body', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({
        weights: {
          skill_match: 0.5,
          message_match: 0.2,
          tag_match: 0.1,
          rating: 0.1,
          availability: 0.1,
        },
        circuit_breaker_threshold: 4,
        circuit_breaker_cooldown_seconds: 600,
        updated_at: '2026-03-24T00:00:00.000Z',
      }));

      const result = await relay.updateRoutingConfig({
        weights: { skillMatch: 0.5, tagMatch: 0.1 },
        circuitBreakerThreshold: 4,
        circuitBreakerCooldownSeconds: 600,
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/routing/config');
      expect(init.method).toBe('PUT');
      expect(init.body).toBe(JSON.stringify({
        weights: {
          skill_match: 0.5,
          tag_match: 0.1,
        },
        circuit_breaker_threshold: 4,
        circuit_breaker_cooldown_seconds: 600,
      }));
      expect(result.weights.skillMatch).toBe(0.5);
      expect(result.circuitBreakerThreshold).toBe(4);
      expect(result.circuitBreakerCooldownSeconds).toBe(600);
    });
  });

  describe('error handling', () => {
    it('throws RelayError on API error', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../client.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'unauthorized', message: 'Nope' }, false, 401),
      );

      await expect(relay.workspace.info()).rejects.toBeInstanceOf(RelayError);
      await expect(relay.workspace.info()).rejects.toMatchObject({
        code: 'unauthorized',
        retryable: false,
        statusCode: 401,
        status: 401,
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
    it('delete() keeps using the legacy workspace endpoint', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementationOnce(() =>
        Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(undefined) }),
      );
      await relay.workspace.delete();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/workspace');
      expect(init.method).toBe('DELETE');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('delete(id) skips workspace lookup', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() =>
        Promise.resolve({ ok: true, status: 204, json: () => Promise.resolve(undefined) }),
      );

      await relay.workspace.delete('ws/explicit');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/workspaces/ws%2Fexplicit');
      expect(init.method).toBe('DELETE');
      expect(mockFetch).toHaveBeenCalledTimes(1);
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
      expect(url).toBe('https://cast.agentrelay.com/v1/workspace/system-prompt');
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
      expect(url).toBe('https://cast.agentrelay.com/v1/workspace/system-prompt');
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
      expect(url).toBe('https://cast.agentrelay.com/v1/agents/Bot');
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
      expect(url).toBe('https://cast.agentrelay.com/v1/agents/Bot');
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
      expect(url).toBe('https://cast.agentrelay.com/v1/agents/presence');
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
          status: 201,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_1', api_key: 'rk_live_new', created_at: '2024-01-01' },
            }),
        }),
      );

      const result = await RelayCast.createWorkspace('My Workspace');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/workspaces');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'My Workspace', provenance: { source: 'sdk' } }));
      expect(init.headers.Authorization).toBeUndefined();
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

    it('forwards an explicit expiry and returns the deadline', async () => {
      const { RelayCast } = await import('../relay.js');
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({
            ok: true,
            data: {
              workspace_id: 'ws_ephemeral',
              api_key: 'rk_live_ephemeral',
              created_at: '2024-01-01',
              expires_at: '2024-01-01T01:00:00.000Z',
            },
          }),
        }),
      );

      const result = await RelayCast.createWorkspace('CI Run', {
        expiresInSeconds: 3_600,
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.body).toBe(JSON.stringify({
        name: 'CI Run',
        expires_in_seconds: 3_600,
        provenance: { source: 'sdk' },
      }));
      expect(result.expiresAt).toBe('2024-01-01T01:00:00.000Z');
    });

    it('forwards the owner-scoped idempotency key for delegated creates', async () => {
      const { RelayCast } = await import('../relay.js');
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({
            ok: true,
            data: { workspace_id: 'ws_child', api_key: 'rk_live_child', created_at: '2024-01-01' },
          }),
        }),
      );

      await RelayCast.createWorkspace('child', {
        apiKey: 'rk_live_parent',
        idempotencyKey: 'cloud-job-371',
        baseUrl: 'http://localhost:3000',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers.Authorization).toBe('Bearer rk_live_parent');
      expect(init.headers['Idempotency-Key']).toBe('cloud-job-371');
    });

    it('forwards explicit creation provenance', async () => {
      const { RelayCast } = await import('../relay.js');
      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () => Promise.resolve({
            ok: true,
            data: { workspace_id: 'ws_ci', api_key: 'rk_live_ci', created_at: '2024-01-01' },
          }),
        }),
      );

      await RelayCast.createWorkspace('CI', {
        provenance: { source: 'ci', originId: 'github:AgentWorkforce/relay/actions/runs/123', classification: 'internal' },
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(JSON.parse(init.body)).toEqual({
        name: 'CI',
        provenance: { source: 'ci', origin_id: 'github:AgentWorkforce/relay/actions/runs/123', classification: 'internal' },
      });
    });

    it('sends Agent Relay distinct id when supplied', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_1', api_key: 'rk_live_new', created_at: '2024-01-01' },
            }),
        }),
      );

      await RelayCast.createWorkspace('Test', {
        baseUrl: 'http://localhost:3000',
        agentRelayDistinctId: 'abc123def4567890',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers['X-Agent-Relay-Distinct-Id']).toBe('abc123def4567890');
    });

    it('forwards the cloud user and org identity headers', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_1', api_key: 'rk_live_new', created_at: '2024-01-01' },
            }),
        }),
      );

      await RelayCast.createWorkspace('Test', {
        baseUrl: 'http://localhost:3000',
        agentRelayUserId: 'usr_abc123',
        agentRelayOrgId: 'org_xyz789',
        agentRelayOrgSlug: 'agentworkforce',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers['X-Agent-Relay-User-Id']).toBe('usr_abc123');
      expect(init.headers['X-Agent-Relay-Org-Id']).toBe('org_xyz789');
      expect(init.headers['X-Agent-Relay-Org-Slug']).toBe('agentworkforce');
      // A signed-in user id doubles as the distinct id so callers need only one.
      expect(init.headers['X-Agent-Relay-Distinct-Id']).toBe('usr_abc123');
    });

    it('drops a malformed user id rather than forwarding it', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_1', api_key: 'rk_live_new', created_at: '2024-01-01' },
            }),
        }),
      );

      await RelayCast.createWorkspace('Test', {
        baseUrl: 'http://localhost:3000',
        agentRelayUserId: 'usr\r\nX-Inject: bad',
      });

      const [, init] = mockFetch.mock.calls[0]!;
      expect(init.headers['X-Agent-Relay-User-Id']).toBeUndefined();
      expect(init.headers['X-Agent-Relay-Distinct-Id']).toBeUndefined();
    });

    it('returns an existing workspace on idempotent duplicate create', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_existing', created_at: '2024-01-02' },
            }),
        }),
      );

      await expect(
        RelayCast.createWorkspace('Dup', { apiKey: 'rk_live_existing', baseUrl: 'http://localhost:3000' }),
      ).resolves.toEqual({
        workspaceId: 'ws_existing',
        createdAt: '2024-01-02',
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('http://localhost:3000/v1/workspaces');
      expect(init.headers.Authorization).toBe('Bearer rk_live_existing');
    });
  });

  describe('RelayCast.lookupWorkspace', () => {
    it('calls GET /v1/workspaces/by-name/:name without auth', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { id: 'ws_1', name: 'My Workspace', created_at: '2024-01-01' },
            }),
        }),
      );

      const result = await RelayCast.lookupWorkspace('My Workspace');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/workspaces/by-name/My%20Workspace');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBeUndefined();
      expect(result).toEqual({ id: 'ws_1', name: 'My Workspace', createdAt: '2024-01-01' });
    });

    it('returns null on 404', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () =>
            Promise.resolve({
              ok: false,
              error: { code: 'workspace_not_found', message: 'Missing' },
            }),
        }),
      );

      await expect(RelayCast.lookupWorkspace('Missing')).resolves.toBeNull();
    });

    it('sends Agent Relay distinct id when supplied', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { id: 'ws_1', name: 'My Workspace', created_at: '2024-01-01' },
            }),
        }),
      );

      await RelayCast.lookupWorkspace('My Workspace', {
        baseUrl: 'http://localhost:3000',
        agentRelayDistinctId: 'abc123def4567890',
      });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('http://localhost:3000/v1/workspaces/by-name/My%20Workspace');
      expect(init.headers['X-Agent-Relay-Distinct-Id']).toBe('abc123def4567890');
    });
  });

  describe('RelayCast.ensureWorkspace', () => {
    it('returns a created workspace when the name is available', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_1', api_key: 'rk_live_new', created_at: '2024-01-01' },
            }),
        }),
      );

      const result = await RelayCast.ensureWorkspace('Fresh Workspace');
      expect(result).toEqual({
        existed: false,
        name: 'Fresh Workspace',
        workspaceId: 'ws_1',
        apiKey: 'rk_live_new',
        createdAt: '2024-01-01',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns the existing workspace when create is idempotent', async () => {
      const { RelayCast } = await import('../relay.js');

      mockFetch.mockImplementation(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              ok: true,
              data: { workspace_id: 'ws_existing', created_at: '2024-01-02' },
            }),
        }),
      );

      const result = await RelayCast.ensureWorkspace('Taken Workspace', {
        apiKey: 'rk_live_existing',
        baseUrl: 'http://localhost:3000',
      });
      expect(result).toEqual({
        existed: true,
        name: 'Taken Workspace',
        workspaceId: 'ws_existing',
        createdAt: '2024-01-02',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0]?.[1]?.headers.Authorization).toBe('Bearer rk_live_existing');
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

    it('fails closed on agent_already_exists', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../client.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'agent_already_exists', message: 'exists' }, false, 409),
      );

      await expect(relay.agents.registerOrGet({ name: 'Bot' })).rejects.toBeInstanceOf(RelayError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
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

  describe('agents strict identity', () => {
    it('registerAgent({ strict: true }) registers without suffix fallback', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' }),
      );

      const result = await relay.agents.registerAgent({ name: 'Bot', strict: true });
      expect(result).toMatchObject({ id: 'a_1', name: 'Bot', token: 'at_live_new' });

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agents');
      expect(init.body).toBe(JSON.stringify({ name: 'Bot' }));
    });

    it('registerAgent({ strict: true }) throws name_conflict on collision', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'agent_already_exists', message: 'exists' }, false, 409),
      );

      await expect(relay.agents.registerAgent({ name: 'Bot', strict: true })).rejects.toMatchObject({
        code: 'name_conflict',
        retryable: false,
        statusCode: 409,
      });
    });

    it('resolveIdentity() returns { agentId, name, workspaceId } after register/rotate', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch
        .mockImplementationOnce(() =>
          mockResponse({ id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' }),
        )
        .mockImplementationOnce(() =>
          mockResponse({ id: 'ws_1', name: 'Workspace', metadata: {}, created_at: '2024-01-01' }),
        );

      await relay.agents.registerOrRotate({ name: 'Bot' });
      const identity = await relay.agents.resolveIdentity();

      expect(identity).toEqual({
        agentId: 'a_1',
        name: 'Bot',
        workspaceId: 'ws_1',
      });

      const [workspaceUrl] = mockFetch.mock.calls[1]!;
      expect(workspaceUrl).toBe('https://cast.agentrelay.com/v1/workspace');
    });
  });

  describe('channels', () => {
    it('list() calls GET /v1/channels', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.channels.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/channels');
      expect(init.method).toBe('GET');
    });

    it('list() with includeArchived adds query param', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.channels.list({ includeArchived: true });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/channels?include_archived=true');
    });

    it('get() calls GET /v1/channels/:name', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ name: 'general', members: [] }));
      await relay.channels.get('general');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/channels/general');
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
      expect(url).toBe('https://cast.agentrelay.com/v1/dm/conversations/conv_1/messages');
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
      expect(url).toBe('https://cast.agentrelay.com/v1/channels/general/messages');
      expect(init.method).toBe('GET');
    });

    it('list() with opts adds query params', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.messages.list('general', { limit: 50 });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/channels/general/messages?limit=50');
    });

    it('list() strips # prefix from channel name', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.messages.list('#general');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/channels/general/messages');
    });

    it('get() calls GET /v1/messages/:id', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ id: 'msg_1' }));
      await relay.messages.get('msg_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/messages/msg_1');
      expect(init.method).toBe('GET');
    });

    it('thread() calls GET /v1/messages/:id/replies', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ parent: {}, replies: [] }));
      await relay.messages.thread('msg_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/messages/msg_1/replies');
      expect(init.method).toBe('GET');
    });

    it('thread() with opts adds query params', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ parent: {}, replies: [] }));
      await relay.messages.thread('msg_1', { limit: 20 });

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/messages/msg_1/replies?limit=20');
    });

    it('reactions() calls GET /v1/messages/:id/reactions', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.messages.reactions('msg_1');

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/messages/msg_1/reactions');
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

    it('reconnect() resolves the authenticated agent before returning an AgentClient', async () => {
      const { RelayCast } = await import('../relay.js');
      const { AgentClient } = await import('../agent.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({
          id: 'agent_1',
          name: 'Worker',
          type: 'agent',
          status: 'online',
          persona: null,
          metadata: {},
          last_seen: '2025-01-01',
          channels: [],
        }),
      );
      const agentClient = await relay.reconnect({ apiToken: 'at_live_agent123' });

      expect(agentClient).toBeInstanceOf(AgentClient);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agent');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer at_live_agent123');
    });
  });
});
