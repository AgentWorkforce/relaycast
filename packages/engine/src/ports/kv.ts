/**
 * Key/value store port — replaces the Cloudflare KV namespace.
 *
 * Used for idempotency records/locks (`middleware/idempotency.ts`) and plan-usage
 * counters (`middleware/planLimits.ts`, `middleware/usageTracker.ts`). The surface
 * is intentionally the small subset of `KVNamespace` the engine actually calls, so
 * a Cloudflare `KVNamespace` is structurally assignable to it. The Node adapter
 * implements it with an in-memory map (TTL via timestamps) or a SQLite table.
 */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
