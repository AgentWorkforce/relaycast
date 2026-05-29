import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import type { UsageMetric } from '../ports/entitlements.js';

// Re-exported for back-compat with callers/tests that imported the table here.
export { PLAN_LIMITS } from '../providers/static-entitlements.js';

export function checkPlanLimit(metric: UsageMetric) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const workspace = c.get('workspace');
    if (!workspace) { await next(); return; }

    const { entitlements } = c.get('engine');
    const limits = await entitlements.getLimits(workspace);
    const limit = limits[metric];
    if (limit === Infinity) { await next(); return; }

    try {
      const current = await entitlements.getUsage(workspace.id, metric);
      if (current >= limit) {
        const plan = workspace.plan || 'free';
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
