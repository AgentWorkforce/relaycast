/**
 * Usage tracking via key/value counters.
 * All functions accept a {@link KeyValueStore} port.
 */
import type { KeyValueStore } from '../ports/kv.js';

export async function incrementUsage(kv: KeyValueStore, workspaceId: string, metric: string, amount: number = 1): Promise<number> {
  // Atomic increment — avoids the lost-update race of a get→parse→put round-trip.
  return kv.increment(`usage:${workspaceId}:${metric}`, amount);
}

export async function getUsageCounters(kv: KeyValueStore, workspaceId: string) {
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

export async function resetUsageCounters(kv: KeyValueStore, workspaceId: string): Promise<void> {
  const metrics = ['messages', 'api_calls', 'files', 'file_bytes', 'ws_minutes'];
  await Promise.all(
    metrics.map(m => kv.delete(`usage:${workspaceId}:${m}`)),
  );
}

export async function getUsageMetric(kv: KeyValueStore, workspaceId: string, metric: string): Promise<number> {
  const value = await kv.get(`usage:${workspaceId}:${metric}`);
  return parseInt(value || '0', 10);
}
