import type { EntitlementsProvider, Limits, UsageMetric, Workspace } from '../ports/index.js';
import { resolveLimits } from '../ports/entitlements.js';
import type { EngineDb } from '../ports/database.js';
import type { KeyValueStore } from '../ports/kv.js';
import { getUsageMetric, usagePeriodResetAt } from '../engine/usage.js';
import { countRegistrations } from '../engine/planCapacity.js';

const REGISTRATION_METRICS = new Set<UsageMetric>(['devices', 'agents', 'humans']);
const REGISTRATION_CAPS = ['devices', 'agents', 'humans'] as const;

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
    // A cap the provider cannot count against would admit everything while
    // looking configured; refuse the misconfiguration up front.
    const uncountable = REGISTRATION_CAPS.filter((metric) => typeof this.limits[metric] === 'number');
    if (uncountable.length > 0 && !db) {
      throw new Error(
        `StaticEntitlementsProvider: registration caps (${uncountable.join(', ')}) require a database handle to count against`,
      );
    }
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
