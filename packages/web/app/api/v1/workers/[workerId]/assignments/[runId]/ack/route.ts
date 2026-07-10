import { NextRequest, NextResponse } from "next/server";
import { acknowledgeAssignment } from "@/lib/workers/assignments";
import { requireWorkerAuth, WorkerAuthError } from "@/lib/workers/auth";

type RouteContext = {
  params: Promise<{ workerId: string; runId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { workerId, runId } = await params;

  try {
    await requireWorkerAuth(request, workerId);
    const assignment = await acknowledgeAssignment(workerId, runId);
    if (!assignment) {
      return NextResponse.json({ error: "Assignment not found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      status: assignment.status,
      assignedAt: assignment.assignedAt,
    });
  } catch (error) {
    if (error instanceof WorkerAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(
      "Worker assignment ack failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
