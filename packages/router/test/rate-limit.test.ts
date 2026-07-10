import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetBypassExtrasCacheForTests,
  checkRateLimit,
  extractLimitKey,
  isBypassPath,
  isBypassPathDynamic,
  maybeRateLimit,
  parseBypassExtras,
  rateLimitResponse,
  RATE_LIMIT_CONFIG_KEYS,
  type RateLimitEnv,
} from "../src/rate-limit.js";

// Tiny in-memory KV shim. Counter increments only need get/put; we
// also store an optional `expirationTtl` so a future test could
// assert TTLs, though the current cases don't depend on it.
type StoredEntry = { value: string; expiresAt: number | null };

class MemoryKV {
  readonly store = new Map<string, StoredEntry>();
  private nowFn: () => number;

  constructor(nowFn: () => number = () => Date.now()) {
    this.nowFn = nowFn;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.nowFn()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void> {
    const ttl = options?.expirationTtl;
    const expiresAt =
      typeof ttl === "number" && ttl > 0 ? this.nowFn() + ttl * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  // Helpers — not part of the KVNamespace surface.
  size(): number {
    return this.store.size;
  }
}

function asKV(kv: MemoryKV): KVNamespace {
  return kv as unknown as KVNamespace;
}

function buildEnv(opts: {
  counters?: MemoryKV;
  config?: MemoryKV;
}): RateLimitEnv {
  return {
    RATE_LIMIT_COUNTERS: opts.counters ? asKV(opts.counters) : undefined,
    ROUTER_CONFIG: opts.config ? asKV(opts.config) : undefined,
  };
}

const FIXED_NOW = 1715683680000; // 2024-05-14T11:28:00Z — middle of an even minute
const fixedNow = () => FIXED_NOW;

describe("isBypassPath", () => {
  it.each([
    ["/api/health", true],
    ["/api/health/db", true],
    ["/health", true],
    ["/observer", true],
    ["/observer/session/abc", true],
    ["/_next/static/chunks/123.js", true],
    ["/favicon.ico", true],
    ["/v1/workspaces/ws_123/sync/status", false],
    ["/cloud/api/v1/workspaces/ws_123/sandboxes", false],
    ["/", false],
  ])("path %s bypass=%s", (path, expected) => {
    expect(isBypassPath(path)).toBe(expected);
  });
});

describe("extractLimitKey", () => {
  it("picks workspace id from /v1/workspaces/:id/...", () => {
    const req = new Request(
      "https://api.relayfile.dev/v1/workspaces/ws_abc123/sync/status",
    );
    expect(extractLimitKey(req)).toBe("ws:ws_abc123");
  });

  it("picks workspace id from /cloud/api/v1/workspaces/:id/...", () => {
    const req = new Request(
      "https://agentrelay.com/cloud/api/v1/workspaces/ws_xyz/sandboxes",
    );
    expect(extractLimitKey(req)).toBe("ws:ws_xyz");
  });

  it("hashes bearer token when no workspace path is present", () => {
    const req = new Request("https://agentrelay.com/cloud/api/v1/me", {
      headers: { authorization: "Bearer abcdef0123456789" },
    });
    const key = extractLimitKey(req);
    expect(key).toMatch(/^user:[0-9a-f]{8}$/);
  });

  it("buckets different tokens to different user keys", () => {
    const a = extractLimitKey(
      new Request("https://agentrelay.com/cloud/api/v1/me", {
        headers: { authorization: "Bearer aaaaaaaa" },
      }),
    );
    const b = extractLimitKey(
      new Request("https://agentrelay.com/cloud/api/v1/me", {
        headers: { authorization: "Bearer bbbbbbbb" },
      }),
    );
    expect(a).not.toBe(b);
    expect(a).toMatch(/^user:/);
    expect(b).toMatch(/^user:/);
  });

  it("falls back to cf-connecting-ip for anonymous traffic", () => {
    const req = new Request("https://agentrelay.com/", {
      headers: { "cf-connecting-ip": "203.0.113.5" },
    });
    expect(extractLimitKey(req)).toBe("ip:203.0.113.5");
  });

  it("prefers cf-connecting-ip over x-forwarded-for", () => {
    const req = new Request("https://agentrelay.com/", {
      headers: {
        "cf-connecting-ip": "203.0.113.5",
        "x-forwarded-for": "10.0.0.1, 10.0.0.2",
      },
    });
    expect(extractLimitKey(req)).toBe("ip:203.0.113.5");
  });

  it("uses x-forwarded-for first hop when cf-connecting-ip is missing", () => {
    const req = new Request("https://agentrelay.com/", {
      headers: { "x-forwarded-for": "10.0.0.1, 10.0.0.2" },
    });
    expect(extractLimitKey(req)).toBe("ip:10.0.0.1");
  });

  it("keys off session cookie for /cloud* traffic with no auth header", () => {
    const req = new Request("https://agentrelay.com/cloud/api/v1/me", {
      headers: { cookie: "agent_relay_session=mysecrettoken123" },
    });
    const key = extractLimitKey(req);
    expect(key).toMatch(/^session:[0-9a-f]{8}$/);
  });

  it("auth header takes priority over session cookie", () => {
    const req = new Request("https://agentrelay.com/cloud/api/v1/me", {
      headers: {
        authorization: "Bearer bearertoken999",
        cookie: "agent_relay_session=mysecrettoken123",
      },
    });
    const key = extractLimitKey(req);
    // auth header wins — produces a user: key, not session:
    expect(key).toMatch(/^user:[0-9a-f]{8}$/);
  });

  it("buckets different session cookie values to different session keys", () => {
    const a = extractLimitKey(
      new Request("https://agentrelay.com/cloud/api/v1/me", {
        headers: { cookie: "agent_relay_session=tokenA" },
      }),
    );
    const b = extractLimitKey(
      new Request("https://agentrelay.com/cloud/api/v1/me", {
        headers: { cookie: "agent_relay_session=tokenB" },
      }),
    );
    expect(a).not.toBe(b);
    expect(a).toMatch(/^session:/);
    expect(b).toMatch(/^session:/);
  });

  it("/cloud* with no cookie and no auth falls back to IP", () => {
    const req = new Request("https://agentrelay.com/cloud/api/v1/me", {
      headers: { "cf-connecting-ip": "198.51.100.1" },
    });
    expect(extractLimitKey(req)).toBe("ip:198.51.100.1");
  });

  it("/cloud* with no cookie, no auth, no IP falls back to anon", () => {
    const req = new Request("https://agentrelay.com/cloud/api/v1/me");
    expect(extractLimitKey(req)).toBe("anon");
  });

  it("falls back to anon when no signal is present", () => {
    const req = new Request("https://agentrelay.com/");
    expect(extractLimitKey(req)).toBe("anon");
  });
});

describe("checkRateLimit", () => {
  let counters: MemoryKV;
  let config: MemoryKV;
  let env: RateLimitEnv;

  beforeEach(() => {
    counters = new MemoryKV(fixedNow);
    config = new MemoryKV(fixedNow);
    env = buildEnv({ counters, config });
  });

  it("allows requests under the per-key limit", async () => {
    for (let i = 1; i <= 5; i++) {
      const result = await checkRateLimit("ws:demo", env, { now: fixedNow });
      expect(result.allowed).toBe(true);
      expect(result.counter).toBe(i);
    }
  });

  it("returns 429 once the per-key limit is exceeded", async () => {
    // Pin the per-workspace limit low for deterministic assertions.
    await config.put(RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN, "3");

    // Sequential calls — the in-memory KV shim mirrors a single edge
    // processing requests in order. KV's eventual consistency across
    // edges is acknowledged in the module-level docstring but is not
    // what this test asserts.
    const results = [
      await checkRateLimit("ws:demo", env, { now: fixedNow }),
      await checkRateLimit("ws:demo", env, { now: fixedNow }),
      await checkRateLimit("ws:demo", env, { now: fixedNow }),
    ];
    expect(results.map((r) => r.allowed)).toEqual([true, true, true]);

    const blocked = await checkRateLimit("ws:demo", env, { now: fixedNow });
    expect(blocked.allowed).toBe(false);
    expect(blocked.counter).toBe(4);
    expect(blocked.limit).toBe(3);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(60);
    expect(blocked.key).toBe("ws:demo");
  });

  it("does not pollute the global counter on a per-key reject", async () => {
    await config.put(RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN, "1");
    await checkRateLimit("ws:a", env, { now: fixedNow });
    const blocked = await checkRateLimit("ws:a", env, { now: fixedNow });
    expect(blocked.allowed).toBe(false);

    // Verify the global counter only ever incremented once (for the
    // single allowed request) — the blocked one should NOT have
    // incremented it. This is intentional so a single misbehaving
    // key can't push the global ceiling around.
    const bucket = Math.floor(FIXED_NOW / 1000 / 60);
    const stored = await counters.get(`rl:__global__:${bucket}`);
    expect(stored).toBe("1");
  });

  it("returns 429 once the global limit is exceeded", async () => {
    await config.put(RATE_LIMIT_CONFIG_KEYS.GLOBAL_PER_MIN, "2");
    await config.put(RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN, "10");

    expect(
      (await checkRateLimit("ws:a", env, { now: fixedNow })).allowed,
    ).toBe(true);
    expect(
      (await checkRateLimit("ws:b", env, { now: fixedNow })).allowed,
    ).toBe(true);

    const blocked = await checkRateLimit("ws:c", env, { now: fixedNow });
    expect(blocked.allowed).toBe(false);
    // Global rejects surface the synthetic `__global__` key so the
    // 429 body tells operators it's the global ceiling, not the
    // per-key one.
    expect(blocked.key).toBe("__global__");
  });

  it("respects RATE_LIMIT_DISABLED kill switch", async () => {
    await config.put(RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN, "1");
    await config.put(RATE_LIMIT_CONFIG_KEYS.DISABLED, "true");

    // Even though the limit is 1, the kill switch should let
    // unlimited requests through.
    for (let i = 0; i < 5; i++) {
      const result = await checkRateLimit("ws:demo", env, { now: fixedNow });
      expect(result.allowed).toBe(true);
    }
    // No counter writes when disabled — saves KV operations.
    expect(counters.size()).toBe(0);
  });

  it("resets per minute (different bucket)", async () => {
    await config.put(RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN, "2");

    const firstMinute = fixedNow;
    const secondMinute = () => FIXED_NOW + 60_000;

    expect(
      (await checkRateLimit("ws:demo", env, { now: firstMinute })).allowed,
    ).toBe(true);
    expect(
      (await checkRateLimit("ws:demo", env, { now: firstMinute })).allowed,
    ).toBe(true);
    expect(
      (await checkRateLimit("ws:demo", env, { now: firstMinute })).allowed,
    ).toBe(false);

    // Roll forward one full minute — bucket key changes, counter
    // starts over.
    const reset = await checkRateLimit("ws:demo", env, { now: secondMinute });
    expect(reset.allowed).toBe(true);
    expect(reset.counter).toBe(1);
  });

  it("falls back to defaults when ROUTER_CONFIG is unbound", async () => {
    const noConfigEnv = buildEnv({ counters });
    const result = await checkRateLimit("ws:demo", noConfigEnv, {
      now: fixedNow,
    });
    expect(result.allowed).toBe(true);
    expect(result.limit).toBe(60); // DEFAULT_PER_KEY_PER_MIN
  });

  it("treats missing RATE_LIMIT_COUNTERS as allow-all (fail open)", async () => {
    const noCounterEnv = buildEnv({ config });
    await config.put(RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN, "1");
    // Without a counter store we cannot enforce, so behavior is
    // intentionally permissive (the limit is documented as
    // best-effort). This guards against a missing binding silently
    // breaking the data plane.
    for (let i = 0; i < 10; i++) {
      expect(
        (await checkRateLimit("ws:demo", noCounterEnv, { now: fixedNow }))
          .allowed,
      ).toBe(true);
    }
  });
});

describe("rateLimitResponse", () => {
  it("emits a 429 with the documented shape", async () => {
    const res = rateLimitResponse(42, "ws:demo");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(res.headers.get("x-ratelimit-key")).toBe("ws:demo");
    expect(res.headers.get("content-type")).toBe("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      error: "rate_limited",
      retryAfter: 42,
      limitKey: "ws:demo",
    });
  });
});

describe("maybeRateLimit", () => {
  it("returns null for bypass paths without touching KV", async () => {
    const counters = new MemoryKV(fixedNow);
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ counters, config });

    const result = await maybeRateLimit(
      new Request("https://api.relayfile.dev/health"),
      env,
      { now: fixedNow },
    );
    expect(result).toBeNull();
    expect(counters.size()).toBe(0);
  });

