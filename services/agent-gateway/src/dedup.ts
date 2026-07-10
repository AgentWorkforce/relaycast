const DEDUP_PREFIX = "dedup:";
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRUNE_LIMIT = 128;

type DedupRecord = {
  firstSeenAt: number;
  expiresAt: number;
};

export async function markEventSeen(
  storage: DurableObjectStorage,
  key: string,
  nowMs: number = Date.now(),
  windowMs: number = DEFAULT_WINDOW_MS,
): Promise<boolean> {
  const effectiveWindowMs = Number.isFinite(windowMs) && windowMs > 0
    ? windowMs
    : DEFAULT_WINDOW_MS;
  const storageKey = toStorageKey(key);
  const existing = await storage.get<DedupRecord>(storageKey);
  if (existing && existing.expiresAt > nowMs) {
    return false;
  }

  await storage.put(storageKey, {
    firstSeenAt: nowMs,
    expiresAt: nowMs + effectiveWindowMs,
  } satisfies DedupRecord);
  try {
    await pruneExpiredDedupEntries(storage, nowMs);
  } catch {
    // Best-effort maintenance; the dedup mark has already been committed.
  }
  return true;
}

export async function pruneExpiredDedupEntries(
  storage: DurableObjectStorage,
  nowMs: number = Date.now(),
  limit: number = DEFAULT_PRUNE_LIMIT,
): Promise<void> {
  const entries = await storage.list<DedupRecord>({
    prefix: DEDUP_PREFIX,
    limit,
  });

  const expiredKeys: string[] = [];
  for (const [key, value] of entries) {
    if (expiredKeys.length >= limit) {
      break;
    }
    if (!value || typeof value.expiresAt !== "number" || value.expiresAt <= nowMs) {
      expiredKeys.push(key);
    }
  }

  if (expiredKeys.length > 0) {
    await storage.delete(expiredKeys);
  }
}

function toStorageKey(key: string): string {
  const normalized = key.trim();
  if (!normalized) {
    throw new Error("dedup key is required");
  }
  return `${DEDUP_PREFIX}${normalized}`;
}
