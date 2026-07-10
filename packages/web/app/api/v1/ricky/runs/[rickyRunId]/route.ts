import { NextRequest, NextResponse } from "next/server";
import { requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import { canAccessRickyRun, rickyRunSupervisor } from "@/lib/ricky/run-supervisor";
import { notifyRickySlackRunState } from "@/lib/ricky/slack/proactive";

type RouteContext = {
  params: Promise<{ rickyRunId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "workflow:runs:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { rickyRunId } = await params;
  let detail = await rickyRunSupervisor.getDetail(rickyRunId);
  if (!detail || !canAccessRickyRun(auth, detail)) {
    return NextResponse.json({ error: "Ricky run not found" }, { status: 404 });
  }

  await rickyRunSupervisor.advance(rickyRunId, request).catch((error) => {
    console.error("[ricky] monitor advance failed:", error instanceof Error ? error.message : String(error));
  });
  detail = await rickyRunSupervisor.getDetail(rickyRunId);
  if (!detail) {
    return NextResponse.json({ error: "Ricky run not found" }, { status: 404 });
  }
  await notifyRickySlackRunState({
    rickyRunId,
    origin: new URL(request.url).origin,
  }).catch((error) => {
    console.error("[ricky-slack] notify failed:", error instanceof Error ? error.message : String(error));
  });

  return NextResponse.json(detail);
}
