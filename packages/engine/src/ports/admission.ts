import type { Workspace } from './auth.js';

/**
 * A new registration a host can cap.
 *
 * - `register_device`: a host-enrolled node (`POST /v1/nodes`, any role or
 *   transport). An agent's implicit direct node is its own WebSocket, not a
 *   device, and is never admitted as one.
 * - `register_agent`: a new non-human identity (`POST /v1/agents`, a new A2A
 *   proxy, or a node's `agent.register` frame).
 * - `register_human`: a new `type: human` identity.
 *
 * Re-enrolling an established node or re-registering an established name is
 * not a new registration and is never admitted as one.
 */
export type RegistrationAdmissionAction = 'register_device' | 'register_agent' | 'register_human';

/**
 * What an admitted request is about to do.
 *
 * - `request`: any authenticated, rate-limited request.
 * - `message`: a message send (channel post, DM, group DM, thread reply).
 * - a {@link RegistrationAdmissionAction}: a new device or identity.
 */
export type AdmissionAction = 'request' | 'message' | RegistrationAdmissionAction;

export interface AdmissionContext {
  workspace: Workspace;
  action: AdmissionAction;
  /**
   * Set for a registration action: how many of that kind the workspace has
   * registered now, before this one. Released identities hold no slot.
   */
  registered?: number;
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
   * Called after an admitted `request` or `message` succeeds (2xx, not an
   * idempotent replay). The response does not wait on it. Registrations are
   * not reported: `registered` is a live count.
   */
  committed?(ctx: AdmissionContext): Promise<void>;

  /**
   * The workspace's requests-per-minute ceiling. Falls back to
   * `EngineConfig.rateLimitPerMinute` when absent or failing.
   */
  rateLimitPerMinute?(workspace: Workspace): Promise<number>;
}
