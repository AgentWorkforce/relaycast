import type { Workspace } from './auth.js';

export type UsageMetric = 'messages' | 'agents' | 'file_bytes' | 'api_calls';

export interface PlanLimits {
  messages: number;
  agents: number;
  file_bytes: number;
  /** Total authenticated API calls allowed for the current billing window. */
  api_calls: number;
  /** Global requests-per-minute ceiling, fed into the rate limiter. */
  rate_per_min: number;
}

/**
 * Pluggable plan limits / usage — the billing seam.
 *
 * Self-host uses `StaticEntitlementsProvider`, seeded from today's hardcoded
 * `PLAN_LIMITS` (free/pro/enterprise), defaulting single-tenant deployments to a
 * generous/unlimited tier. The cloud product injects a provider that resolves
 * quotas from its billing system (e.g. a Stripe subscription) per workspace and
 * reports metered usage.
 */
export interface EntitlementsProvider {
  /** Resolve the active plan limits for a workspace. */
  getLimits(workspace: Workspace): Promise<PlanLimits>;

  /** Current usage for a metric, compared against the limit before allowing an action. */
  getUsage(workspaceId: string, metric: UsageMetric): Promise<number>;
}
