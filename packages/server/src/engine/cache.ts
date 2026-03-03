const DEFAULT_TTL = 60_000; // 60 seconds for channel metadata (in ms)

export interface CachedChannel {
  id: string;
  name: string;
  topic: string | null;
  metadata: Record<string, unknown>;
  member_count: number;
  members: Array<{
    agent_id: string;
    agent_name: string;
    role: string;
    joined_at: string;
  }>;
  created_at: string;
  is_archived: boolean;
}

interface CacheEntry {
  data: CachedChannel;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function channelCacheKey(workspaceId: string, name: string): string {
  return `cache:ch:${workspaceId}:${name}`;
}

export async function getCachedChannel(workspaceId: string, name: string): Promise<CachedChannel | null> {
  try {
    const key = channelCacheKey(workspaceId, name);
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.data;
  } catch {
    return null;
  }
}

export async function setCachedChannel(workspaceId: string, name: string, data: CachedChannel): Promise<void> {
  try {
    const key = channelCacheKey(workspaceId, name);
    cache.set(key, { data, expiresAt: Date.now() + DEFAULT_TTL });
  } catch {
    // Cache write failures are non-critical
  }
}

export async function invalidateChannelCache(workspaceId: string, name: string): Promise<void> {
  try {
    const key = channelCacheKey(workspaceId, name);
    cache.delete(key);
  } catch {
    // Cache invalidation failures are non-critical
  }
}
