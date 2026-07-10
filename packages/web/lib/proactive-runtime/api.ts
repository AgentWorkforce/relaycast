import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth, type RequestAuth } from "@/lib/auth/request-auth";
import type { AuthWorkspace } from "@/lib/auth/types";

export type WorkspaceRequestContext = {
  auth: RequestAuth & { source: "session" };
  workspace: AuthWorkspace;
};

export async function requireWorkspaceRequestContext(
  request: NextRequest,
  workspaceId: string,
): Promise<WorkspaceRequestContext | NextResponse> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const workspace = auth.context.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  return { auth, workspace };
}
