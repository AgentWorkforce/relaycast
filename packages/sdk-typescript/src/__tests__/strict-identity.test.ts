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

describe('strict identity APIs', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe('registerAgent (strict: true)', () => {
    it('registers agent with exact name', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      const created = { id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' };
      mockFetch.mockImplementation(() => mockResponse(created));

      const result = await relay.registerAgent({ name: 'Bot', strict: true });
      expect(result).toEqual({ id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', createdAt: '2024-01-01' });
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agents');
      expect(init.method).toBe('POST');
      expect(init.body).toBe(JSON.stringify({ name: 'Bot' }));
    });

    it('throws RelayError with name_conflict code on conflict', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../errors.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'agent_already_exists', message: 'Agent already exists' }, false, 409),
      );

      const err = await relay.registerAgent({ name: 'Bot', strict: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayError);
      expect((err as any).code).toBe('name_conflict');
      expect((err as any).retryable).toBe(false);
      expect((err as any).statusCode).toBe(409);
    });

    it('does not include strict field in API request body', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      const created = { id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' };
      mockFetch.mockImplementation(() => mockResponse(created));

      await relay.registerAgent({ name: 'Bot', strict: true });

      const [, init] = mockFetch.mock.calls[0]!;
      const body = JSON.parse(init.body);
      expect(body).not.toHaveProperty('strict');
      expect(body).toEqual({ name: 'Bot' });
    });

    it('only makes a single API call (no suffix retry)', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'agent_already_exists', message: 'exists' }, false, 409),
      );

      await relay.registerAgent({ name: 'Bot', strict: true }).catch(() => {});
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerAgent (non-strict / default)', () => {
    it('fails closed without a suffixed-name retry on conflict', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../errors.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'agent_already_exists', message: 'exists' }, false, 409),
      );

      await expect(relay.registerAgent({ name: 'Bot' })).rejects.toBeInstanceOf(RelayError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('registerOrRotate', () => {
    it('returns register result when agent does not exist', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      const created = { id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' };
      mockFetch.mockImplementation(() => mockResponse(created));

      const result = await relay.registerOrRotate({ name: 'Bot' });
      expect(result).toEqual({ id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', createdAt: '2024-01-01' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('is a fail-closed compatibility alias on name conflict', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../errors.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'agent_already_exists', message: 'exists' }, false, 409),
      );

      await expect(relay.registerOrRotate({ name: 'Bot' })).rejects.toBeInstanceOf(RelayError);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('rethrows non-conflict errors', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../errors.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementation(() =>
        mockResponse({ code: 'unauthorized', message: 'bad token' }, false, 401),
      );

      const err = await relay.registerOrRotate({ name: 'Bot' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayError);
      expect((err as any).code).toBe('unauthorized');
    });
  });

  describe('resolveIdentity', () => {
    it('resolves identity after registerAgent', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      // Register agent first
      const created = { id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' };
      mockFetch.mockImplementationOnce(() => mockResponse(created));
      await relay.registerAgent({ name: 'Bot', strict: true });

      // resolveIdentity needs workspace info
      mockFetch.mockImplementationOnce(() => mockResponse({ id: 'ws_1', name: 'TestWS' }));

      const identity = await relay.resolveIdentity();
      expect(identity).toEqual({ agentId: 'a_1', name: 'Bot', workspaceId: 'ws_1' });
    });

    it('resolves identity after registerOrRotate', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      mockFetch.mockImplementationOnce(() => mockResponse({
        id: 'a_2', name: 'Worker', token: 'at_live_new', status: 'online', created_at: '2024-01-01',
      }));
      await relay.registerOrRotate({ name: 'Worker' });

      // resolveIdentity
      mockFetch.mockImplementationOnce(() => mockResponse({ id: 'ws_2', name: 'Workspace2' }));
      const identity = await relay.resolveIdentity();
      expect(identity).toEqual({ agentId: 'a_2', name: 'Worker', workspaceId: 'ws_2' });
    });

    it('throws when no identity has been registered', async () => {
      const { RelayCast } = await import('../relay.js');
      const { RelayError } = await import('../errors.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      const err = await relay.resolveIdentity().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RelayError);
      expect((err as any).code).toBe('not_found');
    });
  });

  describe('explicit recovery operations', () => {
    it('sends immutable id and recovery proof only to /recover', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse({
        agent_id: 'a_1', name: 'Bot', token: 'at_live_recovered', audit_id: 'aid_1',
      }));

      const result = await relay.agents.recover({
        name: 'Bot', expectedAgentId: 'a_1', recoveryProof: 'proof-secret', reason: 'restart',
      });
      expect(result).toMatchObject({ agentId: 'a_1', auditId: 'aid_1' });
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe('https://cast.agentrelay.com/v1/agents/Bot/recover');
      expect(JSON.parse(init.body)).toEqual({
        expected_agent_id: 'a_1', recovery_proof: 'proof-secret', reason: 'restart',
      });
    });

    it('uses separate audited owner takeover and immediate revoke operations', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });
      mockFetch.mockImplementation(() => mockResponse({
        agent_id: 'a_1', name: 'Bot', token: 'at_live_recovered', audit_id: 'aid_1',
      }));

      await relay.agents.takeOver({
        name: 'Bot', expectedAgentId: 'a_1', actor: 'owner', reason: 'lost proof',
        sessionRef: 'incident-1', nodeId: 'node-1',
      });
      await relay.agents.revokeToken({
        name: 'Bot', expectedAgentId: 'a_1', actor: 'owner', reason: 'compromise',
      });

      expect(mockFetch.mock.calls[0]![0]).toBe('https://cast.agentrelay.com/v1/agents/Bot/takeover');
      expect(mockFetch.mock.calls[1]![0]).toBe('https://cast.agentrelay.com/v1/agents/Bot/revoke-token');
    });
  });

  describe('agents.registerOrGet (deprecated delegate)', () => {
    it('delegates to registerOrRotate', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      const created = { id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' };
      mockFetch.mockImplementation(() => mockResponse(created));

      const result = await relay.agents.registerOrGet({ name: 'Bot' });
      expect(result).toEqual({ id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', createdAt: '2024-01-01' });
    });
  });

  describe('agents.registerAgent accessor', () => {
    it('delegates to top-level registerAgent', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      const created = { id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' };
      mockFetch.mockImplementation(() => mockResponse(created));

      const result = await relay.agents.registerAgent({ name: 'Bot', strict: true });
      expect(result.name).toBe('Bot');
    });
  });

  describe('agents.resolveIdentity accessor', () => {
    it('delegates to top-level resolveIdentity', async () => {
      const { RelayCast } = await import('../relay.js');
      const relay = new RelayCast({ apiKey: 'rk_live_test123' });

      // Register first
      const created = { id: 'a_1', name: 'Bot', token: 'at_live_new', status: 'online', created_at: '2024-01-01' };
      mockFetch.mockImplementationOnce(() => mockResponse(created));
      await relay.agents.register({ name: 'Bot' });

      // Resolve
      mockFetch.mockImplementationOnce(() => mockResponse({ id: 'ws_1', name: 'WS' }));
      const identity = await relay.agents.resolveIdentity();
      expect(identity.agentId).toBe('a_1');
    });
  });
});
