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
  /**
   * Count this request against `bucketKey` and report whether it is allowed.
   * A rejected request must not consume the bucket, so a throttled client's
   * own retries cannot push `count` past `limit` or extend its window.
   */
  check(args: { bucketKey: string; limit: number; windowMs: number }): Promise<RateLimitResult>;
}
