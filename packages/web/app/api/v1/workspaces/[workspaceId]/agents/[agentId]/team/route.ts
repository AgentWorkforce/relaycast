import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import { SpawnTeamError, spawnTeam, type SpawnTeamResult } from "@/lib/teams/spawn-team";

type TeamSpawnRouteContext = {
  // URL slug MUST match the sibling `[agentId]` segment — Next.js forbids two
  // different dynamic slug names at the same path position. This is the parent
  // agent's id; it's mapped to spawnTeam's `parentAgentId` below.
  params: Promise<{ workspaceId: string; agentId: string }>;
};

type ErrorResponse = { error: string; code?: string };

function canSpawn(
  auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>,
): boolean {
  return requireSessionAuth(auth) || requireAuthScope(auth, "cli:auth");
}

export async function POST(
  request: NextRequest,
  context: TeamSpawnRouteContext,
): Promise<NextResponse<SpawnTeamResult | ErrorResponse>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canSpawn(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId, agentId } = await context.params;
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const result = await spawnTeam({
      workspaceId,
      parentAgentId: agentId,
      deployerUserId: auth.userId,
      organizationId: auth.organizationId,
      body,
    });
    return NextResponse.json<SpawnTeamResult>(result, { status: 201 });
  } catch (error) {
    if (error instanceof SpawnTeamError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    console.error("Team spawn failed:", error);
    return NextResponse.json({ error: "Failed to spawn team" }, { status: 500 });
  }
}
