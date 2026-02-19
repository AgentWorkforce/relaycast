/**
 * RateLimitDO
 *
 * Per-workspace rate limiting actor. Keeps short-lived counters in memory so
 * hot request paths avoid KV write amplification while remaining strongly
 * consistent within a workspace.
 */
export class RateLimitDO implements DurableObject {
  private buckets = new Map<string, { count: number; expiresAt: number }>();
  private lastCleanup = Date.now();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/check') {
      return this.handleCheck(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  private cleanup(now: number): void {
    if (now - this.lastCleanup < 30_000) return;
    this.lastCleanup = now;

    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) {
        this.buckets.delete(key);
      }
    }
  }

  private async handleCheck(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      bucketKey?: unknown;
      limit?: unknown;
      windowMs?: unknown;
    };

    const bucketKey = typeof body.bucketKey === 'string' ? body.bucketKey : '';
    const limit = typeof body.limit === 'number' ? body.limit : NaN;
    const windowMs = typeof body.windowMs === 'number' ? body.windowMs : 60_000;

    if (!bucketKey || !Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs) || windowMs <= 0) {
      return Response.json(
        {
          ok: false,
          error: { code: 'invalid_request', message: 'bucketKey (string), limit (number), and windowMs (number) are required' },
        },
        { status: 400 },
      );
    }

    const now = Date.now();
    this.cleanup(now);

    let bucket = this.buckets.get(bucketKey);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      this.buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    const count = bucket.count;
    const allowed = count <= limit;

    return Response.json({
      ok: true,
      data: {
        count,
        limit,
        remaining: Math.max(0, limit - count),
        allowed,
      },
    });
  }
}
