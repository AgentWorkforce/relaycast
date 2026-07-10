import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import { getDb } from "@/lib/db";
import { teams, teamMembers } from "@/lib/db/schema";

type TeamRouteContext = {
  params: Promise<{ workspaceId: string; teamId: string }>;
};

type TeamMemberResult = {
  status: string;
  output: string;
  resultId?: string;
};

type TeamMemberView = {
  name: string;
  agentId: string | null;
  personaId: string | null;
  personaRef: unknown | null;
  role: string;
  owns: unknown[] | null;
  sandboxId: string | null;
  assignedTask: string | null;
  status: string;
};

type TeamStatusResponse = {
  teamId: string;
  status: string;
  members: TeamMemberView[];
  results: Record<string, TeamMemberResult>;
  summary: string;
};

type ErrorResponse = { error: string };

export async function GET(
  request: NextRequest,
  context: TeamRouteContext,
): Promise<NextResponse<TeamStatusResponse | ErrorResponse>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    const members = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(asc(teamMembers.name));

    const results: Record<string, TeamMemberResult> = {};
    for (const member of members) {
      results[member.name] = {
        status: member.status,
        output: member.output ?? "",
        ...(member.resultId ? { resultId: member.resultId } : {}),
      };
    }

    return NextResponse.json<TeamStatusResponse>({
      teamId: team.id,
      status: team.status,
      members: members.map((member) => ({
        name: member.name,
        agentId: member.agentId,
        personaId: member.personaId,
        personaRef: member.personaRef,
        role: member.role,
        owns: member.owns,
        sandboxId: member.sandboxId,
        assignedTask: member.assignedTask,
        status: member.status,
      })),
      results,
      summary: team.summary ?? "",
    });
  } catch (error) {
    console.error("Team status read failed:", error);
    return NextResponse.json({ error: "Failed to read team" }, { status: 500 });
  }
}
