import { getRedis } from '../redis/index.js';

export async function incrementUsage(workspaceId: string, metric: string, amount: number = 1): Promise<number> {
  const redis = getRedis();
  return await redis.incrby(`usage:${workspaceId}:${metric}`, amount);
}

export async function getUsageCounters(workspaceId: string) {
  const redis = getRedis();
  const keys = ['messages', 'api_calls', 'files', 'file_bytes', 'ws_minutes'].map(m => `usage:${workspaceId}:${m}`);
  const values = await redis.mget(...keys);
  return {
    messages: parseInt(values[0] || '0', 10),
    api_calls: parseInt(values[1] || '0', 10),
    files: parseInt(values[2] || '0', 10),
    file_bytes: parseInt(values[3] || '0', 10),
    ws_minutes: parseInt(values[4] || '0', 10),
  };
}

export async function resetUsageCounters(workspaceId: string): Promise<void> {
  const redis = getRedis();
  const keys = ['messages', 'api_calls', 'files', 'file_bytes', 'ws_minutes'].map(m => `usage:${workspaceId}:${m}`);
  await redis.del(...keys);
}

export async function getUsageMetric(workspaceId: string, metric: string): Promise<number> {
  const redis = getRedis();
  const value = await redis.get(`usage:${workspaceId}:${metric}`);
  return parseInt(value || '0', 10);
}
