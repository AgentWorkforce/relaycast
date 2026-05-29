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

    bucket.count += 1;
    const count = bucket.count;
    return {
      count,
      remaining: Math.max(0, limit - count),
      allowed: count <= limit,
    };
  }
}
