import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';
import { jsonError } from '../lib/httpResponse.js';
import { RATE_LIMIT_WINDOW_MS, rateLimitWindow, rateLimitWindowResetAt, setRetryContract } from '../lib/throttle.js';
import { checkPlanLimit } from './planLimits.js';
import { presenceRefresh } from './presenceRefresh.js';
import { usageTracker } from './usageTracker.js';

// Conservative per-minute ceiling applied when the entitlements lookup fails,
// so an entitlements outage degrades to a safe default rather than no limit.
const FALLBACK_RATE_PER_MIN = 300;
const OBSERVER_RATE_LIMIT_MULTIPLIER = 0.1;
const checkApiCallPlanLimit = checkPlanLimit('api_calls');

// Per-route rate limit multipliers (fraction of the global per-minute limit).
// POST endpoints get tighter limits, GET endpoints get looser.
const ROUTE_MULTIPLIERS: Record<string, number> = {
  'POST:/channels/*/messages': 0.5, // message send: half the global limit
  'POST:/dm': 0.5,
  'POST:/dm/group': 0.3,
  'POST:/messages/*/reactions': 0.4,
  'GET:/channels/*/messages': 1.0,
  'GET:/agents/presence': 0.3,
  // Workspace identity is the control-plane read a client makes before it can
  // do anything else — credential probes, launch preflight, and the lookup a
  // caller uses to find out *why* it is being throttled. In the shared `global`
  // bucket that one request competes with all of the workspace's data-plane
  // traffic, so a busy workspace starves it and no client-side retry helps:
  // every attempt lands in the same saturated bucket. Its own bucket keeps
  // identity reachable while the data plane is at its ceiling.
  'GET:/workspace': 1.0,
};

function getRouteKey(method: string, path: string): string | null {
  // Normalize path: /v1/channels/foo/messages -> /channels/*/messages
  const normalized = path
    .replace(/^\/v1/, '')
    .replace(/\/[a-zA-Z0-9_-]+\/messages/, '/*/messages')
    .replace(/\/[a-zA-Z0-9_-]+\/reactions/, '/*/reactions')
    .replace(/\/[a-zA-Z0-9_-]+\/replies/, '/*/replies');
  const key = `${method}:${normalized}`;
  return ROUTE_MULTIPLIERS[key] !== undefined ? key : null;
}

export const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  if (!workspace) {
    await next();
    return;
  }

  let planAllowed = false;
  const planResponse = await checkApiCallPlanLimit(c, async () => {
    planAllowed = true;
  });
  if (!planAllowed) {
    return planResponse;
  }

  const { entitlements, rateLimiter } = c.get('engine');

  // Apply route-specific multiplier if applicable
  const routeKey = getRouteKey(c.req.method, c.req.path);
  // The rate limiter port is not workspace-scoped, so the workspace id is part
  // of the bucket key (the Cloudflare adapter previously scoped via the DO id).
  const now = Date.now();
  const observerToken = c.get('observerToken');
  const routeBucket = routeKey ?? 'global';
  const window = rateLimitWindow(now);

  // Resolve the per-minute limit. If entitlements are unavailable, fall back to
  // a conservative default and still enforce it — an entitlements outage must
  // NOT translate into unlimited throughput.
  let globalLimit: number;
  try {
    globalLimit = (await entitlements.getLimits(workspace)).rate_per_min;
  } catch {
    globalLimit = FALLBACK_RATE_PER_MIN;
  }
  const limit = routeKey ? Math.ceil(globalLimit * ROUTE_MULTIPLIERS[routeKey]) : globalLimit;
  // Observer polling must not consume the workspace-admin bucket. Bound each
  // link to a share of the workspace allowance, then apply a shared observer
  // ceiling so minting more links cannot multiply workspace throughput.
  // Preserve the historical admin key shape so deploys do not reset in-flight
  // workspace counters.
  const bucketLimits = observerToken
    ? [
        {
          bucketKey: `${workspace.id}:observer:${observerToken.id}:${routeBucket}:${window}`,
          limit: Math.max(1, Math.ceil(limit * OBSERVER_RATE_LIMIT_MULTIPLIER)),
        },
        { bucketKey: `${workspace.id}:observers:${routeBucket}:${window}`, limit },
      ]
    : [{ bucketKey: `${workspace.id}:${routeBucket}:${window}`, limit }];

  try {
    const resetAt = rateLimitWindowResetAt(now);
    let primaryResult: { count: number; remaining: number } | undefined;
    for (const bucket of bucketLimits) {
      const result = await rateLimiter.check({
        bucketKey: bucket.bucketKey,
        limit: bucket.limit,
        windowMs: RATE_LIMIT_WINDOW_MS,
      });
      primaryResult ??= result;
      if (!result.allowed) {
        c.header('X-RateLimit-Limit', String(bucket.limit));
        c.header('X-RateLimit-Remaining', String(result.remaining ?? Math.max(0, bucket.limit - result.count)));
        c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
        // Transient by construction: the bucket is keyed to this minute, so the
        // advertised wait is the real one.
        setRetryContract(c, resetAt, now);
        return jsonError(c, 'rate_limit_exceeded', `Rate limit exceeded. ${bucket.limit} requests per minute allowed for ${workspace.plan} plan.`, 429);
      }
    }
    const primaryLimit = bucketLimits[0].limit;
    c.header('X-RateLimit-Limit', String(primaryLimit));
    c.header('X-RateLimit-Remaining', String(primaryResult?.remaining ?? Math.max(0, primaryLimit - (primaryResult?.count ?? 0))));
    c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));
  } catch {
    // Only the limiter backend failing is fail-open — a transient infra hiccup
    // shouldn't 500 the request (the limit was still computed above).
  }

  await presenceRefresh(c, async () => {});
  return usageTracker(c, next);
});
