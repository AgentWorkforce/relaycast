import { NextRequest, NextResponse } from "next/server";
import { recordPhaseTransition } from "@/lib/workers/assignments";
import { requireWorkerAuth, WorkerAuthError } from "@/lib/workers/auth";

type StatusBody = {
  phase: "running" | "completed" | "failed";
  exitCode?: number;
  durationMs?: number;
  summary?: string;
  error?: string;
  result?: Record<string, unknown>;
};

type RouteContext = {
  params: Promise<{ workerId: string; runId: string }>;
};

function isStatusBody(payload: unknown): payload is StatusBody {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const body = payload as Partial<StatusBody>;
  return (
    (body.phase === "running" || body.phase === "completed" || body.phase === "failed") &&
    (body.exitCode === undefined || typeof body.exitCode === "number") &&
    (body.durationMs === undefined || typeof body.durationMs === "number") &&
    (body.summary === undefined || typeof body.summary === "string") &&
    (body.error === undefined || typeof body.error === "string") &&
    (body.result === undefined ||
      (typeof body.result === "object" && body.result !== null && !Array.isArray(body.result)))
  );
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { workerId, runId } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isStatusBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    await requireWorkerAuth(request, workerId);
    const assignment = await recordPhaseTransition(workerId, runId, body.phase, {
      exitCode: body.exitCode,
      durationMs: body.durationMs,
      summary: body.summary,
      error: body.error,
      result: body.result,
    });

    if (!assignment) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, status: assignment.status });
  } catch (error) {
    if (error instanceof WorkerAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(
      "Worker assignment status failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
