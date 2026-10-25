import type { EntitlementsProvider, PlanLimits, UsageMetric, Workspace } from '../ports/index.js';
import type { EngineDb } from '../ports/database.js';
import type { KeyValueStore } from '../ports/kv.js';
import { getUsageMetric, usagePeriodResetAt } from '../engine/usage.js';
import { applyWorkspacePlanLimits, countRegistrations } from '../engine/planCapacity.js';

const GiB = 1024 * 1024 * 1024;

/**
 * The default plan limits. Self-host deployments typically run the `selfhost`
 * tier (everything unlimited).
 *
 * `intro`, `pro` and `enterprise` are the hosted billing tiers; their
 * `devices`/`agents`/`humans` caps are hard registration limits. `free` and
 * `connect` are legacy hosted tiers that predate registration caps and carry
 * none, so a workspace that was never moved onto a billing tier is never
 * refused a registration.
 */
export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free: { messages: 10_000, agents: Infinity, file_bytes: 100 * 1024 * 1024, api_calls: 100_000, rate_per_min: 300, devices: null, humans: null },
  // Short-lived collaboration rooms (Relay Connect): a handful of seats that
  // poll their inbox continuously, so api_calls dominates while messages stay
  // low. Sized for a two-seat room polling every few seconds for a full month.
  connect: { messages: 100_000, agents: Infinity, file_bytes: 1 * GiB, api_calls: 10_000_000, rate_per_min: 1200, devices: null, humans: null },
  intro: { messages: 1_000_000, agents: 15, file_bytes: 50 * GiB, api_calls: 10_000_000, rate_per_min: 6000, devices: 5, humans: 2 },
  pro: { messages: 1_000_000, agents: 60, file_bytes: 50 * GiB, api_calls: 10_000_000, rate_per_min: 6000, devices: 15, humans: 10 },
  enterprise: { messages: Infinity, agents: Infinity, file_bytes: 500 * GiB, api_calls: Infinity, rate_per_min: 30000, devices: null, humans: null },
  selfhost: { messages: Infinity, agents: Infinity, file_bytes: Infinity, api_calls: Infinity, rate_per_min: 30000, devices: null, humans: null },
};

const REGISTRATION_METRICS = new Set<UsageMetric>(['devices', 'agents', 'humans']);

/**
 * Static, table-driven entitlements — the self-host default. Resolves limits
 * from {@link PLAN_LIMITS} keyed by `workspace.plan`, overlaid with the row's
 * own `plan_limits` overrides, and reads usage counters from the key/value
 * store (the same `usage:<wid>:<metric>:<period>` keys the usage tracker
 * increments, so both agree on the current billing period). Registration
 * metrics are counted live from the database. The cloud product injects a
 * billing-backed provider.
 */
export class StaticEntitlementsProvider implements EntitlementsProvider {
  constructor(
    private readonly kv?: KeyValueStore,
    private readonly defaultPlan: string = 'selfhost',
    private readonly db?: EngineDb,
  ) {}

  async getLimits(workspace: Workspace): Promise<PlanLimits> {
    const plan = workspace.plan || this.defaultPlan;
    const base = PLAN_LIMITS[plan] ?? PLAN_LIMITS[this.defaultPlan]!;
    return applyWorkspacePlanLimits(base, workspace.planLimits);
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
