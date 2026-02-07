import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { getRedis } from '../redis/index.js';

const RATE_LIMITS: Record<string, number> = {
  free: 60,
  pro: 300,
  enterprise: 1000,
};

export async function rateLimit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.workspace) {
    next();
    return;
  }

  const limit = RATE_LIMITS[req.workspace.plan] || RATE_LIMITS.free;
  const window = Math.floor(Date.now() / 60000);
  const key = `rate:${req.workspace.id}:${window}`;

  try {
    const redis = getRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 60);
    }

    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));

    if (count > limit) {
      res.status(429).json({
        ok: false,
        error: {
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded. ${limit} requests per minute allowed for ${req.workspace.plan} plan.`,
        },
      });
      return;
    }
  } catch {
    // If Redis is down, allow the request through
  }

  next();
}
