import { NextRequest, NextResponse } from "next/server";
import { workflowStore } from "@/lib/workflows";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";

/**
 * GET /api/v1/workflows/runs
 *
 * List all workflow runs for the authenticated user.
 * Returns runs sorted by creation time (newest first).
 */
export async function GET(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const organizationWorkspaceIds = auth.context.workspaces
    .filter((workspace) => workspace.organization_id === auth.context.currentOrganization.id)
    .map((workspace) => workspace.id);

  const runs = await workflowStore.listByWorkspaceIds(organizationWorkspaceIds);
  return NextResponse.json({ runs });
}
