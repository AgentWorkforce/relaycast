import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { rateLimit } from '../rateLimit.js';

const mockIncr = vi.fn();
const mockExpire = vi.fn();

vi.mock('../../redis/index.js', () => ({
  getRedis: vi.fn(() => ({
    incr: mockIncr,
    expire: mockExpire,
  })),
}));

function makeApp() {
  const app = express();
  app.use(express.json());
  // Simulate authenticated request
  app.use((req: express.Request & { workspace?: unknown }, _res, next) => {
    req.workspace = {
      id: 'ws_123',
      plan: 'free', // 60 requests per minute
    };
    next();
  });
  app.use(rateLimit as unknown as express.RequestHandler);
  app.get('/test', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('rateLimit middleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows request under limit', async () => {
    mockIncr.mockResolvedValue(1);
    mockExpire.mockResolvedValue(1);

    const app = makeApp();
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('60');
    expect(res.headers['x-ratelimit-remaining']).toBe('59');
  });

  it('returns 429 when rate limit exceeded', async () => {
    mockIncr.mockResolvedValue(61);

    const app = makeApp();
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('rate_limit_exceeded');
  });

  it('allows request through when Redis is down', async () => {
    mockIncr.mockRejectedValue(new Error('Connection refused'));

    const app = makeApp();
    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });
});
