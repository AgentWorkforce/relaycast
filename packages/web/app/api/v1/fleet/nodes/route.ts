import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { listFleetNodesForAppWorkspace } from "@/lib/fleet/nodes";

export async function GET(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!requireSessionAuth(auth)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const workspaceId = request.nextUrl.searchParams.get("workspaceId")?.trim();
  if (!workspaceId) return NextResponse.json({ error: "workspaceId is required" }, { status: 400 });

  const workspace = auth.context.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  try {
    const result = await listFleetNodesForAppWorkspace(workspaceId);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Node roster fetch failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
