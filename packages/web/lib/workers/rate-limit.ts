type RateLimitEntry = {
  hits: number[];
};

declare global {
  // TODO: Replace this in-memory register limiter with Redis for multi-instance deployments.
  var __workerRateLimitStore: Map<string, RateLimitEntry> | undefined;
}

function getStore(): Map<string, RateLimitEntry> {
  if (!globalThis.__workerRateLimitStore) {
    globalThis.__workerRateLimitStore = new Map();
  }
  return globalThis.__workerRateLimitStore;
}

export function consumeRateLimit(key: string, limit: number, windowMs: number): {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
} {
  const store = getStore();
  const now = Date.now();
  const windowStart = now - windowMs;
  const entry = store.get(key) ?? { hits: [] };
  entry.hits = entry.hits.filter((timestamp) => timestamp > windowStart);

  if (entry.hits.length >= limit) {
    const retryAfterMs = Math.max(0, windowMs - (now - entry.hits[0]));
    store.set(key, entry);
    return {
      allowed: false,
      remaining: 0,
      retryAfterMs,
    };
  }

  entry.hits.push(now);
  store.set(key, entry);
  return {
    allowed: true,
    remaining: Math.max(0, limit - entry.hits.length),
    retryAfterMs: 0,
  };
}
