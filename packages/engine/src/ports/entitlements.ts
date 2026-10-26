import type { Workspace } from './auth.js';

/**
 * `messages`/`file_bytes`/`api_calls` are metered per billing period;
 * `devices`/`agents`/`humans` are registration counts — how many of each a
 * workspace currently has enrolled — compared against the hard cap when a new
 * one is registered.
 */
export type UsageMetric = 'messages' | 'agents' | 'file_bytes' | 'api_calls' | 'devices' | 'humans';

/** The metrics enforced as hard registration caps. */
export type RegistrationMetric = 'devices' | 'agents' | 'humans';

/**
 * A workspace's effective limits, keyed by metric. `null` is unlimited. The
 * engine carries no tiers or numbers of its own: a host's entitlements
 * provider maps whatever it knows about a workspace (billing plan, stored
 * overrides, operator config) to this object.
 */
export interface Limits {
  /** Messages per usage period. */
  messages: number | null;
  /** Registered non-human agents (hard cap). */
  agents: number | null;
  /** Stored file bytes. */
  file_bytes: number | null;
  /** Authenticated API calls per usage period. */
  api_calls: number | null;
  /** Requests per minute, fed into the rate limiter. */
  rate_per_min: number | null;
  /** Registered devices: nodes a host enrolled, excluding each agent's implicit direct node (hard cap). */
  devices: number | null;
  /** Registered human members (`agents.type = 'human'`, hard cap). */
  humans: number | null;
  /** Message retention in days the host applies for this workspace; `null` = never prune. */
  message_retention_days: number | null;
}

/** Every metric unlimited — the self-hosted default. */
export const UNLIMITED_LIMITS: Readonly<Limits> = Object.freeze({
  messages: null,
  agents: null,
  file_bytes: null,
  api_calls: null,
  rate_per_min: null,
  devices: null,
  humans: null,
  message_retention_days: null,
});

/** A full {@link Limits} object from a partial one; absent keys are unlimited. */
export function resolveLimits(limits?: Partial<Limits> | null): Limits {
  return { ...UNLIMITED_LIMITS, ...(limits ?? {}) };
}

/**
 * Pluggable limits / usage — the hosting seam.
 *
 * Self-host uses `StaticEntitlementsProvider`: unlimited unless the operator
 * sets `EngineConfig.limits` for their own instance. The hosted product injects
 * a provider that resolves limits from its billing system per workspace,
 * reports metered usage, and supplies the context its clients need to explain
 * a refusal.
 */
export interface EntitlementsProvider {
  /** Resolve the effective limits for the authenticated workspace row. */
  getLimits(workspace: Workspace): Promise<Limits>;

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
   * Host-owned context spread verbatim onto the top level of a
   * `plan_limit_exceeded` refusal (for example the workspace's billing tier and
   * an upgrade URL). The engine never interprets it. Optional; a failure or
   * omission yields no extra fields.
   */
  getLimitContext?(workspace: Workspace): Promise<Record<string, unknown>>;
}
