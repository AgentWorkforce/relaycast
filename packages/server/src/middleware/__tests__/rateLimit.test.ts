import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env.js';
import { rateLimit } from '../rateLimit.js';

function createMockRateLimitNamespace(): DurableObjectNamespace {
  const counters = new Map<string, number>();

  return {
    idFromName: vi.fn((name: string) => name),
    get: vi.fn(() => ({
      fetch: vi.fn(async (request: Request) => {
        const body = await request.json() as { bucketKey?: string; limit?: number };
        const key = body.bucketKey ?? 'default';
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        const limit = body.limit ?? 60;
        return Response.json({
          ok: true,
          data: {
            count: next,
            limit,
            remaining: Math.max(0, limit - next),
            allowed: next <= limit,
          },
        });
      }),
    })),
  } as unknown as DurableObjectNamespace;
}

function makeApp(options: { plan?: string; doOverride?: DurableObjectNamespace } = {}) {
  const rateLimitDo = options.doOverride ?? createMockRateLimitNamespace();
  const app = new Hono<AppEnv>();

  // Inject env and workspace into context
  app.use('*', async (c, next) => {
    (c.env as any) = { RATE_LIMIT_DO: rateLimitDo };
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

  return { app, rateLimitDo };
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows request under limit', async () => {
    const { app } = makeApp();
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('300');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('299');
  });

  it('returns 429 when rate limit exceeded', async () => {
    const exceededDo = {
      idFromName: vi.fn(() => 'ws_123'),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => Response.json({
          ok: true,
          data: { count: 301, limit: 300, remaining: 0, allowed: false },
        })),
      })),
    } as unknown as DurableObjectNamespace;
    const { app } = makeApp({ doOverride: exceededDo });

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('rate_limit_exceeded');
  });

  it('sets rate limit headers', async () => {
    const fixedDo = {
      idFromName: vi.fn(() => 'ws_123'),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => Response.json({
          ok: true,
          data: { count: 11, limit: 60, remaining: 49, allowed: true },
        })),
      })),
    } as unknown as DurableObjectNamespace;
    const { app } = makeApp({ doOverride: fixedDo });

    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('300');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('49');
  });

  it('uses higher limits for pro plan', async () => {
    const { app } = makeApp({ plan: 'pro' });
    const res = await app.request('/test');
    expect(res.status).toBe(200);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('6000');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('5999');
  });

  it('uses in-memory fallback when RateLimitDO fails', async () => {
    const brokenDo = {
      idFromName: vi.fn(() => 'ws_123'),
      get: vi.fn(() => ({
        fetch: vi.fn(async () => {
          throw new Error('DO down');
        }),
      })),
    } as unknown as DurableObjectNamespace;
    const { app } = makeApp({ doOverride: brokenDo });

    const res = await app.request('/test');
    // Falls back to in-memory, first request should pass
    expect(res.status).toBe(200);
  });

  it('skips rate limiting when no workspace', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      (c.env as any) = { RATE_LIMIT_DO: createMockRateLimitNamespace() };
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
    // POST messages get 0.5 multiplier: ceil(300 * 0.5) = 150
    expect(res.headers.get('X-RateLimit-Limit')).toBe('150');
  });

  it('calls RateLimitDO check endpoint', async () => {
    const rateLimitDo = createMockRateLimitNamespace();
    const { app } = makeApp({ doOverride: rateLimitDo });
    await app.request('/test');
    expect(rateLimitDo.idFromName).toHaveBeenCalledWith('ws_123');
    expect(rateLimitDo.get).toHaveBeenCalled();
  });
});
