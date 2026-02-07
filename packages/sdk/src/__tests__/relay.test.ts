import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock global fetch once for this file.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockResponse(data: unknown, apiOk = true, status = 200) {
  return Promise.resolve({
    ok: true,
    status,
    json: () => Promise.resolve(apiOk ? { ok: true, data } : { ok: false, error: data }),
  });
}

describe('Relay', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.useRealTimers();
  });

  describe('workspace', () => {
    it('info() calls GET /v1/workspace', async () => {
      const { Relay } = await import('../relay.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ id: 'ws_1' }));
      await relay.workspace.info();

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.agentrelay.dev/v1/workspace');
      expect(init.method).toBe('GET');
      expect(init.headers.Authorization).toBe('Bearer rk_live_test123');
      expect(init.headers['X-SDK-Version']).toBeDefined();
    });

    it('update() calls PATCH /v1/workspace with JSON body', async () => {
      const { Relay } = await import('../relay.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ id: 'ws_1', name: 'new' }));
      await relay.workspace.update({ name: 'new' } as any);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.agentrelay.dev/v1/workspace');
      expect(init.method).toBe('PATCH');
      expect(init.headers['Content-Type']).toBe('application/json');
      expect(init.body).toBe(JSON.stringify({ name: 'new' }));
    });
  });

  describe('agents', () => {
    it('register() calls POST /v1/agents', async () => {
      const { Relay } = await import('../relay.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ ok: true }));
      await relay.agents.register({ name: 'Worker' } as any);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.agentrelay.dev/v1/agents');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'Worker' }));
    });

    it('list() calls GET /v1/agents', async () => {
      const { Relay } = await import('../relay.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.agents.list();

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.agentrelay.dev/v1/agents');
      expect(init.method).toBe('GET');
    });

    it('list() with status filter adds query params', async () => {
      const { Relay } = await import('../relay.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse([]));
      await relay.agents.list({ status: 'active' } as any);

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.agentrelay.dev/v1/agents?status=active');
    });

    it('get() calls GET /v1/agents/:name with URL encoding', async () => {
      const { Relay } = await import('../relay.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() => mockResponse({ name: 'a/b' }));
      await relay.agents.get('a/b');

      const [url] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://api.agentrelay.dev/v1/agents/a%2Fb');
    });
  });

  describe('error handling', () => {
    it('throws RelayError on API error', async () => {
      const { Relay } = await import('../relay.js');
      const { RelayError } = await import('../client.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'bad_request', message: 'Nope' }, false, 400),
      );

      await expect(relay.workspace.info()).rejects.toBeInstanceOf(RelayError);
      await expect(relay.workspace.info()).rejects.toMatchObject({
        code: 'bad_request',
        status: 400,
      });
    });

    it('retries on 5xx with exponential backoff (200ms, 400ms, 800ms)', async () => {
      vi.useFakeTimers();
      const { Relay } = await import('../relay.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

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
  });

  describe('as()', () => {
    it('returns an AgentClient that uses the agent token for Authorization', async () => {
      const { Relay } = await import('../relay.js');
      const { AgentClient } = await import('../agent.js');
      const relay = new Relay({ apiKey: 'rk_live_test123' });

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

