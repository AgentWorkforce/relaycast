import type { KeyValueStore } from '../../ports/kv.js';

/**
 * In-memory key/value store with TTL, replacing the Cloudflare KV namespace for
 * idempotency records/locks and usage counters. Single-process; values are lost
 * on restart (idempotency windows and usage counters reset — acceptable for
 * self-host). A SQLite-backed variant could persist these behind the same port.
 */
export class InProcessKeyValueStore implements KeyValueStore {
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

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
