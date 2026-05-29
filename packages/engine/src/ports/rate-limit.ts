/**
 * Rate limiter port — replaces RateLimitDO `/check`.
 *
 * The per-route multiplier logic stays in the rate-limit middleware; only the
 * bucket check is the port. Node uses an in-memory sliding window (today's
 * middleware fallback, lifted out); Cloudflare routes to RateLimitDO.
 */
export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
}

export interface RateLimiter {
  check(args: { bucketKey: string; limit: number; windowMs: number }): Promise<RateLimitResult>;
}
