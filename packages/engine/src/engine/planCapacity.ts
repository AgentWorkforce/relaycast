import { and, eq, ne, not, sql } from 'drizzle-orm';
import type { EngineDb } from '../ports/database.js';
import type { EntitlementsProvider, RegistrationMetric } from '../ports/entitlements.js';
import type { Workspace } from '../ports/auth.js';
import { agents, nodes, workspaces } from '../db/schema.js';
import type { CodedError } from '../lib/httpError.js';

export const PLAN_LIMIT_EXCEEDED = 'plan_limit_exceeded';

/** The machine-readable detail a registration-cap refusal carries. */
export interface PlanLimitExceededDetail {
  limit: RegistrationMetric;
  max: number;
  current: number;
}

export interface PlanLimitExceededError extends CodedError {
  code: typeof PLAN_LIMIT_EXCEEDED;
  status: 429;
  planLimit: PlanLimitExceededDetail;
  /** Host-owned context from `EntitlementsProvider.getLimitContext`, passed through verbatim. */
  limitContext: Record<string, unknown>;
}

const REGISTRATION_NOUN: Record<RegistrationMetric, string> = {
  devices: 'device',
  agents: 'agent',
  humans: 'human member',
};

export function planLimitExceededError(
  detail: PlanLimitExceededDetail,
  limitContext: Record<string, unknown> = {},
): PlanLimitExceededError {
  const message =
    `Limit exceeded for ${detail.limit}: this workspace allows ${detail.max} ` +
    `${REGISTRATION_NOUN[detail.limit]}${detail.max === 1 ? '' : 's'} and ${detail.current} ` +
    `${detail.current === 1 ? 'is' : 'are'} registered.`;
  return Object.assign(new Error(message), {
    code: PLAN_LIMIT_EXCEEDED,
    status: 429,
    clientSafe: true as const,
    planLimit: detail,
    limitContext,
  }) as PlanLimitExceededError;
}

/** The cap detail and host context when `err` is a registration-cap refusal, else `null`. */
export function planLimitExceeded(
  err: unknown,
): { detail: PlanLimitExceededDetail; context: Record<string, unknown> } | null {
  if (!err || typeof err !== 'object') return null;
  const candidate = err as Partial<PlanLimitExceededError>;
  if (candidate.code !== PLAN_LIMIT_EXCEEDED) return null;
  const detail = candidate.planLimit;
  if (!detail || typeof detail !== 'object') return null;
  if (typeof detail.limit !== 'string' || typeof detail.max !== 'number' || typeof detail.current !== 'number') {
    return null;
  }
  const context = candidate.limitContext;
  return {
    detail: { limit: detail.limit, max: detail.max, current: detail.current },
    context: context && typeof context === 'object' && !Array.isArray(context) ? context : {},
  };
}

/**
 * The HTTP 429 body for a registration-cap refusal: the standard error
 * envelope plus top-level `error_code`/`limit`/`max`/`current` and the
 * provider's context spread at top level (so a hosted gateway's `plan` and
 * `upgrade_url` land where clients key on them). The fixed fields win over a
 * context key of the same name.
 */
export function planLimitExceededBody(
  error: CodedError,
  refusal: { detail: PlanLimitExceededDetail; context: Record<string, unknown> },
) {
  return {
    ...refusal.context,
    ok: false as const,
    error: { code: PLAN_LIMIT_EXCEEDED, message: error.message },
    error_code: PLAN_LIMIT_EXCEEDED,
    ...refusal.detail,
  };
}

/** A finite non-negative cap, or `null` for unlimited / unset / malformed. */
export function registrationCap(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

/**
 * How many of `metric` the workspace currently has registered — the number a
 * new registration is compared against.
 *
 * - `devices`: every node a host enrolled, whatever its role or transport.
 *   Every agent also owns an implicit direct node (`node_direct_<agent id>`)
 *   for its own WebSocket; those are not devices. The prefix is reserved at
 *   enrollment (`createNodeToken`), so a host cannot enroll into it.
 * - `agents`: non-human identities that have not been released.
 * - `humans`: `type = 'human'` identities that have not been released.
 */
export async function countRegistrations(
  db: EngineDb,
  workspaceId: string,
  metric: RegistrationMetric,
): Promise<number> {
  const count = sql<number>`count(*)`;
  const rows = metric === 'devices'
    ? await db
      .select({ count })
      .from(nodes)
      .where(and(
        eq(nodes.workspaceId, workspaceId),
        // GLOB, not LIKE: in LIKE `_` is a wildcard, so `nodeXdirectX…` would
        // slip out of the count while passing the literal reserved-prefix check.
        not(and(eq(nodes.role, 'direct'), sql`${nodes.id} GLOB 'node_direct_*'`)!),
      ))
    : await db
      .select({ count })
      .from(agents)
      .where(and(
        eq(agents.workspaceId, workspaceId),
        // Tombstoned identities (`RELEASED_AGENT_STATUS` in agent.ts) hold no slot.
        ne(agents.status, 'released'),
        metric === 'humans' ? eq(agents.type, 'human') : ne(agents.type, 'human'),
      ));
  return Number(rows[0]?.count ?? 0);
}

/**
 * Refuses a NEW registration of `metric` when the workspace is at its cap.
 * Callers invoke it only on the create path — re-registering an existing
 * node or agent never counts as new.
 */
export type RegistrationCapacityGuard = (metric: RegistrationMetric) => Promise<void>;

export interface RegistrationCapacityArgs {
  db: EngineDb;
  entitlements: EntitlementsProvider;
  /** The authenticated workspace row, or its id when the caller only has that. */
  workspace: Workspace | string;
}

async function resolveWorkspace(db: EngineDb, workspace: Workspace | string): Promise<Workspace | null> {
  if (typeof workspace !== 'string') return workspace;
  const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace));
  return row ?? null;
}

/**
 * Build the guard the registration paths run before inserting a node or agent.
 * The provider decides the cap (`getLimits`), the current count (`getUsage`)
 * and the refusal's host context (`getLimitContext`); a provider failure fails
 * open with a warning, matching the api_calls quota middleware — a billing
 * outage must not block registration.
 */
export function createRegistrationCapacityGuard(args: RegistrationCapacityArgs): RegistrationCapacityGuard {
  return async (metric) => {
    let detail: PlanLimitExceededDetail | null = null;
    let context: Record<string, unknown> = {};
    try {
      const workspace = await resolveWorkspace(args.db, args.workspace);
      if (!workspace) return;
      const limits = await args.entitlements.getLimits(workspace);
      const max = registrationCap(limits[metric]);
      if (max === null) return;
      const current = await args.entitlements.getUsage(workspace.id, metric);
      if (current < max) return;
      detail = { limit: metric, max, current };
      try {
        context = (await args.entitlements.getLimitContext?.(workspace)) ?? {};
      } catch {
        // The refusal stands without the host's extra fields.
      }
    } catch (err) {
      console.warn('[plan-capacity] entitlements lookup failed; allowing registration', {
        metric,
        workspaceId: typeof args.workspace === 'string' ? args.workspace : args.workspace.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    throw planLimitExceededError(detail, context);
  };
}
