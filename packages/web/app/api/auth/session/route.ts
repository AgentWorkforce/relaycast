import { NextRequest, NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { createSessionClaims, readSessionFromRequest, setSessionCookie } from "@/lib/auth/session";

export async function GET(request: NextRequest) {
  const secret = getAuthSessionSecret();
  const session = readSessionFromRequest(request, secret);
  if (!session) {
    return NextResponse.json({ authenticated: false });
  }

  try {
    const context = await getAuthContext(session.userId, session.currentWorkspaceId);
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
    console.error("Session lookup failed:", error);
    const response = NextResponse.json({ authenticated: false }, { status: 401 });
    response.cookies.delete("agent_relay_session");
    return response;
  }
}
