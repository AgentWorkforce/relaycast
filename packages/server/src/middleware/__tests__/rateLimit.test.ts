import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { createMockKV } from '../../__tests__/test-helpers.js';
import { rateLimit } from '../rateLimit.js';

function makeApp(options: { plan?: string; kvOverride?: KVNamespace } = {}) {
  const kv = options.kvOverride ?? createMockKV();
  const app = new Hono<AppEnv>();

  // Inject env and workspace into context
  app.use('*', async (c, next) => {
    (c.env as any) = { KV: kv };
    c.set('workspace', {
      id: 'ws_123',
      name: 'test-workspace',
      plan: options.plan || 'free',
    } as any);
    await next();
  });
  app.use('*', rateLimit);
  app.get('/test', (c) => c.json({ ok: true }));
  app.get('/v1/channels/general/messages', (c) => c.json({ ok: true }));
  app.post('/v1/channels/general/messages', (c) => c.json({ ok: true }));

  return { app, kv };
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows request under limit', async () => {
    const { app } = makeApp();
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('59');
  });

  it('returns 429 when rate limit exceeded', async () => {
    const kv = createMockKV();
    // Pre-fill KV with count at the limit
    vi.mocked(kv.get).mockResolvedValue('60');
    const { app } = makeApp({ kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('rate_limit_exceeded');
  });

  it('sets rate limit headers', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockResolvedValue('10');
    const { app } = makeApp({ kvOverride: kv });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('60');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('49');
  });

  it('uses higher limits for pro plan', async () => {
    const { app } = makeApp({ plan: 'pro' });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('300');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('299');
  });

  it('uses in-memory fallback when KV fails', async () => {
    const kv = createMockKV();
    vi.mocked(kv.get).mockRejectedValue(new Error('KV down'));
    const { app } = makeApp({ kvOverride: kv });

    const res = await app.request('/test');
    // Falls back to in-memory, first request should pass
    expect(res.status).toBe(200);
  });

  it('skips rate limiting when no workspace', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      (c.env as any) = { KV: createMockKV() };
      // No workspace set
      await next();
    });
    app.use('*', rateLimit);
    app.get('/test', (c) => c.json({ ok: true }));

    const res = await app.request('/test');
    expect(res.status).toBe(200);
  });

  it('applies route-specific multiplier for POST messages', async () => {
    const { app } = makeApp();
    const res = await app.request('/v1/channels/general/messages', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    // POST messages get 0.5 multiplier: ceil(60 * 0.5) = 30
    expect(res.headers.get('X-RateLimit-Limit')).toBe('30');
  });

  it('stores count in KV with TTL', async () => {
    const kv = createMockKV();
    const { app } = makeApp({ kvOverride: kv });
    await app.request('/test');
    expect(kv.put).toHaveBeenCalledWith(
      expect.stringContaining('rate:ws_123:'),
      '1',
      { expirationTtl: 60 },
    );
  });
});
