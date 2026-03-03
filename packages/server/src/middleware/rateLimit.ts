import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env.js';

// Global rate limits per plan (requests per minute)
const RATE_LIMITS: Record<string, number> = {
  free: 60,
  pro: 300,
  enterprise: 1000,
};

// Per-route rate limit multipliers (fraction of global limit)
// POST endpoints get tighter limits, GET endpoints get looser
const ROUTE_MULTIPLIERS: Record<string, number> = {
  'POST:/channels/*/messages': 0.5, // message send: half the global limit
  'POST:/dm': 0.5,
  'POST:/dm/group': 0.3,
  'POST:/messages/*/reactions': 0.4,
  'GET:/channels/*/messages': 1.0,
  'GET:/agents/presence': 0.3,
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

// In-memory token bucket fallback when Durable Object checks fail
const inMemoryBuckets = new Map<string, { tokens: number; lastRefill: number }>();
const BUCKET_CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

function inMemoryRateCheck(workspaceId: string, routeKey: string | null, limit: number): { allowed: boolean; count: number } {
  const now = Date.now();

  // Periodic cleanup of stale buckets
  if (now - lastCleanup > BUCKET_CLEANUP_INTERVAL) {
    lastCleanup = now;
    for (const [key, bucket] of inMemoryBuckets) {
      if (now - bucket.lastRefill > 120_000) inMemoryBuckets.delete(key);
    }
  }

  const window = Math.floor(now / 60000);
  const key = routeKey ? `${workspaceId}:${routeKey}:${window}` : `${workspaceId}:${window}`;
  let bucket = inMemoryBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: 0, lastRefill: now };
    inMemoryBuckets.set(key, bucket);
  }

  bucket.tokens++;
  bucket.lastRefill = now;
  return { allowed: bucket.tokens <= limit, count: bucket.tokens };
}

export const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
  const workspace = c.get('workspace');
  if (!workspace) {
    await next();
    return;
  }

  // Read plan from org (set by auth middleware), fall back to workspace.plan for compat
  const org = c.get('organization');
  const plan = org?.plan || workspace.plan || 'free';
  const globalLimit = RATE_LIMITS[plan] || RATE_LIMITS.free;

  // Apply route-specific multiplier if applicable
  const routeKey = getRouteKey(c.req.method, c.req.path);
  const limit = routeKey ? Math.ceil(globalLimit * ROUTE_MULTIPLIERS[routeKey]) : globalLimit;

  const window = Math.floor(Date.now() / 60000);
  const bucketKey = routeKey
    ? `${routeKey}:${window}`
    : `global:${window}`;

  try {
    const id = c.env.RATE_LIMIT_DO.idFromName(workspace.id);
    const stub = c.env.RATE_LIMIT_DO.get(id);
    const res = await stub.fetch(new Request('http://do/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucketKey,
        limit,
        windowMs: 60_000,
      }),
    }));

    if (!res.ok) {
      throw new Error(`RateLimitDO returned HTTP ${res.status}`);
    }

    const payload = await res.json() as {
      ok?: boolean;
      data?: {
        count?: number;
        remaining?: number;
        allowed?: boolean;
      };
    };

    const count = payload.data?.count ?? 1;
    const remaining = payload.data?.remaining ?? Math.max(0, limit - count);
    const allowed = payload.data?.allowed ?? count <= limit;

    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(remaining));

    if (!allowed) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'rate_limit_exceeded',
            message: `Rate limit exceeded. ${limit} requests per minute allowed for ${plan} plan.`,
          },
        },
        429,
      );
    }
  } catch {
    // In-memory fallback when RateLimitDO is unavailable — still respects route multipliers
    const { allowed, count } = inMemoryRateCheck(workspace.id, routeKey, limit);
    c.header('X-RateLimit-Limit', String(limit));
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - count)));

    if (!allowed) {
      return c.json(
        {
          ok: false,
          error: {
            code: 'rate_limit_exceeded',
            message: `Rate limit exceeded. ${limit} requests per minute allowed for ${plan} plan.`,
          },
        },
        429,
      );
    }
  }

  await next();
});
