import type { KeyValueStore } from '../../ports/kv.js';

const DEFAULT_PRUNE_INTERVAL_MS = 60_000;

/**
 * In-memory key/value store with TTL, replacing the Cloudflare KV namespace for
 * idempotency records/locks and usage counters. Single-process; values are lost
 * on restart (idempotency windows and usage counters reset — acceptable for
 * self-host). A SQLite-backed variant could persist these behind the same port.
 *
 * A periodic sweep reclaims expired entries that are never read again, so the
 * map can't grow unbounded from one-shot keys (e.g. idempotency locks).
 */
export class InProcessKeyValueStore implements KeyValueStore {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(pruneIntervalMs: number = DEFAULT_PRUNE_INTERVAL_MS) {
    if (pruneIntervalMs > 0) {
      this.timer = setInterval(() => this.prune(), pruneIntervalMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Drop all expired entries. Runs periodically and is safe to call manually. */
  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.expiresAt !== null && entry.expiresAt <= now) this.store.delete(key);
    }
  }

  /** Stop the prune timer (server shutdown / test teardown). */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private live(key: string): { value: string; expiresAt: number | null } | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}
