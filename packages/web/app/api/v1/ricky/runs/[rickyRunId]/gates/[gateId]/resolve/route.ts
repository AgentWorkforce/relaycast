import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { canAccessRickyRun, rickyRunSupervisor } from "@/lib/ricky/run-supervisor";
import type { GateResolution } from "@/lib/ricky/types";

type RouteContext = {
  params: Promise<{ rickyRunId: string; gateId: string }>;
};

function isGateResolution(value: unknown): value is GateResolution {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Partial<GateResolution>;
  if (body.decision === "approve" || body.decision === "deny") {
    return body.comment === undefined || typeof body.comment === "string";
  }
  if (body.decision === "edit") {
    return (
      typeof body.instruction === "string" &&
      body.instruction.trim().length > 0 &&
      (body.comment === undefined || typeof body.comment === "string")
    );
  }
  return false;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: auth ? "Forbidden" : "Unauthorized" }, { status: auth ? 403 : 401 });
  }

  const { rickyRunId, gateId } = await params;
  const detail = await rickyRunSupervisor.getDetail(rickyRunId);
  if (!detail || !canAccessRickyRun(auth, detail)) {
    return NextResponse.json({ error: "Ricky run not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isGateResolution(body)) {
    return NextResponse.json({ error: "Invalid gate resolution" }, { status: 400 });
  }

  const resolved = await rickyRunSupervisor.resolveGate({
    rickyRunId,
    gateId,
    auth,
    resolution: body,
  });
  if (!resolved) {
    return NextResponse.json({ error: "Gate not found" }, { status: 404 });
  }

  return NextResponse.json({ gate: resolved });
}
