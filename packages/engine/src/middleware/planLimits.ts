import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import type { EntitlementsProvider, UpgradeGuidance, UsageMetric } from '../ports/entitlements.js';
import type { Workspace } from '../ports/auth.js';
import { getLifetimeUsageMetric, incrementLifetimeUsage, usagePeriodResetAt } from '../engine/usage.js';
import { setRetryContract } from '../lib/throttle.js';

// Re-exported for back-compat with callers/tests that imported the table here.
export { PLAN_LIMITS } from '../providers/static-entitlements.js';

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

/**
 * Where the caller can lift the limit. Advisory only: an absent or failing hook,
 * or a non-absolute URL, omits the guidance and never changes the decision.
 */
async function resolveUpgradeGuidance(
  entitlements: EntitlementsProvider,
  workspace: Workspace,
  metric: UsageMetric,
): Promise<UpgradeGuidance | null> {
  try {
    const guidance = await entitlements.getUpgradeGuidance?.(workspace, metric);
    if (!guidance || typeof guidance.url !== 'string') return null;
    const url = new URL(guidance.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return guidance;
  } catch {
    return null;
  }
}

/**
 * The `plan_limit_exceeded` body. The envelope stays `{ ok, error: { code,
 * message } }`; `metric`, `limit`, `usage`, `plan` and — when the host knows
 * one — `upgrade_url` / `upgrade_action` are additive fields on `error` so a
 * client can render "sign in" or "upgrade" without parsing the message.
 */
function planLimitExceeded(
  c: Context<AppEnv>,
  input: {
    metric: UsageMetric;
    plan: string;
    limit: number;
    usage: number;
    message: string;
    guidance: UpgradeGuidance | null;
  },
) {
  const { guidance } = input;
  const nextStep = guidance
    ? `${guidance.hint ?? (guidance.action === 'sign_in' ? 'Sign in to keep going:' : 'Upgrade your plan to increase limits:')} ${guidance.url}`
    : 'Upgrade your plan to increase limits.';
  const message = `${input.message} ${nextStep}`;
  return c.json({
    ok: false as const,
    error: {
      code: 'plan_limit_exceeded',
      message,
      metric: input.metric,
      plan: input.plan,
      limit: input.limit,
      usage: input.usage,
      upgrade_url: guidance?.url ?? null,
      upgrade_action: guidance?.action ?? null,
    },
  }, 429);
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
    if (typeof limit !== 'number' || limit === Infinity) { await next(); return; }

    try {
      const current = await entitlements.getUsage(workspace.id, metric);
      if (current >= limit) {
        const guidance = await resolveUpgradeGuidance(entitlements, workspace, metric);
        const plan = guidance?.plan ?? (workspace.plan || 'free');
        // Quota clears on the billing period, not on a backoff. Advertising the
        // real reset lets a caller with a bounded retry budget fail fast instead
        // of spending it on a condition retrying cannot fix.
        const resetAt = await resolveUsageResetAt(entitlements, workspace.id, metric);
        setRetryContract(c, resetAt);
        return planLimitExceeded(c, {
          metric,
          plan,
          limit,
          usage: current,
          message: `Plan limit exceeded for ${metric}. Current plan: ${plan}. Limit: ${limit} per usage period. Current usage: ${current}. Quota resets at ${new Date(resetAt).toISOString()}.`,
          guidance,
        });
      }
    } catch { /* fail open */ }

    await next();
  });
}

/**
 * Enforce a plan's one-time `lifetime_messages` allowance on message sends.
 *
 * Mounted after `rateLimit` on the routes that create a message (channel post,
 * DM, group DM, thread reply). Plans without a finite allowance — every tier
 * except a hosted anonymous trial, and always `selfhost` — skip it without
 * touching the counter. The allowance never resets, so the 429 carries no
 * `Retry-After`: retrying cannot clear it; signing in or upgrading does.
 *
 * Only a send that succeeds (2xx) is counted, so a rejected or invalid request
 * never spends the allowance. Check-then-count is not atomic: concurrent sends
 * at the boundary can overshoot by the number in flight, which a soft trial
 * allowance tolerates. Fails open on entitlement or counter errors, matching
 * `checkPlanLimit`.
 */
export const checkMessageAllowance = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  if (!workspace) { await next(); return; }

  const { entitlements, kv } = c.get('engine');
  let allowance: number | undefined;
  try {
    allowance = (await entitlements.getLimits(workspace)).lifetime_messages;
  } catch {
    await next();
    return;
  }
  if (typeof allowance !== 'number' || !Number.isFinite(allowance)) { await next(); return; }

  let used: number;
  try {
    used = await getLifetimeUsageMetric(kv, workspace.id, 'messages');
  } catch {
    await next();
    return;
  }

  if (used >= allowance) {
    const guidance = await resolveUpgradeGuidance(entitlements, workspace, 'messages');
    const plan = guidance?.plan ?? (workspace.plan || 'free');
    return planLimitExceeded(c, {
      metric: 'messages',
      plan,
      limit: allowance,
      usage: used,
      message: `Message allowance used up: this workspace has sent ${used} of its ${allowance} messages (current plan: ${plan}). The allowance does not reset.`,
      guidance,
    });
  }

  await next();

  if (c.res.status >= 200 && c.res.status < 300) {
    // Fire-and-forget like the api_calls tracker: counting must never fail or
    // delay a send that already succeeded.
    incrementLifetimeUsage(kv, workspace.id, 'messages').catch(() => {});
  }
});
