import type { RateLimiter, RateLimitResult } from '@relaycast/engine/ports';
import type { CloudflareBindings } from '../../env.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/**
 * RateLimitDO-backed implementation of the rate limiter port. The port isn't
 * workspace-scoped (the engine embeds the subject in the bucket key), so we
 * shard the DO by that subject — routing all checks to one global DO would
 * serialize every request through a single actor. Failures throw and the engine
 * middleware fails open.
 */
export function createCloudflareRateLimiter(env: CloudflareBindings): RateLimiter {
  return {
    async check(args: { bucketKey: string; limit: number; windowMs: number }): Promise<RateLimitResult> {
      // Shard the rate-limit DO by the bucket's subject so checks distribute
      // instead of serializing through one global DO. Engine-managed keys include
      // a trailing numeric window; adapter-owned keys can rely on windowMs alone.
      const parts = args.bucketKey.split(':');
      const hasWindowSuffix = parts.length > 1 && /^\d+$/.test(parts[parts.length - 1] ?? '');
      const shardName = hasWindowSuffix ? parts.slice(0, -1).join(':') : args.bucketKey;
      const stub = env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(shardName));
      const res = await stub.fetch(new Request('http://do/check', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(args),
      }));
      if (!res.ok) throw new Error(`RateLimitDO returned HTTP ${res.status}`);
      const payload = (await res.json()) as {
        data?: { count?: number; remaining?: number; allowed?: boolean };
      };
      const count = payload.data?.count ?? 1;
      return {
        count,
        remaining: payload.data?.remaining ?? Math.max(0, args.limit - count),
        allowed: payload.data?.allowed ?? count <= args.limit,
      };
    },
  };
}
