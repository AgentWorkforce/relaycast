/**
 * Generic concurrency-lease core (issue #1384 slice 3c / #1449).
 *
 * Transport-agnostic, runtime-agnostic lease logic shared by the Durable
 * Object wrapper (`concurrency-lease-do.ts`) and exercised directly in unit
 * tests. It holds NO Cloudflare types — it talks to a minimal `LeaseStorage`
 * shape that `DurableObjectStorage` satisfies structurally.
 *
 * One `LeaseStore` instance backs one lease POOL (= one cap SCOPE instance,
 * addressed by the consumer's `poolId` via `idFromName`). Within a pool, up to
 * `cap` distinct `leaseKey`s may hold a slot. The cap VALUE and SCOPE are
 * supplied by the caller — never baked in — so the (currently unresolved)
 * real cap surface swaps in via config with no code change.
 */

export type LeaseRecord = {
  leaseId: string;
  expiresAt: number;
  meta?: Record<string, string>;
};

export type LeaseMap = Record<string, LeaseRecord>;

/**
 * Minimal durable key/value + alarm surface. `DurableObjectStorage` satisfies
 * this structurally, and the unit tests provide an in-memory implementation.
 */
export interface LeaseStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export type AcquireResult = {
  granted: boolean;
  leaseId?: string;
  activeCount: number;
  cap: number;
  expiresAt?: number;
  retryAfterMs?: number;
};

export type RenewResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: "not_held" };

export type ReleaseResult = { released: boolean; activeCount: number };

export type CountResult = {
  activeCount: number;
  cap: number | null;
  leaseKeys: string[];
};

const LEASES_KEY = "leases";
const CAP_SEEN_KEY = "cap_seen";
const MIN_RETRY_AFTER_MS = 1000;

export class LeaseStore {
  constructor(
    private readonly storage: LeaseStorage,
    private readonly now: () => number = () => Date.now(),
    private readonly newLeaseId: () => string = () =>
      globalThis.crypto.randomUUID(),
  ) {}

  private async load(): Promise<LeaseMap> {
    return (await this.storage.get<LeaseMap>(LEASES_KEY)) ?? {};
  }

  /** Drop expired leases in place (the crashed-holder-doesn't-leak-a-slot rule). */
  private prune(leases: LeaseMap, now: number): LeaseMap {
    for (const [key, record] of Object.entries(leases)) {
      if (record.expiresAt <= now) {
        delete leases[key];
      }
    }
    return leases;
  }

  private count(leases: LeaseMap): number {
    return Object.keys(leases).length;
  }

  /**
   * Persist the lease map and re-point the alarm at the soonest expiry so a
   * leaked slot is reclaimed even with no further traffic.
   */
  private async persist(leases: LeaseMap): Promise<void> {
    await this.storage.put(LEASES_KEY, leases);
    const expiries = Object.values(leases).map((record) => record.expiresAt);
    if (expiries.length === 0) {
      await this.storage.deleteAlarm();
      return;
    }
    await this.storage.setAlarm(Math.min(...expiries));
  }

  async acquire(input: {
    leaseKey: string;
    cap: number;
    ttlMs: number;
    meta?: Record<string, string>;
  }): Promise<AcquireResult> {
    const now = this.now();
    const leases = this.prune(await this.load(), now);
    await this.storage.put(CAP_SEEN_KEY, input.cap);

    // Re-entrant / heartbeat: re-acquiring a held key refreshes its TTL and
    // does NOT consume a second slot.
    const existing = leases[input.leaseKey];
    if (existing) {
      existing.expiresAt = now + input.ttlMs;
      if (input.meta) {
        existing.meta = input.meta;
      }
      await this.persist(leases);
      return {
        granted: true,
        leaseId: existing.leaseId,
        activeCount: this.count(leases),
        cap: input.cap,
        expiresAt: existing.expiresAt,
      };
    }

    const activeCount = this.count(leases);
    if (activeCount >= input.cap) {
      const expiries = Object.values(leases).map((record) => record.expiresAt);
      const retryAfterMs =
        expiries.length > 0
          ? Math.max(MIN_RETRY_AFTER_MS, Math.min(...expiries) - now)
          : MIN_RETRY_AFTER_MS;
      await this.persist(leases);
      return { granted: false, activeCount, cap: input.cap, retryAfterMs };
    }

    const leaseId = this.newLeaseId();
    const expiresAt = now + input.ttlMs;
    leases[input.leaseKey] = {
      leaseId,
      expiresAt,
      ...(input.meta ? { meta: input.meta } : {}),
    };
    await this.persist(leases);
    return {
      granted: true,
      leaseId,
      activeCount: this.count(leases),
      cap: input.cap,
      expiresAt,
    };
  }

  async renew(input: {
    leaseKey: string;
    ttlMs: number;
    leaseId?: string;
  }): Promise<RenewResult> {
    const now = this.now();
    const leases = this.prune(await this.load(), now);
    const existing = leases[input.leaseKey];
    if (!existing || (input.leaseId && existing.leaseId !== input.leaseId)) {
      await this.persist(leases);
      return { ok: false, reason: "not_held" };
    }
    existing.expiresAt = now + input.ttlMs;
    await this.persist(leases);
    return { ok: true, expiresAt: existing.expiresAt };
  }

  /** Idempotent: releasing an unheld/expired/already-released key is a no-op. */
  async release(input: {
    leaseKey: string;
    leaseId?: string;
  }): Promise<ReleaseResult> {
    const now = this.now();
    const leases = this.prune(await this.load(), now);
    const existing = leases[input.leaseKey];
    if (existing && (!input.leaseId || existing.leaseId === input.leaseId)) {
      delete leases[input.leaseKey];
      await this.persist(leases);
      return { released: true, activeCount: this.count(leases) };
    }
    await this.persist(leases);
    return { released: false, activeCount: this.count(leases) };
  }

  async currentActiveCount(): Promise<CountResult> {
    const now = this.now();
    const leases = this.prune(await this.load(), now);
    const capSeen = (await this.storage.get<number>(CAP_SEEN_KEY)) ?? null;
    await this.persist(leases);
    return {
      activeCount: this.count(leases),
      cap: capSeen,
      leaseKeys: Object.keys(leases),
    };
  }

  /** Alarm-driven sweep so currentActiveCount stays honest without traffic. */
  async sweep(): Promise<void> {
    const now = this.now();
    const leases = this.prune(await this.load(), now);
    await this.persist(leases);
  }
}
