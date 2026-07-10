import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { runWorkerAssignmentMaintenance } from "@/lib/workers/assignments";
import { WorkerRegistry } from "@/lib/workers/registry";

export async function GET(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    await runWorkerAssignmentMaintenance();
    const workers = await new WorkerRegistry().listByWorkspace(auth.workspaceId);
    return NextResponse.json({ workers });
  } catch (error) {
    console.error("Worker listing failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
