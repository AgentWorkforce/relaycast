import { beforeEach, describe, expect, it } from "vitest";
import { LeaseStore, type LeaseStorage } from "./lease-store";
import { ConcurrencyLeaseDO } from "./concurrency-lease-do";
import {
  DEFAULT_CLOUD_AGENT_WARM_LEASE_CAP,
  DEFAULT_CLOUD_AGENT_WARM_LEASE_POOL_ID,
  getCloudAgentWarmLeaseCap,
  getCloudAgentWarmLeasePoolId,
} from "./config";

type FakeStorage = LeaseStorage & {
  alarm: number | null;
  raw: Map<string, unknown>;
};

function makeStorage(): FakeStorage {
  const raw = new Map<string, unknown>();
  let alarm: number | null = null;
  return {
    raw,
    get alarm() {
      return alarm;
    },
    set alarm(value: number | null) {
      alarm = value;
    },
    async get<T>(key: string): Promise<T | undefined> {
      const value = raw.get(key);
      // DO storage returns deserialized copies; clone so the store can't alias
      // the persisted snapshot.
      return value === undefined ? undefined : (structuredClone(value) as T);
    },
    async put<T>(key: string, value: T): Promise<void> {
      raw.set(key, structuredClone(value));
    },
    async setAlarm(scheduledTime: number): Promise<void> {
      alarm = scheduledTime;
    },
    async deleteAlarm(): Promise<void> {
      alarm = null;
    },
  };
}

// Deterministic clock + id generator for the store.
function makeStore(storage: LeaseStorage, startMs = 1_000_000) {
  let now = startMs;
  let counter = 0;
  const store = new LeaseStore(
    storage,
    () => now,
    () => `lease-${++counter}`,
  );
  return {
    store,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (ms: number) => {
      now = ms;
    },
  };
}

describe("LeaseStore", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = makeStorage();
  });

  it("enforces the cap and rejects with retryAfterMs", async () => {
    const { store } = makeStore(storage);
    const a = await store.acquire({ leaseKey: "a", cap: 2, ttlMs: 5000 });
    const b = await store.acquire({ leaseKey: "b", cap: 2, ttlMs: 5000 });
    const c = await store.acquire({ leaseKey: "c", cap: 2, ttlMs: 5000 });

    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    expect(c.granted).toBe(false);
    expect(c.activeCount).toBe(2);
    expect(c.cap).toBe(2);
    // soonest expiry is ~5000ms out.
    expect(c.retryAfterMs).toBeGreaterThan(0);
    expect(c.retryAfterMs).toBeLessThanOrEqual(5000);
  });

  it("re-entrant acquire refreshes TTL without consuming a second slot", async () => {
    const { store, advance } = makeStore(storage);
    const first = await store.acquire({ leaseKey: "a", cap: 2, ttlMs: 5000 });
    advance(1000);
    const second = await store.acquire({ leaseKey: "a", cap: 2, ttlMs: 5000 });

    expect(second.granted).toBe(true);
    expect(second.activeCount).toBe(1); // not 2
    expect(second.leaseId).toBe(first.leaseId); // same lease
    expect(second.expiresAt).toBe((first.expiresAt as number) + 1000); // refreshed
  });

  it("release is idempotent (double-release is a no-op)", async () => {
    const { store } = makeStore(storage);
    await store.acquire({ leaseKey: "a", cap: 1, ttlMs: 5000 });

    const first = await store.release({ leaseKey: "a" });
    const second = await store.release({ leaseKey: "a" });

    expect(first).toEqual({ released: true, activeCount: 0 });
    expect(second).toEqual({ released: false, activeCount: 0 });
  });

  it("TTL expiry frees a leaked slot", async () => {
    const { store, advance } = makeStore(storage);
    const a = await store.acquire({ leaseKey: "a", cap: 1, ttlMs: 1000 });
    expect(a.granted).toBe(true);

    // At cap before expiry.
    const blocked = await store.acquire({ leaseKey: "b", cap: 1, ttlMs: 1000 });
    expect(blocked.granted).toBe(false);

    // After A's TTL lapses the slot is reclaimed.
    advance(1001);
    const afterExpiry = await store.acquire({ leaseKey: "b", cap: 1, ttlMs: 1000 });
    expect(afterExpiry.granted).toBe(true);
    expect(afterExpiry.activeCount).toBe(1);
  });

  it("currentActiveCount reports live leases, cap, and keys; lazily expires", async () => {
    const { store, advance } = makeStore(storage);
    await store.acquire({ leaseKey: "a", cap: 3, ttlMs: 1000 });
    await store.acquire({ leaseKey: "b", cap: 3, ttlMs: 1000 });

    const counted = await store.currentActiveCount();
    expect(counted.activeCount).toBe(2);
    expect(counted.cap).toBe(3);
    expect(counted.leaseKeys.sort()).toEqual(["a", "b"]);

    advance(1001);
    const afterExpiry = await store.currentActiveCount();
    expect(afterExpiry.activeCount).toBe(0);
    expect(afterExpiry.leaseKeys).toEqual([]);
  });

  it("renew extends a held lease and rejects an unheld/mismatched one", async () => {
    const { store, advance } = makeStore(storage);
    const notHeld = await store.renew({ leaseKey: "a", ttlMs: 5000 });
    expect(notHeld).toEqual({ ok: false, reason: "not_held" });

    const a = await store.acquire({ leaseKey: "a", cap: 1, ttlMs: 5000 });
    advance(1000);
    const renewed = await store.renew({ leaseKey: "a", ttlMs: 5000, leaseId: a.leaseId });
    expect(renewed).toEqual({ ok: true, expiresAt: 1_000_000 + 1000 + 5000 });

    const wrongFence = await store.renew({
      leaseKey: "a",
      ttlMs: 5000,
      leaseId: "not-the-lease-id",
    });
    expect(wrongFence).toEqual({ ok: false, reason: "not_held" });
  });

  it("release honors the leaseId fencing token", async () => {
    const { store } = makeStore(storage);
    const a = await store.acquire({ leaseKey: "a", cap: 1, ttlMs: 5000 });

    const wrong = await store.release({ leaseKey: "a", leaseId: "stale" });
    expect(wrong.released).toBe(false);
    expect(wrong.activeCount).toBe(1); // still held

    const right = await store.release({ leaseKey: "a", leaseId: a.leaseId });
    expect(right.released).toBe(true);
    expect(right.activeCount).toBe(0);
  });

  it("alarm sweep reclaims expired slots and clears the alarm when empty", async () => {
    const { store, advance } = makeStore(storage);
    await store.acquire({ leaseKey: "a", cap: 2, ttlMs: 1000 });
    expect(storage.alarm).not.toBeNull(); // alarm set to the expiry

    advance(1001);
    await store.sweep();

    const counted = await store.currentActiveCount();
    expect(counted.activeCount).toBe(0);
    expect(storage.alarm).toBeNull(); // no leases left → alarm cleared
  });
});

