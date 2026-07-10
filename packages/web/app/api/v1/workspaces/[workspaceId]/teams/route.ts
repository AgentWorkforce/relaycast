import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import {
  loadTeamSpec,
  TeamSpecError,
} from "@cloud/core/proactive-runtime/team-spec.js";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import { teamMembers, teams } from "@/lib/db/schema";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import { bindTeam, TeamDeployError, type BindTeamResult } from "@/lib/proactive-runtime/team-deploy";

type TeamsRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type ErrorResponse = {
  error: string;
  code?: string;
  details?: unknown;
};

type TeamListMember = {
  name: string;
  agentId: string | null;
  personaId: string | null;
  personaRef: unknown | null;
  role: string;
  owns: unknown[] | null;
};

type TeamListItem = {
  teamId: string;
  slug: string;
  leadMemberName: string | null;
  tokenBudget: number | null;
  timeBudgetSeconds: number | null;
  members: TeamListMember[];
};

type TeamListResponse = {
  teams: TeamListItem[];
};

function canWriteTeams(
  auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>,
): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:write")
  );
}

function canReadTeams(
  auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>,
): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:read")
  );
}

function responseForError(error: unknown): NextResponse<ErrorResponse> {
  if (error instanceof TeamSpecError) {
    return NextResponse.json(
      { error: error.message, code: "invalid_team_spec" },
      { status: 422 },
    );
  }
  if (error instanceof TeamDeployError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }
  console.error("Team binding failed:", error);
  return NextResponse.json(
    { error: "Failed to bind team", code: "team_bind_failed" },
    { status: 500 },
  );
}

function readSpecBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  return record.spec ?? body;
}

export async function PUT(
  request: NextRequest,
  context: TeamsRouteContext,
): Promise<NextResponse<BindTeamResult | ErrorResponse>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (!canWriteTeams(auth)) {
    return NextResponse.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }

  const { workspaceId } = await context.params;
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }

  try {
    const body = await request.json();
    const spec = loadTeamSpec(readSpecBody(body));
    const result = await bindTeam({ workspaceId, spec });
    return NextResponse.json(result);
  } catch (error) {
    return responseForError(error);
  }
}

export async function GET(
  request: NextRequest,
  context: TeamsRouteContext,
): Promise<NextResponse<TeamListResponse | ErrorResponse>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (!canReadTeams(auth)) {
    return NextResponse.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }

  const { workspaceId } = await context.params;
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }

  try {
    const db = getDb();
    const teamRows = await db
      .select({
        teamId: teams.id,
        slug: teams.slug,
        leadMemberName: teams.leadMemberName,
        tokenBudget: teams.tokenBudget,
        timeBudgetSeconds: teams.timeBudgetSeconds,
      })
      .from(teams)
      .where(and(eq(teams.workspaceId, workspaceId), isNotNull(teams.slug)))
      .orderBy(asc(teams.slug));

    const teamIds = teamRows.map((team) => team.teamId);
    const memberRows = teamIds.length === 0
      ? []
      : await db
        .select({
          teamId: teamMembers.teamId,
          name: teamMembers.name,
          agentId: teamMembers.agentId,
          personaId: teamMembers.personaId,
          personaRef: teamMembers.personaRef,
          role: teamMembers.role,
          owns: teamMembers.owns,
        })
        .from(teamMembers)
        .where(inArray(teamMembers.teamId, teamIds))
        .orderBy(asc(teamMembers.name));

    const membersByTeamId = new Map<string, TeamListMember[]>();
    for (const member of memberRows) {
      const members = membersByTeamId.get(member.teamId) ?? [];
      members.push({
        name: member.name,
        agentId: member.agentId,
        personaId: member.personaId,
        personaRef: member.personaRef,
        role: member.role,
        owns: member.owns,
      });
      membersByTeamId.set(member.teamId, members);
    }

    return NextResponse.json<TeamListResponse>({
      teams: teamRows.map((team) => ({
        teamId: team.teamId,
        slug: team.slug ?? "",
        leadMemberName: team.leadMemberName,
        tokenBudget: team.tokenBudget,
        timeBudgetSeconds: team.timeBudgetSeconds,
        members: membersByTeamId.get(team.teamId) ?? [],
      })),
    });
  } catch (error) {
    console.error("Team list failed:", error);
    return NextResponse.json(
      { error: "Failed to list teams", code: "team_list_failed" },
      { status: 500 },
    );
  }
}
