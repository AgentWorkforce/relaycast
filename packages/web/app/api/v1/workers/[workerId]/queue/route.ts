import { NextRequest, NextResponse } from "next/server";
import { requireWorkerAuth, WorkerAuthError } from "@/lib/workers/auth";
import { getWorkerAssignmentBus } from "@/lib/workers/bus";
import { pollQueueForWorker, runWorkerAssignmentMaintenance } from "@/lib/workers/assignments";
import { clearWorkerOfflineTimer, createAssignmentStream } from "@/lib/workers/queue";
import { WorkerRegistry } from "@/lib/workers/registry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ workerId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { workerId } = await params;
  const registry = new WorkerRegistry();

  try {
    await requireWorkerAuth(request, workerId);
    await runWorkerAssignmentMaintenance();

    clearWorkerOfflineTimer(workerId);
    await registry.markOnline(workerId);

    const stream = createAssignmentStream({
      workerId,
      bus: getWorkerAssignmentBus(),
      signal: request.signal,
      getInitialAssignments: async () => pollQueueForWorker(workerId),
      createOfflineTransition: async () => {
        const worker = await registry.findById(workerId);
        const expectedLastSeen = worker?.lastSeen ? new Date(worker.lastSeen) : new Date();

        return async () => {
          if (!worker || worker.status === "revoked") {
            return;
          }

          await registry.markOfflineIfStale(workerId, expectedLastSeen);
        };
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    if (error instanceof WorkerAuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }

    console.error(
      "Worker queue stream failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
