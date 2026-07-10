import { NextRequest, NextResponse } from "next/server";
import { requireWorkerAuth, WorkerAuthError } from "@/lib/workers/auth";
import { runWorkerAssignmentMaintenance } from "@/lib/workers/assignments";
import { clearWorkerOfflineTimer } from "@/lib/workers/queue";
import { WorkerRegistry } from "@/lib/workers/registry";

const NEXT_HEARTBEAT_MS = 30_000;

type RouteContext = {
  params: Promise<{ workerId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { workerId } = await params;

  try {
    await requireWorkerAuth(request, workerId);
    await runWorkerAssignmentMaintenance();
    clearWorkerOfflineTimer(workerId);
    await new WorkerRegistry().markOnline(workerId);
    return NextResponse.json({ ok: true, nextHeartbeatMs: NEXT_HEARTBEAT_MS });
  } catch (error) {
    if (error instanceof WorkerAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(
      "Worker heartbeat failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
