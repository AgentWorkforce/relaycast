import type { EntitlementsProvider, Limits, UsageMetric, Workspace } from '../ports/index.js';
import { resolveLimits } from '../ports/entitlements.js';
import type { EngineDb } from '../ports/database.js';
import type { KeyValueStore } from '../ports/kv.js';
import { getUsageMetric, usagePeriodResetAt } from '../engine/usage.js';
import { countRegistrations } from '../engine/planCapacity.js';

const REGISTRATION_METRICS = new Set<UsageMetric>(['devices', 'agents', 'humans']);

/**
 * Static entitlements — the self-host default. Every workspace gets the same
 * limits: unlimited unless the operator sets some through
 * `EngineConfig.limits`. Metered usage is read from the key/value store (the
 * same `usage:<wid>:<metric>:<period>` keys the usage tracker increments, so
 * both agree on the current billing period); registration metrics are counted
 * live from the database. The hosted product injects its own provider.
 */
export class StaticEntitlementsProvider implements EntitlementsProvider {
  private readonly limits: Limits;

  constructor(
    private readonly kv?: KeyValueStore,
    limits?: Partial<Limits> | null,
    private readonly db?: EngineDb,
  ) {
    this.limits = resolveLimits(limits);
  }

  async getLimits(_workspace: Workspace): Promise<Limits> {
    return this.limits;
  }

  async getUsage(workspaceId: string, metric: UsageMetric): Promise<number> {
    if (REGISTRATION_METRICS.has(metric)) {
      if (!this.db) return 0;
      return countRegistrations(this.db, workspaceId, metric as 'devices' | 'agents' | 'humans');
    }
    if (!this.kv) return 0;
    try {
      return await getUsageMetric(this.kv, workspaceId, metric);
    } catch {
      return 0;
    }
  }

  async getUsageResetAt(): Promise<number> {
    return usagePeriodResetAt();
  }
}
