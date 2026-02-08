import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { getRedis } from '../redis/index.js';

export const PLAN_LIMITS: Record<string, { messages: number; agents: number; file_bytes: number; rate_per_min: number }> = {
  free: { messages: 10_000, agents: 5, file_bytes: 100 * 1024 * 1024, rate_per_min: 60 },
  pro: { messages: 1_000_000, agents: 100, file_bytes: 50 * 1024 * 1024 * 1024, rate_per_min: 1200 },
  enterprise: { messages: Infinity, agents: Infinity, file_bytes: 500 * 1024 * 1024 * 1024, rate_per_min: 6000 },
};

export function checkPlanLimit(metric: 'messages' | 'agents' | 'file_bytes') {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.workspace) { next(); return; }
    const plan = req.workspace.plan || 'free';
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const limit = limits[metric];
    if (limit === Infinity) { next(); return; }
    try {
      const redis = getRedis();
      const currentStr = await redis.get(`usage:${req.workspace.id}:${metric}`);
      const current = parseInt(currentStr || '0', 10);
      if (current >= limit) {
        res.status(429).json({ ok: false, error: { code: 'plan_limit_exceeded', message: `Plan limit exceeded for ${metric}. Current plan: ${plan}. Limit: ${limit}. Current usage: ${current}. Upgrade your plan to increase limits.` } });
        return;
      }
    } catch { /* fail open */ }
    next();
  };
}
