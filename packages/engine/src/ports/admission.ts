import type { Workspace } from './auth.js';

/**
 * What an admitted request is about to do.
 *
 * - `request`: any authenticated, rate-limited request.
 * - `message`: a message send (channel post, DM, group DM, thread reply).
 */
export type AdmissionAction = 'request' | 'message';

export interface AdmissionContext {
  workspace: Workspace;
  action: AdmissionAction;
}

/**
 * A host refusal, rendered as `{ ok: false, error: { code, message, ...details } }`
 * with `status`.
 */
export interface AdmissionDenial {
  /** HTTP status, 4xx. */
  status: number;
  code: string;
  message: string;
  /** Additive fields on `error`, e.g. the limit that was reached. */
  details?: Record<string, unknown>;
  /**
   * Unix ms at which retrying can succeed; sets `Retry-After`. Omit when no
   * retry clears the refusal.
   */
  retryAt?: number;
}

/**
 * Host hooks for admitting and metering workspace activity.
 *
 * The engine enforces no quotas of its own. A host that bills or meters
 * (the hosted product) implements these; self-host passes none, and every
 * request is admitted. Every hook is optional, and a hook that throws admits
 * the request.
 */
export interface AdmissionHooks {
  /**
   * Decide whether an action may proceed. Return a denial to refuse it, or
   * `null`/`undefined` to admit it.
   *
   * A `message` denial on a request carrying an `Idempotency-Key` refuses only
   * a fresh send: a replay of an earlier successful send still returns its
   * stored receipt.
   */
  admit?(ctx: AdmissionContext): Promise<AdmissionDenial | null | undefined>;

  /**
   * Called after an admitted action succeeds (2xx, not an idempotent replay).
   * The response does not wait on it.
   */
  committed?(ctx: AdmissionContext): Promise<void>;

  /**
   * The workspace's requests-per-minute ceiling. Falls back to
   * `EngineConfig.rateLimitPerMinute` when absent or failing.
   */
  rateLimitPerMinute?(workspace: Workspace): Promise<number>;
}