  it("returns null when under the limit", async () => {
    const counters = new MemoryKV(fixedNow);
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ counters, config });

    const result = await maybeRateLimit(
      new Request("https://api.relayfile.dev/v1/workspaces/ws_a/sync/status"),
      env,
      { now: fixedNow },
    );
    expect(result).toBeNull();
  });

  it("returns a 429 once limit is exceeded", async () => {
    const counters = new MemoryKV(fixedNow);
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ counters, config });
    await config.put(RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN, "1");

    const url =
      "https://api.relayfile.dev/v1/workspaces/ws_a/sync/status";
    const first = await maybeRateLimit(new Request(url), env, {
      now: fixedNow,
    });
    expect(first).toBeNull();

    const blocked = await maybeRateLimit(new Request(url), env, {
      now: fixedNow,
    });
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get("x-ratelimit-key")).toBe("ws:ws_a");
  });
});

describe("parseBypassExtras", () => {
  it("returns empty array for null / empty input", () => {
    expect(parseBypassExtras(null)).toEqual([]);
    expect(parseBypassExtras("")).toEqual([]);
    expect(parseBypassExtras("   ")).toEqual([]);
  });

  it("parses comma-separated absolute paths", () => {
    expect(parseBypassExtras("/api/k8s-readiness,/internal/uptime")).toEqual([
      "/api/k8s-readiness",
      "/internal/uptime",
    ]);
  });

  it("trims whitespace around entries", () => {
    expect(parseBypassExtras(" /a , /b , /c ")).toEqual(["/a", "/b", "/c"]);
  });

  it("ignores entries that don't start with /", () => {
    // Defensive: bad operator input shouldn't poison the list.
    expect(parseBypassExtras("/ok,not-a-path,/also-ok")).toEqual([
      "/ok",
      "/also-ok",
    ]);
  });

  it("dedupes repeated entries", () => {
    expect(parseBypassExtras("/x,/x,/y,/x")).toEqual(["/x", "/y"]);
  });
});

