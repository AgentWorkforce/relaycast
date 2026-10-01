/**
 * Usage tracking via key/value counters.
 * All functions accept a {@link KeyValueStore} port.
 */
import type { KeyValueStore } from '../ports/kv.js';

/**
 * Usage counters are scoped to a UTC calendar month, because plan quotas
 * (`api_calls`) are *per billing period*. An unscoped counter accumulates for
 * the lifetime of the workspace, so once it passes the plan ceiling every
 * authenticated request — including the `GET /v1/workspace` identity read a
 * client needs to diagnose the failure — returns 429 forever, with no window
 * that ever clears it and no retry policy that can absorb it.
 *
 * The period lives in the key, so rollover is the reset: nothing has to run on
 * a schedule and no adapter has to support expiry for the quota to be correct.
 */
export function usagePeriod(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function usageCounterKey(workspaceId: string, metric: string, at: Date = new Date()): string {
  return `usage:${workspaceId}:${metric}:${usagePeriod(at)}`;
}

/** Unix ms at which the current usage period rolls over (start of the next UTC month). */
export function usagePeriodResetAt(at: Date = new Date()): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
}

/**
 * A day of slack past rollover, so a counter written at the very end of a
 * period is still readable by a concurrent request that resolved the period a
 * moment earlier.
 */
const PERIOD_TTL_GRACE_SECONDS = 86_400;

/** TTL for a period counter — storage hygiene only; the key drives the reset. */
export function usagePeriodTtlSeconds(at: Date = new Date()): number {
  return Math.ceil((usagePeriodResetAt(at) - at.getTime()) / 1000) + PERIOD_TTL_GRACE_SECONDS;
}

export async function incrementUsage(kv: KeyValueStore, workspaceId: string, metric: string, amount: number = 1): Promise<number> {
  const at = new Date();
  // Atomic increment — avoids the lost-update race of a get→parse→put round-trip.
  return kv.increment(usageCounterKey(workspaceId, metric, at), amount, usagePeriodTtlSeconds(at));
}

export async function getUsageMetric(kv: KeyValueStore, workspaceId: string, metric: string): Promise<number> {
  const value = await kv.get(usageCounterKey(workspaceId, metric));
  return parseInt(value || '0', 10) || 0;
}
