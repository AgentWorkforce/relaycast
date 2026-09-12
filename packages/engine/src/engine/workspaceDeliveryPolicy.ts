import { z } from 'zod';
import { and, count, eq, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { deliveries, workspaces } from '../db/schema.js';
import type { EngineDb } from '../ports/database.js';

/**
 * Server-owned workspace delivery-growth policy.
 *
 * Relaycast historically bounds only *per-recipient* mailbox depth
 * (`belowDepthCapSql`). Nothing bounds the aggregate workspace backlog, so two
 * ordinary broadcasts of N recipients each can insert 2N rows even while a
 * workspace is far over any configured cap (relaycast-cloud WP-1 incident,
 * `rw_7ccfea89`: two 4,889-recipient sends -> 9,778 active rows vs a 5,000 cap).
 *
 * This module owns the engine-side enforcement boundary. The host resolves the
 * *effective configured* cap (and any optional reserve) from server-owned plan
 * state and passes it here through a server-only field. It is never derived
 * from a client header, and an absent policy applies **no** guard rather than
 * silently becoming unlimited by accident-of-plumbing: callers that must be
 * guarded are wired explicitly by the host.
 */
export interface WorkspaceDeliveryPolicy {
  /** Maximum active workspace delivery rows (queued+delivered, unexpired). */
  cap: number;
  /**
   * Optional reserve carved OUT of `cap` for server-classified targeted sends.
   * Broadcast admission requires `depth + new <= cap - reserve`; targeted
   * admission requires `depth + new <= cap`. Must satisfy `0 <= reserve < cap`.
   */
  reserve?: number;
}

/** Server-classified audience. Broadcasts may not consume the targeted reserve. */
export type DeliveryAudience = 'broadcast' | 'targeted';

/** Typed engine error raised when a workspace write would exceed its cap. */
export class WorkspaceDeliveryCapacityError extends Error {
  readonly code = 'workspace_delivery_depth_exceeded';
  readonly retryable = true;
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceDeliveryCapacityError';
  }
}

/**
 * Server-owned engine config shape for the workspace growth policy. Mirror of
 * the mailbox config: a global cap with optional per-workspace overrides. The
 * host supplies the *effective configured* cap here; the engine never infers a
 * cap from request data.
 */
export interface WorkspaceDeliveryPolicyConfig {
  cap?: number;
  reserve?: number;
  workspaces?: Record<string, { cap?: number; reserve?: number } | undefined>;
  /**
   * Server-only async resolver for dynamic, request-time plans (e.g. a
   * KV-backed effective plan lookup). When present it takes precedence over the
   * static `cap`/`workspaces` fields, so a host whose plan is async does not
   * have to flatten every workspace into static config. Never source this from
   * a client request.
   */
  resolve?: (workspace: { id: string; plan: string }) => Promise<WorkspaceDeliveryPolicy | undefined>;
}

const dynamicWorkspaceDeliveryPolicySchema = z.object({
  cap: z.number().int().positive(),
  reserve: z.number().int().nonnegative().default(0),
}).transform(({ cap, reserve }) => ({ cap, reserve: Math.min(reserve, cap - 1) }));

/**
 * Async resolution used by request handlers: prefer a host-supplied dynamic
 * resolver, else fall back to the static configured cap. Returns `undefined`
 * when neither is configured (self-host: no workspace guard).
 */
export async function resolveWorkspaceDeliveryPolicyFor(
  config: { workspaceDelivery?: WorkspaceDeliveryPolicyConfig } | undefined,
  workspace: { id: string; plan?: string | null },
): Promise<WorkspaceDeliveryPolicy | undefined> {
  const dynamic = await config?.workspaceDelivery?.resolve?.({
    id: workspace.id,
    plan: workspace.plan ?? 'free',
  });
  if (dynamic !== undefined) return dynamicWorkspaceDeliveryPolicySchema.parse(dynamic);
  return resolveWorkspaceDeliveryPolicy(config, workspace.id);
}

/**
 * Resolve the workspace growth policy for a workspace, or `undefined` when the
 * host configured none (self-host default: no workspace guard). A configured
 * cap must be a positive integer; a non-positive/NaN cap falls back to the
 * global value, and an undefined global stays undefined rather than unlimited.
 */
