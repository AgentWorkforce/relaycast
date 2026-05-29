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
  /**
   * Atomically add `delta` to the integer value at `key` (treating a missing or
   * non-numeric value as 0) and return the new total. Exists because usage
   * counters were previously a racy get→parse→put read-modify-write that lost
   * concurrent increments. Adapters must implement this without a lost-update
   * window (the Cloudflare adapter routes it through a Durable Object).
   */
  increment(key: string, delta: number): Promise<number>;
}
