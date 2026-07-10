import assert from "node:assert/strict";
import { test } from "vitest";

import { markEventSeen, pruneExpiredDedupEntries } from "../src/dedup.js";

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.values.delete(key);
    }
  }

  async list<T>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>> {
    const entries = new Map<string, T>();
    for (const [key, value] of this.values.entries()) {
      if (!options?.prefix || key.startsWith(options.prefix)) {
        entries.set(key, value as T);
        if (options?.limit && entries.size >= options.limit) {
          break;
        }
      }
    }
    return entries;
  }
}

test("markEventSeen enforces the 24h dedup window", async () => {
  const storage = new MemoryStorage();
  const nowMs = Date.UTC(2026, 4, 11, 12, 0, 0);
  const withinWindowMs = nowMs + 23 * 60 * 60 * 1000;
  const afterWindowMs = nowMs + 24 * 60 * 60 * 1000 + 1;

  assert.equal(await markEventSeen(storage as never, "ws:agent:event-1", nowMs), true);
  assert.equal(
    await markEventSeen(storage as never, "ws:agent:event-1", withinWindowMs),
    false,
  );
  assert.equal(
    await markEventSeen(storage as never, "ws:agent:event-1", afterWindowMs),
    true,
  );
});

test("pruneExpiredDedupEntries removes expired records and keeps live ones", async () => {
  const storage = new MemoryStorage();
  const nowMs = Date.UTC(2026, 4, 11, 12, 0, 0);

  await storage.put("dedup:expired", {
    firstSeenAt: nowMs - 10_000,
    expiresAt: nowMs - 1,
  });
  await storage.put("dedup:live", {
    firstSeenAt: nowMs,
    expiresAt: nowMs + 60_000,
  });
  await storage.put("other:key", {
    firstSeenAt: nowMs,
    expiresAt: nowMs - 1,
  });

  await pruneExpiredDedupEntries(storage as never, nowMs);

  assert.equal(await storage.get("dedup:expired"), undefined);
  assert.deepEqual(await storage.get("dedup:live"), {
    firstSeenAt: nowMs,
    expiresAt: nowMs + 60_000,
  });
  assert.deepEqual(await storage.get("other:key"), {
    firstSeenAt: nowMs,
    expiresAt: nowMs - 1,
  });
});

test("markEventSeen rejects blank keys", async () => {
  const storage = new MemoryStorage();
  const nowMs = Date.UTC(2026, 4, 11, 12, 0, 0);

  await assert.rejects(markEventSeen(storage as never, "", nowMs), /dedup key is required/);
  await assert.rejects(markEventSeen(storage as never, "   ", nowMs), /dedup key is required/);
});

test("markEventSeen defaults invalid windows to the 24h dedup window", async () => {
  const storage = new MemoryStorage();
  const nowMs = Date.UTC(2026, 4, 11, 12, 0, 0);

  assert.equal(await markEventSeen(storage as never, "zero-window", nowMs, 0), true);
  assert.equal(await markEventSeen(storage as never, "zero-window", nowMs + 1), false);

  assert.equal(await markEventSeen(storage as never, "negative-window", nowMs, -1), true);
  assert.equal(await markEventSeen(storage as never, "negative-window", nowMs + 1), false);
});
