import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'node:crypto';
import {
  requireWorkspaceKey,
  requireAuth,
  requireAgentToken,
  hashToken,
} from '../auth.js';

// Mock the DB module
vi.mock('../../db/index.js', () => ({
  getDb: vi.fn(),
}));

import { getDb } from '../../db/index.js';

function makeApp(middleware: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  app.use(middleware as express.RequestHandler);
  app.get('/test', (_req, res) => {
    res.json({ ok: true });
  });
  app.post('/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

const fakeWorkspace = {
  id: 'ws_123',
  name: 'test-workspace',
  apiKeyHash: '',
  systemPrompt: null,
  plan: 'free',
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  createdAt: new Date(),
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
  lastSeen: new Date(),
};

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

  beforeEach(() => {
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: vi.fn().mockResolvedValue([{ ...fakeWorkspace, apiKeyHash }]),
        }),
      }),
    } as ReturnType<typeof getDb>);
  });

  it('returns 401 when no Authorization header', async () => {
    const app = makeApp(requireWorkspaceKey as unknown as express.RequestHandler);
    const res = await request(app).get('/test');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('returns 401 for agent token format', async () => {
    const app = makeApp(requireWorkspaceKey as unknown as express.RequestHandler);
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer at_live_abc123');
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid workspace key', async () => {
    const app = makeApp(requireWorkspaceKey as unknown as express.RequestHandler);
    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 401 with invalid workspace key', async () => {
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    } as ReturnType<typeof getDb>);

    const app = makeApp(requireWorkspaceKey as unknown as express.RequestHandler);
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer rk_live_invalidkey1234567890abcdef');
    expect(res.status).toBe(401);
  });
});

describe('requireAuth', () => {
  const apiKey = `rk_live_${crypto.randomBytes(16).toString('hex')}`;
  const apiKeyHash = hashToken(apiKey);
  const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const agentTokenHash = hashToken(agentToken);

  it('accepts workspace key', async () => {
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: vi.fn().mockResolvedValue([{ ...fakeWorkspace, apiKeyHash }]),
        }),
      }),
    } as ReturnType<typeof getDb>);

    const app = makeApp(requireAuth as unknown as express.RequestHandler);
    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${apiKey}`);
    expect(res.status).toBe(200);
  });

  it('accepts agent token', async () => {
    let callCount = 0;
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve([
                { ...fakeAgent, tokenHash: agentTokenHash },
              ]);
            }
            return Promise.resolve([fakeWorkspace]);
          }),
        }),
      }),
    } as ReturnType<typeof getDb>);

    const app = makeApp(requireAuth as unknown as express.RequestHandler);
    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
  });

  it('rejects unknown token format', async () => {
    const app = makeApp(requireAuth as unknown as express.RequestHandler);
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer unknown_format_token');
    expect(res.status).toBe(401);
  });
});

describe('requireAgentToken', () => {
  const agentToken = `at_live_${crypto.randomBytes(16).toString('hex')}`;
  const agentTokenHash = hashToken(agentToken);

  it('returns 401 for workspace key', async () => {
    const app = makeApp(requireAgentToken as unknown as express.RequestHandler);
    const res = await request(app)
      .get('/test')
      .set('Authorization', 'Bearer rk_live_abc123');
    expect(res.status).toBe(401);
  });

  it('returns 200 with valid agent token', async () => {
    let callCount = 0;
    vi.mocked(getDb).mockReturnValue({
      select: () => ({
        from: () => ({
          where: vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return Promise.resolve([
                { ...fakeAgent, tokenHash: agentTokenHash },
              ]);
            }
            return Promise.resolve([fakeWorkspace]);
          }),
        }),
      }),
    } as ReturnType<typeof getDb>);

    const app = makeApp(requireAgentToken as unknown as express.RequestHandler);
    const res = await request(app)
      .get('/test')
      .set('Authorization', `Bearer ${agentToken}`);
    expect(res.status).toBe(200);
  });
});