describe("ConcurrencyLeaseDO (fetch dispatch)", () => {
  it("dispatches acquire and returns the result", async () => {
    const storage = makeStorage();
    const durableObject = new ConcurrencyLeaseDO({ storage });
    const response = await durableObject.fetch(
      new Request("https://lease.internal/rpc", {
        method: "POST",
        body: JSON.stringify({ op: "acquire", leaseKey: "a", cap: 2, ttlMs: 5000 }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { granted: boolean; activeCount: number };
    expect(body.granted).toBe(true);
    expect(body.activeCount).toBe(1);
  });

  it("rejects an unknown op and invalid json with 400", async () => {
    const durableObject = new ConcurrencyLeaseDO({ storage: makeStorage() });

    const unknownOp = await durableObject.fetch(
      new Request("https://lease.internal/rpc", {
        method: "POST",
        body: JSON.stringify({ op: "nope" }),
      }),
    );
    expect(unknownOp.status).toBe(400);

    const badJson = await durableObject.fetch(
      new Request("https://lease.internal/rpc", { method: "POST", body: "{" }),
    );
    expect(badJson.status).toBe(400);
  });
});

describe("concurrency-lease config", () => {
  it("defaults cap and poolId, and honors env overrides", () => {
    expect(getCloudAgentWarmLeaseCap({})).toBe(DEFAULT_CLOUD_AGENT_WARM_LEASE_CAP);
    expect(getCloudAgentWarmLeaseCap({ CLOUD_AGENT_WARM_LEASE_CAP: "7" })).toBe(7);
    // invalid / non-positive falls back to the default.
    expect(getCloudAgentWarmLeaseCap({ CLOUD_AGENT_WARM_LEASE_CAP: "0" })).toBe(
      DEFAULT_CLOUD_AGENT_WARM_LEASE_CAP,
    );
    expect(getCloudAgentWarmLeaseCap({ CLOUD_AGENT_WARM_LEASE_CAP: "abc" })).toBe(
      DEFAULT_CLOUD_AGENT_WARM_LEASE_CAP,
    );

    expect(getCloudAgentWarmLeasePoolId({})).toBe(
      DEFAULT_CLOUD_AGENT_WARM_LEASE_POOL_ID,
    );
    expect(
      getCloudAgentWarmLeasePoolId({ CLOUD_AGENT_WARM_LEASE_POOL_ID: "pool:x" }),
    ).toBe("pool:x");
  });
});
