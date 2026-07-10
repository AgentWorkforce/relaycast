import { NextRequest, NextResponse } from "next/server";
import { workflowStore } from "@/lib/workflows";
import { canAccessWorkflowRun, requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";

/**
 * GET /api/v1/workflows/runs/[runId]/steps
 *
 * Return per-step metadata for a workflow run. In local dev we serve mock data
 * from the in-memory workflow store; the production implementation can replace
 * this with getRunStatus() once SST links and storage are available.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "workflow:runs:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId } = await params;
  if (auth.source === "token" && auth.subjectType === "sandbox" && auth.runId !== runId) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }
  const run = await workflowStore.get(runId);
  if (!run || !canAccessWorkflowRun(auth, run)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const steps = await workflowStore.listSteps(runId);
  return NextResponse.json({ steps });
}
