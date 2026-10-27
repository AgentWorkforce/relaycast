/** The `plan_limit_exceeded` response body (see `middleware/planLimits.ts`). */
export interface PlanLimitExceededBody {
  ok: false;
  error: {
    code: 'plan_limit_exceeded';
    message: string;
    metric: string;
    plan: string;
    limit: number;
    usage: number;
    upgrade_url: string | null;
    upgrade_action: 'sign_in' | 'upgrade' | null;
  };
}

/**
 * Thrown from inside a route when a fresh send would exceed a plan limit that
 * was already known to be exhausted. `errorResponse` renders the carried body
 * verbatim, so the error keeps its additive quota fields.
 */
export class PlanLimitExceededError extends Error {
  readonly code = 'plan_limit_exceeded';
  readonly status = 429;

  constructor(readonly body: PlanLimitExceededBody) {
    super(body.error.message);
    this.name = 'PlanLimitExceededError';
  }
}