describe("isBypassPathDynamic", () => {
  beforeEach(() => {
    __resetBypassExtrasCacheForTests();
  });

  it("returns true for static bypass paths without touching KV", async () => {
    const env = buildEnv({}); // no ROUTER_CONFIG bound
    expect(await isBypassPathDynamic("/api/health", env, FIXED_NOW)).toBe(true);
    expect(await isBypassPathDynamic("/observer/foo", env, FIXED_NOW)).toBe(
      true,
    );
  });

  it("returns false for non-bypass paths when no KV extras set", async () => {
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ config });
    expect(
      await isBypassPathDynamic("/v1/workspaces/ws_a/sync/status", env, FIXED_NOW),
    ).toBe(false);
  });

  it("respects KV-configured extras (exact match)", async () => {
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ config });
    await config.put(
      RATE_LIMIT_CONFIG_KEYS.BYPASS_PREFIXES_EXTRA,
      "/api/k8s-readiness",
    );
    expect(
      await isBypassPathDynamic("/api/k8s-readiness", env, FIXED_NOW),
    ).toBe(true);
  });

  it("respects KV-configured extras (prefix match)", async () => {
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ config });
    await config.put(
      RATE_LIMIT_CONFIG_KEYS.BYPASS_PREFIXES_EXTRA,
      "/internal/uptime",
    );
    expect(
      await isBypassPathDynamic("/internal/uptime/check", env, FIXED_NOW),
    ).toBe(true);
  });

  it("caches KV reads for 60s (does not re-read on every call)", async () => {
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ config });
    await config.put(
      RATE_LIMIT_CONFIG_KEYS.BYPASS_PREFIXES_EXTRA,
      "/api/k8s-readiness",
    );

    // Count KV reads by wrapping the real one.
    let reads = 0;
    const originalGet = env.ROUTER_CONFIG!.get.bind(env.ROUTER_CONFIG!);
    env.ROUTER_CONFIG!.get = ((k: string) => {
      reads++;
      return originalGet(k);
    }) as NonNullable<RateLimitEnv["ROUTER_CONFIG"]>["get"];

    // First call hits KV.
    await isBypassPathDynamic("/v1/x", env, FIXED_NOW);
    expect(reads).toBe(1);
    // Second call within 60s reuses the cache.
    await isBypassPathDynamic("/v1/y", env, FIXED_NOW + 30_000);
    expect(reads).toBe(1);
    // Past the TTL boundary, fetches again.
    await isBypassPathDynamic("/v1/z", env, FIXED_NOW + 61_000);
    expect(reads).toBe(2);
  });

  it("falls back to last-known list on KV transient errors", async () => {
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ config });
    await config.put(
      RATE_LIMIT_CONFIG_KEYS.BYPASS_PREFIXES_EXTRA,
      "/cached-ok",
    );

    // Warm the cache once.
    await isBypassPathDynamic("/v1/x", env, FIXED_NOW);
    expect(await isBypassPathDynamic("/cached-ok", env, FIXED_NOW)).toBe(true);

    // Now break the KV. After TTL expiry the read will throw — we
    // should fall back to the cached value rather than crashing.
    env.ROUTER_CONFIG!.get = (() => {
      throw new Error("KV unavailable");
    }) as NonNullable<RateLimitEnv["ROUTER_CONFIG"]>["get"];

    expect(
      await isBypassPathDynamic("/cached-ok", env, FIXED_NOW + 120_000),
    ).toBe(true);
  });

  it("static and dynamic bypass coexist (static still works with KV extras present)", async () => {
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ config });
    await config.put(
      RATE_LIMIT_CONFIG_KEYS.BYPASS_PREFIXES_EXTRA,
      "/internal/uptime",
    );
    // Static + dynamic both bypass.
    expect(await isBypassPathDynamic("/api/health", env, FIXED_NOW)).toBe(true);
    expect(
      await isBypassPathDynamic("/internal/uptime", env, FIXED_NOW),
    ).toBe(true);
  });
});

