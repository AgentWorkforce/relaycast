import { getRedis } from '../redis/index.js';

const DEFAULT_TTL = 60; // 60 seconds for channel metadata
const AGENT_TTL = 300; // 5 minutes for agent lookups

export interface CachedChannel {
  id: string;
  name: string;
  topic: string | null;
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

function channelCacheKey(workspaceId: string, name: string): string {
  return `cache:ch:${workspaceId}:${name}`;
}

function agentNameCacheKey(workspaceId: string, name: string): string {
  return `cache:agent:name:${workspaceId}:${name}`;
}

export async function getCachedChannel(workspaceId: string, name: string): Promise<CachedChannel | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(channelCacheKey(workspaceId, name));
    if (!raw) return null;
    return JSON.parse(raw) as CachedChannel;
  } catch {
    return null;
  }
}

export async function setCachedChannel(workspaceId: string, name: string, data: CachedChannel): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(channelCacheKey(workspaceId, name), JSON.stringify(data), 'EX', DEFAULT_TTL);
  } catch {
    // Cache write failures are non-critical
  }
}

export async function invalidateChannelCache(workspaceId: string, name: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(channelCacheKey(workspaceId, name));
  } catch {
    // Cache invalidation failures are non-critical
  }
}

export async function getCachedAgentByName(workspaceId: string, name: string): Promise<Record<string, unknown> | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(agentNameCacheKey(workspaceId, name));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setCachedAgentByName(workspaceId: string, name: string, data: Record<string, unknown>): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(agentNameCacheKey(workspaceId, name), JSON.stringify(data), 'EX', AGENT_TTL);
  } catch {
    // Cache write failures are non-critical
  }
}

export async function invalidateAgentCache(workspaceId: string, name: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(agentNameCacheKey(workspaceId, name));
  } catch {
    // Cache invalidation failures are non-critical
  }
}
