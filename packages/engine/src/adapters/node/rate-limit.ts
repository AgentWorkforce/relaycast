import type { RateLimiter, RateLimitResult } from '../../ports/rate-limit.js';

/**
 * In-memory sliding-window rate limiter, mirroring RateLimitDO. Buckets expire
 * after their window; a periodic cleanup keeps the map bounded. Single-process
 * only (each Node process counts independently).
 */
export class InProcessRateLimiter implements RateLimiter {
  private readonly buckets = new Map<string, { count: number; expiresAt: number }>();
  private lastCleanup = Date.now();

  private cleanup(now: number): void {
    if (now - this.lastCleanup < 30_000) return;
    this.lastCleanup = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key);
    }
  }

  async check(args: { bucketKey: string; limit: number; windowMs: number }): Promise<RateLimitResult> {
    const { bucketKey, limit, windowMs } = args;
    const now = Date.now();
    this.cleanup(now);

    let bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      this.buckets.set(bucketKey, bucket);
    }

    // A rejected request must not consume the bucket. Counting it lets a client
    // that retries while throttled drive the count arbitrarily past the limit,
    // which reports a nonsense `count` and, for any sliding-window backend,
    // lets the caller's own retries hold its window open.
    const allowed = bucket.count < limit;
    if (allowed) bucket.count += 1;

    return {
      count: bucket.count,
      remaining: Math.max(0, limit - bucket.count),
      allowed,
    };
  }
}
