import { NextRequest, NextResponse } from "next/server";
import { getAuthContext, getAuthUserProfile } from "@/lib/auth/auth-api";
import { resolveRequestAuth } from "@/lib/auth/request-auth";

function isNoActiveWorkspaceError(error: unknown): boolean {
  return error instanceof Error && error.message === "No active workspace";
}

export async function GET(request: NextRequest) {
  const auth = await resolveRequestAuth(request, { allowMissingWorkspace: true });
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const context = auth.context ?? (await getAuthContext(auth.userId, auth.workspaceId));

    return NextResponse.json({
      authenticated: true,
      source: auth.source,
      subjectType: auth.subjectType ?? null,
      scopes: auth.scopes ?? [],
      user: context.user,
      currentOrganization: context.currentOrganization,
      currentWorkspace: context.currentWorkspace,
    });
  } catch (error) {
    if (!isNoActiveWorkspaceError(error)) {
      throw error;
    }

    return NextResponse.json({
      authenticated: true,
      source: auth.source,
      subjectType: auth.subjectType ?? null,
      scopes: auth.scopes ?? [],
      user: await getAuthUserProfile(auth.userId),
      currentOrganization: null,
      currentWorkspace: null,
      workspaceRequired: true,
    });
  }
}
