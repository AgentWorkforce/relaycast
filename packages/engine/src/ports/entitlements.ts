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
  /**
   * One-time message allowance that never resets. When set to a finite number,
   * message sends (channel posts, DMs, group DMs, thread replies) are refused
   * with `plan_limit_exceeded` once the workspace has sent this many messages
   * over its whole lifetime. Unset (or `Infinity`) means no lifetime cap — the
   * case for every tier except a hosted anonymous trial.
   */
  lifetime_messages?: number;
}

/**
 * Where a workspace that hit a limit should go next. Returned by
 * {@link EntitlementsProvider.getUpgradeGuidance} and surfaced on the
 * `plan_limit_exceeded` error body as `upgrade_url` / `upgrade_action`.
 */
export interface UpgradeGuidance {
  /** An absolute URL the caller can open to lift the limit. */
  url: string;
  /** `sign_in` when signing in (free) lifts the limit, `upgrade` when a paid plan does. */
  action: 'sign_in' | 'upgrade';
  /** Effective plan name to report, when it differs from the stored `workspace.plan`. */
  plan?: string;
  /** One sentence appended to the error message, e.g. how to sign in. */
  hint?: string;
}

/**
 * Pluggable plan limits / usage — the billing seam.
 *
 * Self-host uses `StaticEntitlementsProvider`, seeded from today's hardcoded
 * `PLAN_LIMITS` (free/connect/pro/enterprise), defaulting single-tenant deployments to a
 * generous/unlimited tier. The cloud product injects a provider that resolves
 * quotas from its billing system (e.g. a Stripe subscription) per workspace and
 * reports metered usage.
 */
export interface EntitlementsProvider {
  /** Resolve the active plan limits for a workspace. */
  getLimits(workspace: Workspace): Promise<PlanLimits>;

  /** Current usage for a metric, compared against the limit before allowing an action. */
  getUsage(workspaceId: string, metric: UsageMetric): Promise<number>;

  /**
   * Unix ms at which `metric`'s usage window rolls over, used to put an honest
   * `Retry-After` on a quota 429 so callers can tell a wait-and-retry condition
   * from one that no retry will clear. Optional: a provider billing on its own
   * cycle reports that cycle's end; omitting it falls back to the engine's
   * UTC-month period.
   */
  getUsageResetAt?(workspaceId: string, metric: UsageMetric): Promise<number>;

  /**
   * Where a workspace that hit `metric`'s limit can lift it (sign in, upgrade).
   * Optional: self-host deployments have no upgrade path, and an absent or
   * failing hook only omits `upgrade_url` from the error — it never changes
   * the limit decision.
   */
  getUpgradeGuidance?(workspace: Workspace, metric: UsageMetric): Promise<UpgradeGuidance | null>;
}
