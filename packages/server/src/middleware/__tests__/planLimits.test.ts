import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { createMockKV } from '../../__tests__/test-helpers.js';
import { PLAN_LIMITS, checkPlanLimit } from '../planLimits.js';

function makeApp(options: {
  metric: 'messages' | 'agents' | 'file_bytes';
  plan?: string;
  kvOverride?: KVNamespace;
  noWorkspace?: boolean;
}) {
  const kv = options.kvOverride ?? createMockKV();
  const app = new Hono<AppEnv>();

  app.use('*', async (c, next) => {
    (c.env as any) = { KV: kv };
    if (!options.noWorkspace) {
      c.set('workspace', {
        id: 'ws_123',
        name: 'test-workspace',
        plan: options.plan || 'free',
      } as any);
      c.set('organization', {
        id: 'org_123',
        plan: options.plan || 'free',
      } as any);
    }
    await next();
  });
  app.use('*', checkPlanLimit(options.metric));
  app.get('/test', (c) => c.json({ ok: true }));

  return { app, kv };
}

describe('PLAN_LIMITS', () => {
  it('has correct free limits', () => {
    expect(PLAN_LIMITS.free).toEqual({
      messages: 10_000,
      agents: 5,
      file_bytes: 100 * 1024 * 1024,
      rate_per_min: 60,
    });
  });

  it('has correct pro limits', () => {
    expect(PLAN_LIMITS.pro).toEqual({
      messages: 1_000_000,
      agents: 100,
      file_bytes: 50 * 1024 * 1024 * 1024,
      rate_per_min: 1200,
    });
  });

  it('has correct enterprise limits', () => {
    expect(PLAN_LIMITS.enterprise).toEqual({
      messages: Infinity,
      agents: Infinity,
      file_bytes: 500 * 1024 * 1024 * 1024,
      rate_per_min: 6000,
    });
  });
});

describe('checkPlanLimit("messages")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows requests under the limit', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValue('5000');
    const { app } = makeApp({ metric: 'messages', kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('returns 429 when at the limit', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValue('10000');
    const { app } = makeApp({ metric: 'messages', kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('plan_limit_exceeded');
  });

  it('allows pro plan with higher limits', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValue('50000');
    const { app } = makeApp({ metric: 'messages', plan: 'pro', kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('always allows enterprise (Infinity)', async () => {
    const { app, kv } = makeApp({ metric: 'messages', plan: 'enterprise' });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    // KV should not be called for Infinity limits
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('fails open on KV error', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockRejectedValue(new Error('KV down'));
    const { app } = makeApp({ metric: 'messages', kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('calls next if no workspace', async () => {
    const { app } = makeApp({ metric: 'messages', noWorkspace: true });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });
});

describe('checkPlanLimit("agents")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 429 at 5 agents for free plan', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValue('5');
    const { app } = makeApp({ metric: 'agents', kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
  });

  it('allows pro plan up to 100 agents', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValue('99');
    const { app } = makeApp({ metric: 'agents', plan: 'pro', kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });
});

describe('checkPlanLimit("file_bytes")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 429 at 100MB for free plan', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValue(String(100 * 1024 * 1024));
    const { app } = makeApp({ metric: 'file_bytes', kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
  });
});
