import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { canAccessRickyRun, rickyRunSupervisor } from "@/lib/ricky/run-supervisor";

type RouteContext = {
  params: Promise<{ rickyRunId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { rickyRunId } = await params;
  const detail = await rickyRunSupervisor.getDetail(rickyRunId);
  if (!detail || !canAccessRickyRun(auth, detail)) {
    return NextResponse.json({ error: "Ricky run not found" }, { status: 404 });
  }

  const canceled = await rickyRunSupervisor.cancel(rickyRunId, request);
  return NextResponse.json({
    rickyRunId,
    status: canceled?.status ?? "canceled",
    activeWorkflowRunId: canceled?.activeWorkflowRunId,
  });
}
