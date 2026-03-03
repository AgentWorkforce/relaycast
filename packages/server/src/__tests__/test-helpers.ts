/**
 * Test helpers for Hono-based route testing.
 *
 * Instead of supertest + Express app, tests use the Hono app directly:
 *   const res = await app.request('/v1/channels', { method: 'POST', ... });
 *
 * Auth is handled by mocking the `getDb` return to feed fake workspace/agent
 * to the auth middleware, same pattern as before but without supertest.
 */
import crypto from 'node:crypto';
import { vi } from 'vitest';

export function generateApiKey(): { key: string; hash: string } {
  const key = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return { key, hash };
}

export function generateAgentToken(): { token: string; hash: string } {
  const token = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hash };
}

// Pre-generated test credentials
const { key: _apiKey, hash: _apiKeyHash } = generateApiKey();
const { token: _agentToken, hash: _agentTokenHash } = generateAgentToken();

export const TEST_API_KEY = _apiKey;
export const TEST_API_KEY_HASH = _apiKeyHash;
export const TEST_AGENT_TOKEN = _agentToken;
export const TEST_AGENT_TOKEN_HASH = _agentTokenHash;

export const FAKE_ORGANIZATION = {
  id: 'org_123',
  name: 'test-org',
  plan: 'free',
  orgApiKeyHash: null,
  createdAt: new Date(),
};

export const FAKE_WORKSPACE = {
  id: 'ws_123',
  name: 'test-workspace',
  apiKeyHash: TEST_API_KEY_HASH,
  systemPrompt: null,
  plan: 'free' as const,
  organizationId: 'org_123',
  createdAt: new Date(),
  metadata: {},
};

export const FAKE_AGENT = {
  id: 'agent_123',
  workspaceId: 'ws_123',
  name: 'TestBot',
  type: 'agent',
  tokenHash: TEST_AGENT_TOKEN_HASH,
  status: 'online',
  persona: null,
  metadata: {},
  createdAt: new Date(),
  lastSeen: new Date(),
};

/**
 * Create a mock KV namespace for testing.
 */
export function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
    list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
    getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
  } as unknown as KVNamespace;
}

/**
 * Create a mock DB that returns the fake workspace for workspace-key auth.
 */
export function mockDbForWorkspaceAuth() {
  let callCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          // Auth middleware queries: 1=workspace, 2=organization
          if (callCount % 2 === 1) return Promise.resolve([FAKE_WORKSPACE]);
          return Promise.resolve([FAKE_ORGANIZATION]);
        }),
      }),
    }),
    insert: () => ({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: () => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    delete: () => ({
      where: vi.fn().mockResolvedValue([]),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;
}

/**
 * Create a mock DB that returns the fake agent + workspace for agent-token auth.
 */
export function mockDbForAgentAuth() {
  let callCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: vi.fn().mockImplementation(() => {
          callCount++;
          // Auth middleware queries: 1=agent, 2=workspace, 3=organization, then repeats
          const phase = ((callCount - 1) % 3) + 1;
          if (phase === 1) return Promise.resolve([FAKE_AGENT]);
          if (phase === 2) return Promise.resolve([FAKE_WORKSPACE]);
          return Promise.resolve([FAKE_ORGANIZATION]);
        }),
      }),
    }),
    insert: () => ({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: () => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
    delete: () => ({
      where: vi.fn().mockResolvedValue([]),
    }),
    execute: vi.fn().mockResolvedValue({ rows: [] }),
  } as any;
}

/**
 * Standard mock bindings for Cloudflare Worker env.
 */
export function createMockBindings() {
  const doStub = {
    fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  };
  const rateLimitStub = {
    fetch: vi.fn().mockResolvedValue(Response.json({
      ok: true,
      data: { count: 1, limit: 60, remaining: 59, allowed: true },
    })),
  };
  const presenceStub = {
    fetch: vi.fn().mockImplementation(async () => new Response(JSON.stringify({ agents: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })),
  };

  return {
    DB: {} as D1Database,
    FILES_BUCKET: {} as R2Bucket,
    WEBHOOK_QUEUE: { send: vi.fn() } as unknown as Queue,
    NOTIFICATION_QUEUE: { send: vi.fn() } as unknown as Queue,
    CHANNEL_DO: { idFromName: vi.fn(() => 'channel-do'), get: vi.fn(() => doStub) } as unknown as DurableObjectNamespace,
    AGENT_DO: { idFromName: vi.fn(() => 'agent-do'), get: vi.fn(() => doStub) } as unknown as DurableObjectNamespace,
    PRESENCE_DO: { idFromName: vi.fn(() => 'presence-do'), get: vi.fn(() => presenceStub) } as unknown as DurableObjectNamespace,
    WORKSPACE_STREAM_DO: { idFromName: vi.fn(() => 'workspace-stream-do'), get: vi.fn(() => doStub) } as unknown as DurableObjectNamespace,
    MCP_SESSION_DO: { idFromName: vi.fn(() => 'mcp-do'), get: vi.fn(() => doStub) } as unknown as DurableObjectNamespace,
    RATE_LIMIT_DO: { idFromName: vi.fn(() => 'rate-limit-do'), get: vi.fn(() => rateLimitStub) } as unknown as DurableObjectNamespace,
    KV: createMockKV(),
    R2_ACCESS_KEY_ID: 'test',
    R2_SECRET_ACCESS_KEY: 'test',
    CF_ACCOUNT_ID: 'test',
    ENVIRONMENT: 'test',
  };
}

/**
 * Build auth headers for workspace-key authenticated requests.
 */
export function wsAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Build auth headers for agent-token authenticated requests.
 */
export function agentAuthHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_AGENT_TOKEN}`,
    'Content-Type': 'application/json',
  };
}
