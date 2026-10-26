import { createMiddleware } from 'hono/factory';
import type { Context } from 'hono';
import type { AppEnv } from '../env.js';
import { createRegistrationCapacityGuard, type RegistrationCapacityGuard } from '../engine/planCapacity.js';
import type { EntitlementsProvider, UsageMetric } from '../ports/entitlements.js';
import { usagePeriodResetAt } from '../engine/usage.js';
import { jsonError } from '../lib/httpResponse.js';
import { setRetryContract } from '../lib/throttle.js';

/**
 * A provider billing on its own cycle reports that cycle's end. An absent or
 * failing hook falls back to the engine's UTC-month period, so how the reset is
 * *reported* can never change the throttling decision itself.
 */
async function resolveUsageResetAt(
  entitlements: EntitlementsProvider,
  workspaceId: string,
  metric: UsageMetric,
): Promise<number> {
  try {
    const reported = await entitlements.getUsageResetAt?.(workspaceId, metric);
    if (typeof reported === 'number' && Number.isFinite(reported)) return reported;
  } catch { /* fall through to the engine period */ }
  return usagePeriodResetAt();
}

export function checkPlanLimit(metric: UsageMetric) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const workspace = c.get('workspace');
    if (!workspace) { await next(); return; }

    const { entitlements } = c.get('engine');
    let limits;
    try {
      limits = await entitlements.getLimits(workspace);
    } catch {
      await next();
      return;
    }
    const limit = limits[metric];
    if (typeof limit !== 'number' || !Number.isFinite(limit)) { await next(); return; }

    try {
      const current = await entitlements.getUsage(workspace.id, metric);
      if (current >= limit) {
        // Quota clears on the billing period, not on a backoff. Advertising the
        // real reset lets a caller with a bounded retry budget fail fast instead
        // of spending it on a condition retrying cannot fix.
        const resetAt = await resolveUsageResetAt(entitlements, workspace.id, metric);
        setRetryContract(c, resetAt);
        return jsonError(c, 'plan_limit_exceeded', `Limit exceeded for ${metric}: ${limit} per usage period allowed, ${current} used. Quota resets at ${new Date(resetAt).toISOString()}.`, 429);
      }
    } catch { /* fail open */ }

    await next();
  });
}

/**
 * The registration-cap guard for the authenticated workspace on this
 * request. Registration routes hand it to the engine, which runs it only when
 * the request would create a NEW node or agent.
 */
export function registrationCapacityGuard(c: Context<AppEnv>): RegistrationCapacityGuard {
  return createRegistrationCapacityGuard({
    db: c.get('db'),
    entitlements: c.get('engine').entitlements,
    workspace: c.get('workspace'),
  });
}
