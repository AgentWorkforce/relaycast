import { NextRequest, NextResponse } from "next/server";
import { switchWorkspace } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { createSessionClaims, readSessionFromRequest, setSessionCookie } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const secret = getAuthSessionSecret();
  const session = readSessionFromRequest(request, secret);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = (await request.json().catch(() => null)) as { workspaceId?: string } | null;
  if (!body?.workspaceId) {
    return NextResponse.json({ error: "Missing workspaceId" }, { status: 400 });
  }

  try {
    const context = await switchWorkspace(session.userId, body.workspaceId);
    const response = NextResponse.json({
      authenticated: true,
      ...context,
    });
    setSessionCookie(
      response,
      createSessionClaims({
        userId: context.user.id,
        currentOrganizationId: context.currentOrganization.id,
        currentWorkspaceId: context.currentWorkspace.id,
      }),
      secret,
    );
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not switch workspace" },
      { status: 400 },
    );
  }
}
