import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';

export const PLAN_LIMITS: Record<string, { messages: number; agents: number; file_bytes: number; rate_per_min: number }> = {
  free: { messages: 10_000, agents: 5, file_bytes: 100 * 1024 * 1024, rate_per_min: 300 },
  pro: { messages: 1_000_000, agents: 100, file_bytes: 50 * 1024 * 1024 * 1024, rate_per_min: 6000 },
  enterprise: { messages: Infinity, agents: Infinity, file_bytes: 500 * 1024 * 1024 * 1024, rate_per_min: 30000 },
};

export function checkPlanLimit(metric: 'messages' | 'agents' | 'file_bytes') {
  return createMiddleware<AppEnv>(async (c, next) => {
    const workspace = c.get('workspace');
    if (!workspace) { await next(); return; }

    const plan = workspace.plan || 'free';
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;
    const limit = limits[metric];
    if (limit === Infinity) { await next(); return; }

    try {
      const currentStr = await c.env.KV.get(`usage:${workspace.id}:${metric}`);
      const current = parseInt(currentStr || '0', 10);
      if (current >= limit) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'plan_limit_exceeded',
              message: `Plan limit exceeded for ${metric}. Current plan: ${plan}. Limit: ${limit}. Current usage: ${current}. Upgrade your plan to increase limits.`,
            },
          },
          429,
        );
      }
    } catch { /* fail open */ }

    await next();
  });
}
