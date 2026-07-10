import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, notInArray } from "drizzle-orm";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import { getDb } from "@/lib/db";
import { teams, teamEvents } from "@/lib/db/schema";

type CancelRouteContext = {
  params: Promise<{ workspaceId: string; teamId: string }>;
};

type CancelResponse = {
  teamId: string;
  status: "cancelled";
};

type ErrorResponse = { error: string };

const TERMINAL_STATUSES = [
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
] as const;
const TERMINAL_STATUS_SET = new Set<string>(TERMINAL_STATUSES);

function canCancel(
  auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>,
): boolean {
  return requireSessionAuth(auth) || requireAuthScope(auth, "cli:auth");
}

export async function POST(
  request: NextRequest,
  context: CancelRouteContext,
): Promise<NextResponse<CancelResponse | ErrorResponse>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canCancel(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId, teamId } = await context.params;
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const db = getDb();
    const [team] = await db
      .select()
      .from(teams)
      .where(and(eq(teams.id, teamId), eq(teams.workspaceId, workspaceId)))
      .limit(1);
    if (!team) {
      return NextResponse.json({ error: "Team not found" }, { status: 404 });
    }
    if (TERMINAL_STATUS_SET.has(team.status)) {
      return NextResponse.json(
        { error: `Team already terminal (${team.status})` },
        { status: 409 },
      );
    }

    const [cancelled] = await db
      .update(teams)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(
        and(
          eq(teams.id, teamId),
          eq(teams.workspaceId, workspaceId),
          notInArray(teams.status, [...TERMINAL_STATUSES]),
        ),
      )
      .returning({ id: teams.id });
    if (!cancelled) {
      return NextResponse.json(
        { error: "Team already terminal" },
        { status: 409 },
      );
    }

    await db.insert(teamEvents).values({
      id: `tev_${randomUUID()}`,
      teamId,
      kind: "cancelled",
      payload: { cancelledBy: auth.userId },
    });

    // NOTE: member-sandbox teardown is driven by the lifecycle reaper /
    // teardown path (spec §13), not inline here — cancelling the team row is
    // the durable signal the reaper acts on. Inline Daytona destroy is wired
    // with the spawn endpoint.
    return NextResponse.json<CancelResponse>({ teamId, status: "cancelled" });
  } catch (error) {
    console.error("Team cancel failed:", error);
    return NextResponse.json(
      { error: "Failed to cancel team" },
      { status: 500 },
    );
  }
}
