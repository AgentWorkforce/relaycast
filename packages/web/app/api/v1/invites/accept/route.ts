import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth, requireSessionAuth } from "@/lib/auth/request-auth";
import { acceptInvite } from "@/lib/invites/invite-store";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { createSessionClaims, setSessionCookie } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { token?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body.token) {
    return NextResponse.json({ error: "Token is required" }, { status: 400 });
  }

  try {
    const { organizationId } = await acceptInvite(body.token, auth.userId);

    // Refresh auth context and switch to the joined org's default workspace
    const context = await getAuthContext(auth.userId);
    const orgWorkspace = context.workspaces.find((ws) => ws.organization_id === organizationId);
    const refreshedContext = orgWorkspace
      ? await getAuthContext(auth.userId, orgWorkspace.id)
      : context;

    const response = NextResponse.json({
      ok: true,
      authenticated: true,
      ...refreshedContext,
    });

    setSessionCookie(
      response,
      createSessionClaims({
        userId: refreshedContext.user.id,
        currentOrganizationId: refreshedContext.currentOrganization.id,
        currentWorkspaceId: refreshedContext.currentWorkspace.id,
      }),
      getAuthSessionSecret(),
    );

    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to accept invite";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