export function resolveWorkspaceDeliveryPolicy(
  config: { workspaceDelivery?: WorkspaceDeliveryPolicyConfig } | undefined,
  workspaceId: string,
): WorkspaceDeliveryPolicy | undefined {
  const scoped = config?.workspaceDelivery?.workspaces?.[workspaceId];
  const cap = positiveIntOrUndefined(scoped?.cap) ?? positiveIntOrUndefined(config?.workspaceDelivery?.cap);
  if (cap === undefined) return undefined;
  const configuredReserve = nonnegativeIntOrUndefined(scoped?.reserve)
    ?? nonnegativeIntOrUndefined(config?.workspaceDelivery?.reserve)
    ?? 0;
  // A reserve equal to or above the cap would starve broadcast admission
  // entirely; clamp to a valid `0 <= reserve < cap`.
  const reserve = Math.min(configuredReserve, cap - 1);
  return { cap, reserve };
}

function nonnegativeIntOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveIntOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * Read the current active workspace delivery depth (queued+delivered,
 * unexpired). Diagnostic only; admission is enforced by the atomic write guard.
 */
export async function currentWorkspaceDepth(db: EngineDb, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ depth: count() })
    .from(deliveries)
    .where(and(
      eq(deliveries.workspaceId, workspaceId),
      or(eq(deliveries.status, 'queued'), eq(deliveries.status, 'delivered')),
      sql`(${deliveries.expiresAt} IS NULL OR ${deliveries.expiresAt} > unixepoch())`,
    ));
  return Number(rows[0]?.depth ?? 0);
}

/** The depth ceiling a given audience may grow the workspace to. */
export function workspaceGrowthLimit(
  policy: WorkspaceDeliveryPolicy,
  audience: DeliveryAudience,
): number {
  const reserve = audience === 'broadcast' ? Math.max(0, policy.reserve ?? 0) : 0;
  return policy.cap - reserve;
}

/**
 * Active workspace delivery depth: queued + delivered, unexpired. Mirrors the
 * host's WP-1 count and the per-recipient predicate's expiry semantics
 * (`expires_at IS NULL OR expires_at > unixepoch()`).
 */
export function workspaceActiveDepthSql(workspaceId: string): SQL<number> {
  return sql<number>`(
    SELECT COUNT(*) FROM deliveries d_ws
    WHERE d_ws.workspace_id = ${workspaceId}
      AND d_ws.status IN ('queued', 'delivered')
      AND (d_ws.expires_at IS NULL OR d_ws.expires_at > unixepoch())
  )`;
}

/**
 * Distinct NEW candidate deliveries for a recipient relation: the candidate
 * rows (aliased `agent_id`) whose delivery identity is not already present.
 *
 * `candidateAgentIds` MUST be the builder's own recipient relation (same
 * eligibility predicate, sender exclusion, group left/mention rules), so the
 * count charges exactly the rows this write would add. Deduplicating against
 * `(message_id, agent_id)` keeps idempotent retries and `onConflictDoNothing` from
 * charging the same delivery twice.
 */
export function newDeliveryCountSql(
  candidateAgentIds: SQLWrapper,
  messageId: string,
): SQL<number> {
  return sql<number>`(
    SELECT COUNT(*) FROM (${candidateAgentIds}) AS cand
    WHERE NOT EXISTS (
      SELECT 1 FROM deliveries x
      WHERE x.message_id = ${messageId} AND x.agent_id = cand.agent_id
    )
  )`;
}

/**
 * Atomic workspace growth guard.
 *
 * Yields `workspaceId` when `activeWorkspaceDepth + newCandidates <= limit`,
 * otherwise NULL. `deliveries.workspace_id` is NOT NULL, so a NULL forces a real
 * statement error that rolls back the enclosing atomic write: the whole
 * broadcast is refused, never silently truncated or partially admitted.
 *
 * Because the depth and candidate counts are evaluated inside the same
 * statement as the insert, and D1/SQLite serialize writes, a concurrent writer
 * cannot slip between a count and the insert the way a host-side preflight can.
 */
export function workspaceGrowthGuardSql(
  workspaceId: string,
  limit: number,
  newCandidateCount: SQL<number>,
): SQL<string> {
  return sql<string>`CASE WHEN (${workspaceActiveDepthSql(workspaceId)} + ${newCandidateCount}) <= ${limit} THEN ${workspaceId} ELSE NULL END`;
}

/** Resolve after custom authentication has established the workspace identity. */
export async function resolveWorkspaceDeliveryPolicyById(
  db: EngineDb,
  config: { workspaceDelivery?: WorkspaceDeliveryPolicyConfig } | undefined,
  workspaceId: string,
): Promise<WorkspaceDeliveryPolicy | undefined> {
  const [workspace] = await db.select({ id: workspaces.id, plan: workspaces.plan })
    .from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!workspace) throw new Error('Workspace delivery policy workspace not found');
  return resolveWorkspaceDeliveryPolicyFor(config, workspace);
}
