import type { KeyValueStore } from '@relaycast/engine/ports';
import type { CloudflareBindings } from '../../env.js';

/**
 * Cloudflare KV implementation of the key/value port (idempotency records/locks,
 * plan-usage counters).
 */
export function createCloudflareKv(env: CloudflareBindings): KeyValueStore {
  return {
    get(key) {
      return env.KV.get(key);
    },
    async put(key, value, options) {
      await env.KV.put(key, value, options?.expirationTtl ? { expirationTtl: options.expirationTtl } : undefined);
    },
    async delete(key) {
      await env.KV.delete(key);
    },
    async increment(key, delta) {
      const stub = env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(`kv:${key}`));
      const res = await stub.fetch(new Request('http://do/kv-increment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key, delta }),
      }));
      if (!res.ok) throw new Error(`RateLimitDO increment returned HTTP ${res.status}`);
      const payload = (await res.json()) as { data?: { value?: number } };
      const value = payload.data?.value;
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error('RateLimitDO increment returned an invalid value');
      }
      return value;
    },
  };
}
