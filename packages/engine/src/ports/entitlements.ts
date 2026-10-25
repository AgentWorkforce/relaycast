import type { Workspace } from './auth.js';

/**
 * `messages`/`file_bytes`/`api_calls` are metered per billing period;
 * `devices`/`agents`/`humans` are registration counts — how many of each a
 * workspace currently has enrolled — compared against the plan's hard cap when
 * a new one is registered.
 */
export type UsageMetric = 'messages' | 'agents' | 'file_bytes' | 'api_calls' | 'devices' | 'humans';

/** The metrics enforced as hard registration caps. */
export type RegistrationMetric = 'devices' | 'agents' | 'humans';

export interface PlanLimits {
  messages: number;
  /** Registered non-human agents. `Infinity` = unlimited. */
  agents: number;
  file_bytes: number;
  /** Total authenticated API calls allowed for the current billing window. */
  api_calls: number;
  /** Global requests-per-minute ceiling, fed into the rate limiter. */
  rate_per_min: number;
  /** Registered devices (broker/http_push nodes; implicit direct nodes excluded). `null` = unlimited. */
  devices: number | null;
  /** Registered human members (`agents.type = 'human'`). `null` = unlimited. */
  humans: number | null;
}

/**
 * Per-workspace registration-cap overrides a control plane stores on the
 * workspace row (`workspaces.plan_limits`). A present key wins over the plan
 * table; `null` means unlimited; an absent key falls through to the plan.
 * `session_retention_days` is carried for the host's own retention policy and
 * is not an engine limit.
 */
export interface WorkspacePlanLimits {
  devices?: number | null;
  agents?: number | null;
  humans?: number | null;
  session_retention_days?: number | null;
}

/**
 * Pluggable plan limits / usage — the billing seam.
 *
 * Self-host uses `StaticEntitlementsProvider`, seeded from today's hardcoded
 * `PLAN_LIMITS` (free/connect/intro/pro/enterprise), defaulting single-tenant
 * deployments to a generous/unlimited tier. The cloud product injects a provider
 * that resolves quotas from its billing system (e.g. a Stripe subscription) per
 * workspace and reports metered usage.
 */
export interface EntitlementsProvider {
  /** Resolve the active plan limits for a workspace. */
  getLimits(workspace: Workspace): Promise<PlanLimits>;

  /**
   * Current usage for a metric, compared against the limit before allowing an
   * action. For a {@link RegistrationMetric} this is the number currently
   * registered (see `countRegistrations`), not a per-period counter.
   */
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
   * The effective plan key reported in a `plan_limit_exceeded` refusal.
   * Optional: a provider that raises a workspace above its stored `plan`
   * column reports the raised key; omitting it reports `workspace.plan`.
   */
  getPlan?(workspace: Workspace): Promise<string>;
}
