import type { RateLimitCheck, RateLimiter, RateLimitResult } from '../../ports/rate-limit.js';

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

  async check(args: RateLimitCheck): Promise<RateLimitResult> {
    return (await this.checkMany([args]))[0];
  }

  async checkMany(args: RateLimitCheck[]): Promise<RateLimitResult[]> {
    const now = Date.now();
    this.cleanup(now);

    const buckets = args.map(({ bucketKey, windowMs }) => {
      let bucket = this.buckets.get(bucketKey);
      if (!bucket || bucket.expiresAt <= now) {
        bucket = { count: 0, expiresAt: now + windowMs };
        this.buckets.set(bucketKey, bucket);
      }
      return bucket;
    });
    const capacity = args.map(({ limit }, index) => buckets[index].count < limit);
    // A rejected request must not consume either the per-link or shared
    // observer bucket. The synchronous decision and updates make this atomic
    // within the in-process limiter's event loop.
    if (capacity.every(Boolean)) {
      for (const bucket of buckets) bucket.count += 1;
    }
    return args.map(({ limit }, index) => ({
      count: buckets[index].count,
      remaining: Math.max(0, limit - buckets[index].count),
      allowed: capacity[index],
    }));
  }
}
