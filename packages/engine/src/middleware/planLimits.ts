import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import type { EntitlementsProvider, UpgradeGuidance, UsageMetric } from '../ports/entitlements.js';
import type { Workspace } from '../ports/auth.js';
import { getLifetimeUsageMetric, incrementLifetimeUsage, usagePeriodResetAt } from '../engine/usage.js';
import { setRetryContract } from '../lib/throttle.js';
import { PlanLimitExceededError, type PlanLimitExceededBody } from '../lib/planLimitError.js';
import { runInBackground } from '../routes/background.js';

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
function planLimitExceededBody(input: {
  metric: UsageMetric;
  plan: string;
  limit: number;
  usage: number;
  message: string;
  guidance: UpgradeGuidance | null;
}): PlanLimitExceededBody {
  const { guidance } = input;
  const nextStep = guidance
    ? `${guidance.hint ?? (guidance.action === 'sign_in' ? 'Sign in to keep going:' : 'Upgrade your plan to increase limits:')} ${guidance.url}`
    : 'Upgrade your plan to increase limits.';
  return {
    ok: false,
    error: {
      code: 'plan_limit_exceeded',
      message: `${input.message} ${nextStep}`,
      metric: input.metric,
      plan: input.plan,
      limit: input.limit,
      usage: input.usage,
      upgrade_url: guidance?.url ?? null,
      upgrade_action: guidance?.action ?? null,
    },
  };
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
        return c.json(planLimitExceededBody({
          metric,
          plan,
          limit,
          usage: current,
          message: `Plan limit exceeded for ${metric}. Current plan: ${plan}. Limit: ${limit} per usage period. Current usage: ${current}. Quota resets at ${new Date(resetAt).toISOString()}.`,
          guidance,
        }), 429);
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
 * Idempotency is preserved. Only a fresh send that succeeds (2xx without
 * `Idempotency-Replayed`) is counted, so retries never spend the allowance.
 * Once the allowance is spent, a request without an `Idempotency-Key` is
 * refused here; a keyed request reaches the route so a replay of an earlier
 * successful send still returns its stored receipt, and the route refuses only
 * a fresh send ({@link assertMessageAllowance}, called inside the idempotent
 * operation).
 *
 * The count is kept alive past the response with `runInBackground`
 * (`waitUntil` on Workers). Check-then-count is not atomic: concurrent sends at
 * the boundary can overshoot by the number in flight, which a soft trial
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
    const body = planLimitExceededBody({
      metric: 'messages',
      plan,
      limit: allowance,
      usage: used,
      message: `Message allowance used up: this workspace has sent ${used} of its ${allowance} messages (current plan: ${plan}). The allowance does not reset.`,
      guidance,
    });
    if (!c.req.header('Idempotency-Key')) return c.json(body, 429);
    c.set('messageAllowanceDenial', body);
  }

  await next();

  if (c.res.status >= 200 && c.res.status < 300 && c.res.headers.get('Idempotency-Replayed') !== 'true') {
    runInBackground(c, incrementLifetimeUsage(kv, workspace.id, 'messages'), 'lifetime message usage increment');
  }
});

/**
 * Refuse a fresh send when `checkMessageAllowance` found the allowance spent.
 * Call it first inside a message route's idempotent `operation`, which runs
 * only for a new send — never for a replay of a stored receipt.
 */
export function assertMessageAllowance(c: Context<AppEnv>): void {
  const denial = c.get('messageAllowanceDenial');
  if (denial) throw new PlanLimitExceededError(denial);
}
