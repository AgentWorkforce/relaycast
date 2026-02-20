/**
 * Usage tracking via KV counters (replaces Redis-based counters).
 * All functions accept a KVNamespace binding.
 */

export async function incrementUsage(kv: KVNamespace, workspaceId: string, metric: string, amount: number = 1): Promise<number> {
  const key = `usage:${workspaceId}:${metric}`;
  const current = parseInt(await kv.get(key) || '0', 10);
  const next = current + amount;
  await kv.put(key, String(next));
  return next;
}

export async function getUsageCounters(kv: KVNamespace, workspaceId: string) {
  const metrics = ['messages', 'api_calls', 'files', 'file_bytes', 'ws_minutes'];
  const values = await Promise.all(
    metrics.map(m => kv.get(`usage:${workspaceId}:${m}`)),
  );
  return {
    messages: parseInt(values[0] || '0', 10),
    api_calls: parseInt(values[1] || '0', 10),
    files: parseInt(values[2] || '0', 10),
    file_bytes: parseInt(values[3] || '0', 10),
    ws_minutes: parseInt(values[4] || '0', 10),
  };
}

export async function resetUsageCounters(kv: KVNamespace, workspaceId: string): Promise<void> {
  const metrics = ['messages', 'api_calls', 'files', 'file_bytes', 'ws_minutes'];
  await Promise.all(
    metrics.map(m => kv.delete(`usage:${workspaceId}:${m}`)),
  );
}

export async function getUsageMetric(kv: KVNamespace, workspaceId: string, metric: string): Promise<number> {
  const value = await kv.get(`usage:${workspaceId}:${metric}`);
  return parseInt(value || '0', 10);
}
