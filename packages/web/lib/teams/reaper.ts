import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { teams, teamEvents } from "@/lib/db/schema";

/**
 * Team lifecycle reaper + cascade (spec §13).
 *
 * - `reapExpiredTeams` sweeps teams whose `expires_at` has passed and that are
 *   not yet terminal, marking them `timed_out`. Intended to run on the same
 *   cron sweep as the sandbox GC.
 * - `cancelTeamsForParentAgent` cascades a parent-agent destroy: any
 *   non-terminal team spawned by that agent is `cancelled`. Call from the
 *   agent destroy path.
 *
 * Both only flip the durable team row + write an event — member-sandbox
 * teardown is driven off that state by the (separate) sandbox GC, so this
 * stays a pure, testable DB operation.
 */

const NON_TERMINAL = ["starting", "running"] as const;

export interface ReapResult {
  timedOut: string[];
}

export async function reapExpiredTeams(now: Date = new Date()): Promise<ReapResult> {
  const db = getDb();
  const expired = await db
    .update(teams)
    .set({ status: "timed_out", updatedAt: now })
    .where(and(lt(teams.expiresAt, now), inArray(teams.status, [...NON_TERMINAL])))
    .returning({ id: teams.id });

  if (expired.length > 0) {
    await db.insert(teamEvents).values(
      expired.map((t) => ({
        id: `tev_${randomUUID()}`,
        teamId: t.id,
        kind: "team_timed_out",
        payload: { at: now.toISOString() } as Record<string, unknown>,
      })),
    );
  }
  return { timedOut: expired.map((t) => t.id) };
}

export interface CascadeResult {
  cancelled: string[];
}

export async function cancelTeamsForParentAgent(
  parentAgentId: string,
  now: Date = new Date(),
): Promise<CascadeResult> {
  const db = getDb();
  const cancelled = await db
    .update(teams)
    .set({ status: "cancelled", updatedAt: now })
    .where(
      and(eq(teams.parentAgentId, parentAgentId), inArray(teams.status, [...NON_TERMINAL])),
    )
    .returning({ id: teams.id });

  if (cancelled.length > 0) {
    await db.insert(teamEvents).values(
      cancelled.map((t) => ({
        id: `tev_${randomUUID()}`,
        teamId: t.id,
        kind: "team_cancelled_cascade",
        payload: { parentAgentId } as Record<string, unknown>,
      })),
    );
  }
  return { cancelled: cancelled.map((t) => t.id) };
}

/**
 * Count team members currently occupying capacity in a workspace — members of
 * teams that are still `starting`/`running`. Used by the spawn quota check (§14).
 */
export async function countActiveTeamMembers(workspaceId: string): Promise<number> {
  const db = getDb();
  const [row] = await db.execute<{ count: string }>(sql`
    SELECT COUNT(*)::text AS count
    FROM team_members tm
    JOIN teams t ON t.id = tm.team_id
    WHERE t.workspace_id = ${workspaceId}
      AND t.status IN ('starting', 'running')
  `) as unknown as Array<{ count: string }>;
  return Number(row?.count ?? 0);
}
