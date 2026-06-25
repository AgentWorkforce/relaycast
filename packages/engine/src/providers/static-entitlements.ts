import type { EntitlementsProvider, PlanLimits, UsageMetric, Workspace } from '../ports/index.js';
import type { KeyValueStore } from '../ports/kv.js';

/**
 * The default plan limits, lifted from the original `middleware/planLimits.ts`.
 * Self-host deployments typically run the `selfhost` tier (everything
 * unlimited); the free/pro/enterprise tiers are kept so the same code serves a
 * tiered deployment if a workspace's `plan` column is set.
 */
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { messages: 10_000, agents: 5, file_bytes: 100 * 1024 * 1024, api_calls: 100_000, rate_per_min: 300 },
  pro: { messages: 1_000_000, agents: 100, file_bytes: 50 * 1024 * 1024 * 1024, api_calls: 10_000_000, rate_per_min: 6000 },
  enterprise: { messages: Infinity, agents: Infinity, file_bytes: 500 * 1024 * 1024 * 1024, api_calls: Infinity, rate_per_min: 30000 },
  selfhost: { messages: Infinity, agents: Infinity, file_bytes: Infinity, api_calls: Infinity, rate_per_min: 30000 },
};

/**
 * Static, table-driven entitlements — the self-host default. Resolves limits
 * from {@link PLAN_LIMITS} keyed by `workspace.plan`, and reads usage counters
 * from the key/value store (the same `usage:<wid>:<metric>` keys the usage
 * tracker increments). The cloud product injects a billing-backed provider.
 */
export class StaticEntitlementsProvider implements EntitlementsProvider {
  constructor(
    private readonly kv?: KeyValueStore,
    private readonly defaultPlan: string = 'selfhost',
  ) {}

  async getLimits(workspace: Workspace): Promise<PlanLimits> {
    const plan = workspace.plan || this.defaultPlan;
    return PLAN_LIMITS[plan] ?? PLAN_LIMITS[this.defaultPlan];
  }

  async getUsage(workspaceId: string, metric: UsageMetric): Promise<number> {
    if (!this.kv) return 0;
    try {
      const raw = await this.kv.get(`usage:${workspaceId}:${metric}`);
      return parseInt(raw || '0', 10) || 0;
    } catch {
      return 0;
    }
  }
}
