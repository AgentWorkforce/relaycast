import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../redis/index.js', () => ({
  getRedis: vi.fn(),
}));

import { getRedis } from '../../redis/index.js';
import { PLAN_LIMITS, checkPlanLimit } from '../planLimits.js';

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
      messages: 500_000,
      agents: 50,
      file_bytes: 10 * 1024 * 1024 * 1024,
      rate_per_min: 600,
    });
  });

  it('has correct enterprise limits', () => {
    expect(PLAN_LIMITS.enterprise).toEqual({
      messages: Infinity,
      agents: Infinity,
      file_bytes: 100 * 1024 * 1024 * 1024,
      rate_per_min: 6000,
    });
  });
});

describe('checkPlanLimit("messages")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows requests under the limit', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue('5000') };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const middleware = checkPlanLimit('messages');
    const req = { workspace: { id: 'ws_123', plan: 'free' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 429 when at the limit', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue('10000') };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const middleware = checkPlanLimit('messages');
    const req = { workspace: { id: 'ws_123', plan: 'free' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'plan_limit_exceeded' }),
    }));
  });

  it('allows pro plan with higher limits', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue('50000') };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const middleware = checkPlanLimit('messages');
    const req = { workspace: { id: 'ws_123', plan: 'pro' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('always allows enterprise (Infinity)', async () => {
    const middleware = checkPlanLimit('messages');
    const req = { workspace: { id: 'ws_123', plan: 'enterprise' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
    // Redis should not be called for Infinity limits
  });

  it('fails open on Redis error', async () => {
    vi.mocked(getRedis).mockImplementation(() => { throw new Error('Redis down'); });

    const middleware = checkPlanLimit('messages');
    const req = { workspace: { id: 'ws_123', plan: 'free' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('calls next if no workspace', async () => {
    const middleware = checkPlanLimit('messages');
    const req = {} as any;
    const res = {} as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('checkPlanLimit("agents")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 429 at 5 agents for free plan', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue('5') };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const middleware = checkPlanLimit('agents');
    const req = { workspace: { id: 'ws_123', plan: 'free' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('allows pro plan up to 50 agents', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue('49') };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const middleware = checkPlanLimit('agents');
    const req = { workspace: { id: 'ws_123', plan: 'pro' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('checkPlanLimit("file_bytes")', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 429 at 100MB for free plan', async () => {
    const mockRedis = { get: vi.fn().mockResolvedValue(String(100 * 1024 * 1024)) };
    vi.mocked(getRedis).mockReturnValue(mockRedis as any);

    const middleware = checkPlanLimit('file_bytes');
    const req = { workspace: { id: 'ws_123', plan: 'free' } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await middleware(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
  });
});
