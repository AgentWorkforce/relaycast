import { NextRequest, NextResponse } from "next/server";
import { requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import { canAccessRickyRun, rickyRunSupervisor } from "@/lib/ricky/run-supervisor";
import { rickyRunStore } from "@/lib/ricky/run-store";
import { RICKY_TERMINAL_STATUSES } from "@/lib/ricky/types";

type RouteContext = {
  params: Promise<{ rickyRunId: string }>;
};

const SSE_POLL_INTERVAL_MS = 1000;
const SSE_MAX_DURATION_MS = 30 * 60 * 1000;

type RickyEventSnapshot = Awaited<ReturnType<typeof rickyRunStore.listEvents>>[number];

export function formatRickyRunEventSse(event: RickyEventSnapshot): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolve();
    }, { once: true });
  });
}

function createRickyRunEventsStream(rickyRunId: string, requestSignal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const startedAt = Date.now();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let lastSequence = 0;
      try {
        while (!requestSignal.aborted && Date.now() - startedAt < SSE_MAX_DURATION_MS) {
          const events = await rickyRunStore.listEvents(rickyRunId);
          const newEvents = events.filter((event) => event.sequence > lastSequence);
          for (const event of newEvents) {
            controller.enqueue(encoder.encode(formatRickyRunEventSse(event)));
            lastSequence = event.sequence;
          }

          const run = await rickyRunStore.getRun(rickyRunId);
          if (run && RICKY_TERMINAL_STATUSES.has(run.status)) {
            controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
            break;
          }

          await delay(SSE_POLL_INTERVAL_MS, requestSignal);
        }
      } catch (error) {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "workflow:runs:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { rickyRunId } = await params;
  const detail = await rickyRunSupervisor.getDetail(rickyRunId);
  if (!detail || !canAccessRickyRun(auth, detail)) {
    return NextResponse.json({ error: "Ricky run not found" }, { status: 404 });
  }

  if (request.headers.get("accept")?.includes("text/event-stream")) {
    return new Response(createRickyRunEventsStream(rickyRunId, request.signal), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  }

  return NextResponse.json({ rickyRunId, events: detail.events });
}