describe("maybeRateLimit honors KV bypass extras", () => {
  beforeEach(() => {
    __resetBypassExtrasCacheForTests();
  });

  it("bypasses a runtime-whitelisted path", async () => {
    const counters = new MemoryKV(fixedNow);
    const config = new MemoryKV(fixedNow);
    const env = buildEnv({ counters, config });
    // Tight limit so anything not bypassed would 429 on call #2.
    await config.put(RATE_LIMIT_CONFIG_KEYS.PER_KEY_PER_MIN, "1");
    await config.put(
      RATE_LIMIT_CONFIG_KEYS.BYPASS_PREFIXES_EXTRA,
      "/api/k8s-readiness",
    );

    // Hit a non-bypassed path twice → second call 429s.
    const url = "https://api.relayfile.dev/v1/workspaces/ws_a/sync/status";
    await maybeRateLimit(new Request(url), env, { now: fixedNow });
    const blocked = await maybeRateLimit(new Request(url), env, {
      now: fixedNow,
    });
    expect(blocked!.status).toBe(429);

    // Hit the runtime-whitelisted path 5 times → never 429s, regardless
    // of the very tight per-key limit.
    for (let i = 0; i < 5; i++) {
      const r = await maybeRateLimit(
        new Request("https://api.relayfile.dev/api/k8s-readiness"),
        env,
        { now: fixedNow },
      );
      expect(r).toBeNull();
    }
  });
});
