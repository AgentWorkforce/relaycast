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
    // An addressed DM is a DM: it shares the POST:/dm bucket so the new path
    // cannot add a second DM budget.
    .replace(/^\/to\/[^/]+$/, '/dm')
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
  const bucketKey = `${workspace.id}:${routeKey ?? 'global'}:${rateLimitWindow(now)}`;

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

  try {
    const { allowed, count, remaining } = await rateLimiter.check({ bucketKey, limit, windowMs: RATE_LIMIT_WINDOW_MS });
    const resetAt = rateLimitWindowResetAt(now);
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining ?? Math.max(0, limit - count)));
    c.header('X-RateLimit-Reset', String(Math.ceil(resetAt / 1000)));

    if (!allowed) {
      // Transient by construction: the bucket is keyed to this minute, so the
      // advertised wait is the real one.
      setRetryContract(c, resetAt, now);
      return jsonError(c, 'rate_limit_exceeded', `Rate limit exceeded. ${limit} requests per minute allowed for ${workspace.plan} plan.`, 429);
    }
  } catch {
    // Only the limiter backend failing is fail-open — a transient infra hiccup
    // shouldn't 500 the request (the limit was still computed above).
  }

  await presenceRefresh(c, async () => {});
  return usageTracker(c, next);
});
