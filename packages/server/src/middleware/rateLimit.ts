import { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from './auth.js';
import { getRedis } from '../redis/index.js';

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

// In-memory token bucket fallback when Redis is down
const inMemoryBuckets = new Map<string, { tokens: number; lastRefill: number }>();
const BUCKET_CLEANUP_INTERVAL = 60_000;
let lastCleanup = Date.now();

function inMemoryRateCheck(workspaceId: string, limit: number): { allowed: boolean; count: number } {
  const now = Date.now();

  // Periodic cleanup of stale buckets
  if (now - lastCleanup > BUCKET_CLEANUP_INTERVAL) {
    lastCleanup = now;
    for (const [key, bucket] of inMemoryBuckets) {
      if (now - bucket.lastRefill > 120_000) inMemoryBuckets.delete(key);
    }
  }

  const window = Math.floor(now / 60000);
  const key = `${workspaceId}:${window}`;
  let bucket = inMemoryBuckets.get(key);
  if (!bucket) {
    bucket = { tokens: 0, lastRefill: now };
    inMemoryBuckets.set(key, bucket);
  }

  bucket.tokens++;
  return { allowed: bucket.tokens <= limit, count: bucket.tokens };
}

export async function rateLimit(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!req.workspace) {
    next();
    return;
  }

  const globalLimit = RATE_LIMITS[req.workspace.plan] || RATE_LIMITS.free;

  // Apply route-specific multiplier if applicable
  const routeKey = getRouteKey(req.method, req.path);
  const limit = routeKey ? Math.ceil(globalLimit * ROUTE_MULTIPLIERS[routeKey]) : globalLimit;

  const window = Math.floor(Date.now() / 60000);
  const redisKey = routeKey
    ? `rate:${req.workspace.id}:${routeKey}:${window}`
    : `rate:${req.workspace.id}:${window}`;

  try {
    const redis = getRedis();
    const count = await redis.incr(redisKey);
    if (count === 1) {
      await redis.expire(redisKey, 60);
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
    // In-memory fallback when Redis is down — still respects route multipliers
    const { allowed, count } = inMemoryRateCheck(req.workspace.id, limit);
    res.setHeader('X-RateLimit-Limit', limit);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, limit - count));

    if (!allowed) {
      res.status(429).json({
        ok: false,
        error: {
          code: 'rate_limit_exceeded',
          message: `Rate limit exceeded. ${limit} requests per minute allowed for ${req.workspace.plan} plan.`,
        },
      });
      return;
    }
  }

  next();
}
