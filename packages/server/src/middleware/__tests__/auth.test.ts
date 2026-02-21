import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import {
  requireWorkspaceKey,
  requireAuth,
  requireAgentToken,
  hashToken,
} from '../auth.js';

// Mock touchLastSeen and touchWorkspaceActivity to avoid DB calls
vi.mock('../../engine/agent.js', () => ({
  touchLastSeen: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../engine/eviction.js', () => ({
  touchWorkspaceActivity: vi.fn().mockResolvedValue(undefined),
}));

const fakeWorkspace = {
  id: 'ws_123',
  name: 'test-workspace',
  apiKeyHash: '',
  systemPrompt: null,
  plan: 'free' as const,
  createdAt: new Date(),
  lastActivityAt: new Date(),
  suspendedAt: null,
  metadata: {},
};

const fakeAgent = {
  id: 'agent_123',
  workspaceId: 'ws_123',
  name: 'TestBot',
  type: 'agent',
  tokenHash: '',
  status: 'online',
  persona: null,
  metadata: {},
  createdAt: new Date(),
  lastSeen: new Date(0), // old date to trigger touchLastSeen
};

function makeApp(middleware: ReturnType<typeof import('hono/factory').createMiddleware>, mockDb: any) {
  const app = new Hono<AppEnv>();
  // Inject mock db into context
  app.use('*', async (c, next) => {
    c.set('db', mockDb);
    await next();
  });
  app.use('*', middleware);
  app.get('/test', (c) => c.json({ ok: true }));
  app.post('/test', (c) => c.json({ ok: true }));
  return app;
}

function mockDbReturning(...results: any[]) {
  let callCount = 0;
  return {
    select: () => ({
      from: () => ({
        where: vi.fn().mockImplementation(() => {
          const result = results[callCount] ?? results[results.length - 1];
          callCount++;
          return Promise.resolve(result);
        }),
      }),
    }),
    update: () => ({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  } as any;
}

describe('hashToken', () => {
  it('returns SHA-256 hex digest', () => {
    const input = 'test-token';
    const expected = crypto.createHash('sha256').update(input).digest('hex');
    expect(hashToken(input)).toBe(expected);
  });
});

describe('requireWorkspaceKey', () => {
  const apiKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
  const apiKeyHash = hashToken(apiKey);

  it('returns 401 when no Authorization header', async () => {
    const app = makeApp(requireWorkspaceKey, mockDbReturning([]));
    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 for agent token format', async () => {
    const app = makeApp(requireWorkspaceKey, mockDbReturning([]));
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer at_live_abc123' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid workspace key', async () => {
    const db = mockDbReturning([{ ...fakeWorkspace, apiKeyHash }]);
    const app = makeApp(requireWorkspaceKey, db);
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('returns 401 with invalid workspace key', async () => {
    const db = mockDbReturning([]);
    const app = makeApp(requireWorkspaceKey, db);
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer rk_live_badkey' },
    });
    expect(res.status).toBe(401);
  });
});

describe('requireAuth', () => {
  const apiKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
  const apiKeyHash = hashToken(apiKey);
  const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const agentTokenHash = hashToken(agentToken);

  it('accepts workspace key', async () => {
    const db = mockDbReturning([{ ...fakeWorkspace, apiKeyHash }]);
    const app = makeApp(requireAuth, db);
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    expect(res.status).toBe(200);
  });

  it('accepts agent token', async () => {
    const db = mockDbReturning(
      [{ ...fakeAgent, tokenHash: agentTokenHash }],
      [fakeWorkspace],
    );
    const app = makeApp(requireAuth, db);
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects unknown token format', async () => {
    const db = mockDbReturning([]);
    const app = makeApp(requireAuth, db);
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer unknown_format_token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when no Authorization header', async () => {
    const db = mockDbReturning([]);
    const app = makeApp(requireAuth, db);
    const res = await app.request('/test');
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid agent token', async () => {
    const db = mockDbReturning([]);
    const app = makeApp(requireAuth, db);
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer at_live_badtoken` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns 401 when agent workspace not found', async () => {
    const db = mockDbReturning(
      [{ ...fakeAgent, tokenHash: agentTokenHash }],
      [], // workspace not found
    );
    const app = makeApp(requireAuth, db);
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe('Workspace not found');
  });
});

describe('requireAgentToken', () => {
  const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const agentTokenHash = hashToken(agentToken);

  it('returns 401 for workspace key', async () => {
    const db = mockDbReturning([]);
    const app = makeApp(requireAgentToken, db);
    const res = await app.request('/test', {
      headers: { Authorization: 'Bearer rk_live_abc123' },
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid agent token', async () => {
    const db = mockDbReturning(
      [{ ...fakeAgent, tokenHash: agentTokenHash }],
      [fakeWorkspace],
    );
    const app = makeApp(requireAgentToken, db);
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(200);
  });

  it('returns 401 when no Authorization header', async () => {
    const db = mockDbReturning([]);
    const app = makeApp(requireAgentToken, db);
    const res = await app.request('/test');
    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid agent token', async () => {
    const db = mockDbReturning([]);
    const app = makeApp(requireAgentToken, db);
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer at_live_badtoken` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe('Invalid agent token');
  });

  it('returns 401 when agent workspace not found', async () => {
    const db = mockDbReturning(
      [{ ...fakeAgent, tokenHash: agentTokenHash }],
      [], // workspace not found
    );
    const app = makeApp(requireAgentToken, db);
    const res = await app.request('/test', {
      headers: { Authorization: `Bearer ${agentToken}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.message).toBe('Workspace not found');
  });
});
