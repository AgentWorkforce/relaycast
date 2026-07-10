import { NextRequest, NextResponse } from "next/server";
import {
  CloudAgentBoxError,
  defaultCloudAgentBoxDeps,
  readCloudAgentBox,
  type CloudAgentBoxDeps,
  type CloudAgentBoxInput,
  type CloudAgentBoxResponse,
  type CloudAgentBoxWarmPhase,
} from "../box-manager";
import {
  isCloudAgentWarmViaQueueEnabled,
  readCloudAgentBoxViaQueue,
} from "../warm-route";
import {
  jsonError,
  requireWorkspaceSandboxAuth,
} from "../../../../sandboxes/sandbox-utils";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = {
  params: Promise<{ workspaceId: string; cloudAgentId: string }>;
};

export type CloudAgentBoxStatusEvent = {
  sandboxId: string;
  status: "warming" | "ready" | "failed" | "stopping" | "stopped";
  phase?: CloudAgentBoxWarmPhase;
  etaMs?: number;
  currentStep?: string;
  error?: string;
  emittedAt: string;
};

type CloudAgentBoxErrorEvent = {
  error: string;
  emittedAt: string;
};

type StreamOptions = {
  pollIntervalMs?: number;
  signal?: AbortSignal | null;
  now?: () => Date;
  readStatusEvent?: (input: {
    deps: CloudAgentBoxDeps;
    request: CloudAgentBoxInput;
    queueEnabled: boolean;
    now: () => Date;
  }) => Promise<CloudAgentBoxStatusEvent>;
};

const DEFAULT_STATUS_POLL_INTERVAL_MS = 1_000;

function routeError(error: unknown): NextResponse {
  if (error instanceof CloudAgentBoxError) {
    return jsonError(error.message, error.code, error.status);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error("[cloud-agent-box-events] request failed:", message);
  return jsonError("Failed to stream cloud agent box status", "box_events_failed", 503);
}

function terminalStatus(status: CloudAgentBoxStatusEvent["status"]): boolean {
  return status === "ready" || status === "failed" || status === "stopped";
}

function boxStatusEvent(
  response: CloudAgentBoxResponse,
  now: () => Date = () => new Date(),
): CloudAgentBoxStatusEvent {
  return {
    sandboxId: response.sandboxId,
    status: response.status,
    ...(response.phase ? { phase: response.phase } : {}),
    ...(response.etaMs !== undefined ? { etaMs: response.etaMs } : {}),
    ...(response.currentStep ? { currentStep: response.currentStep } : {}),
    ...(response.error ? { error: response.error } : {}),
    emittedAt: now().toISOString(),
  };
}

function sseStatusFrame(event: CloudAgentBoxStatusEvent): string {
  return `event: status\ndata: ${JSON.stringify(event)}\n\n`;
}

function sseErrorFrame(event: CloudAgentBoxErrorEvent): string {
  return `event: error\ndata: ${JSON.stringify(event)}\n\n`;
}

async function readStatusEvent(input: {
  deps: CloudAgentBoxDeps;
  request: CloudAgentBoxInput;
  queueEnabled: boolean;
  now?: () => Date;
}): Promise<CloudAgentBoxStatusEvent> {
  const response = input.queueEnabled
    ? await readCloudAgentBoxViaQueue(input.deps, input.request)
    : await readCloudAgentBox(input.deps, input.request);
  return boxStatusEvent(response, input.now);
}

export function createCloudAgentBoxStatusStream(input: {
  deps: CloudAgentBoxDeps;
  request: CloudAgentBoxInput;
  queueEnabled?: boolean;
  options?: StreamOptions;
}): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const pollIntervalMs = Math.max(
    100,
    Math.floor(input.options?.pollIntervalMs ?? DEFAULT_STATUS_POLL_INTERVAL_MS),
  );
  const queueEnabled = input.queueEnabled ?? isCloudAgentWarmViaQueueEnabled();
  const now = input.options?.now ?? (() => new Date());
  const signal = input.options?.signal ?? null;
  const readEvent = input.options?.readStatusEvent ?? readStatusEvent;
  let cleanup = () => undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let lastPayload = "";
      let timer: ReturnType<typeof setTimeout> | null = null;

      cleanup = () => {
        if (closed) return;
        closed = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        signal?.removeEventListener("abort", onAbort);
      };

      const close = () => {
        if (closed) return;
        cleanup();
        controller.close();
      };

      const onAbort = () => close();

      const poll = async () => {
        if (closed) return;
        try {
          const event = await readEvent({
            deps: input.deps,
            request: input.request,
            queueEnabled,
            now,
          });
          if (closed) return;
          const payload = JSON.stringify({
            sandboxId: event.sandboxId,
            status: event.status,
            phase: event.phase,
            etaMs: event.etaMs,
            currentStep: event.currentStep,
            error: event.error,
          });
          if (payload !== lastPayload) {
            lastPayload = payload;
            controller.enqueue(encoder.encode(sseStatusFrame(event)));
          }
          if (terminalStatus(event.status)) {
            close();
            return;
          }
        } catch (error) {
          if (closed) return;
          const event: CloudAgentBoxErrorEvent = {
            error: error instanceof Error ? error.message : String(error),
            emittedAt: now().toISOString(),
          };
          controller.enqueue(encoder.encode(sseErrorFrame(event)));
          close();
          return;
        }
        timer = setTimeout(poll, pollIntervalMs);
      };

      if (signal?.aborted) {
        close();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      void poll();
    },
    cancel() {
      cleanup();
    },
  });
}

export function createCloudAgentBoxEventsRouteHandlers(
  deps: CloudAgentBoxDeps = defaultCloudAgentBoxDeps(),
) {
  async function readInput(request: NextRequest, context: RouteContext) {
    const authResult = await requireWorkspaceSandboxAuth(request, context);
    if (!authResult.ok) {
      return authResult.response;
    }
    const { cloudAgentId } = await context.params;
    if (!cloudAgentId) {
      return jsonError("Cloud agent not found", "cloud_agent_not_found", 404);
    }
    return {
      auth: authResult.auth,
      urlWorkspaceId: authResult.workspaceId,
      cloudAgentId,
      workspaceToken: null,
    };
  }

  async function GET(request: NextRequest, context: RouteContext) {
    const input = await readInput(request, context);
    if (input instanceof NextResponse) {
      return input;
    }
    try {
      return new Response(
        createCloudAgentBoxStatusStream({
          deps,
          request: input,
          options: { signal: request.signal },
        }),
        {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        },
      );
    } catch (error) {
      return routeError(error);
    }
  }

  return { GET };
}

export const { GET } = createCloudAgentBoxEventsRouteHandlers();
