import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  publishWorkerRevocation,
  revokePendingAssignmentsForWorker,
  runWorkerAssignmentMaintenance,
} from "@/lib/workers/assignments";
import { clearWorkerOfflineTimer } from "@/lib/workers/queue";
import { WorkerRegistry } from "@/lib/workers/registry";

type RouteContext = {
  params: Promise<{ workerId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workerId } = await params;

  try {
    await runWorkerAssignmentMaintenance();
    const worker = await new WorkerRegistry().findById(workerId);
    if (!worker || worker.workspaceId !== auth.workspaceId) {
      return NextResponse.json({ error: "Worker not found" }, { status: 404 });
    }

    return NextResponse.json({ worker });
  } catch (error) {
    console.error("Worker lookup failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workerId } = await params;

  try {
    await runWorkerAssignmentMaintenance();
    const registry = new WorkerRegistry();
    const worker = await registry.findById(workerId);
    if (!worker || worker.workspaceId !== auth.workspaceId) {
      return NextResponse.json({ error: "Worker not found" }, { status: 404 });
    }

    const revoked = await registry.revoke(workerId);
    await revokePendingAssignmentsForWorker(workerId);
    clearWorkerOfflineTimer(workerId);
    // Revocation stops new work from being dispatched; in-flight work is not cancelled in v4.
    await publishWorkerRevocation(workerId);

    return NextResponse.json({
      workerId: revoked.id,
      status: revoked.status,
    });
  } catch (error) {
    console.error("Worker revoke failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
