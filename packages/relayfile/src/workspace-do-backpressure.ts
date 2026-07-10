import type { AppEnv } from "./env.js";

const DEFAULT_WORKSPACE_DO_RETRY_AFTER_SECONDS = 5;
const DEFAULT_ROUTER_MAX_INFLIGHT_REQUESTS = 128;

type FetchHandler = (
  request: Request,
  env: AppEnv["Bindings"],
  ctx: ExecutionContext,
) => Response | Promise<Response>;

type BackpressureDetails = {
  reason: string;
  retryAfterSeconds?: number;
  inflight?: number;
  maxInflight?: number;
};

export async function fetchWorkspaceDOWithBackpressure(
  stub: DurableObjectStub,
  request: Request,
  details: BackpressureDetails = { reason: "durable_object_overloaded" },
): Promise<Response> {
  try {
    return await stub.fetch(request);
  } catch (error) {
    if (!isWorkspaceDOOverloadError(error)) {
      throw error;
    }
    return workspaceDOBackpressureResponse(request, {
      reason: details.reason,
      retryAfterSeconds: details.retryAfterSeconds,
    });
  }
}

export function createRouterBackpressureFetch(
  handler: FetchHandler,
): FetchHandler {
  let inflight = 0;
  return async (request, env, ctx) => {
    const maxInflight = positiveInt(
      env.RELAYFILE_ROUTER_MAX_INFLIGHT_REQUESTS,
      DEFAULT_ROUTER_MAX_INFLIGHT_REQUESTS,
    );
    if (inflight >= maxInflight) {
      return workspaceDOBackpressureResponse(request, {
        reason: "router_inflight_limit",
        retryAfterSeconds: retryAfterSeconds(env),
        inflight,
        maxInflight,
      });
    }

    inflight += 1;
    try {
      return await handler(request, env, ctx);
    } catch (error) {
      if (!isWorkspaceDOOverloadError(error)) {
        throw error;
      }
      return workspaceDOBackpressureResponse(request, {
        reason: "durable_object_overloaded",
        retryAfterSeconds: retryAfterSeconds(env),
      });
    } finally {
      inflight -= 1;
    }
  };
}

export function workspaceDOBackpressureResponse(
  request: Request,
  details: BackpressureDetails = { reason: "durable_object_overloaded" },
): Response {
  const retryAfter =
    details.retryAfterSeconds ?? DEFAULT_WORKSPACE_DO_RETRY_AFTER_SECONDS;
  return new Response(
    JSON.stringify({
      code: "workspace_busy",
      message:
        "workspace durable object is busy; retry after the advertised delay",
      correlationId: request.headers.get("X-Correlation-Id")?.trim() ?? "",
      retryAfterSeconds: retryAfter,
      reason: details.reason,
      ...(typeof details.inflight === "number"
        ? { inflight: details.inflight }
        : {}),
      ...(typeof details.maxInflight === "number"
        ? { maxInflight: details.maxInflight }
        : {}),
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(retryAfter),
      },
    },
  );
}

export function isWorkspaceDOOverloadError(error: unknown): boolean {
  const message =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : String(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes("durable object is overloaded") ||
    normalized.includes("requests queued for too long") ||
    normalized.includes("isolate exceeded its memory limit") ||
    normalized.includes("durable object's isolate exceeded") ||
    normalized.includes("durable object reset")
  );
}

function retryAfterSeconds(
  env: Pick<
    AppEnv["Bindings"],
    "RELAYFILE_DO_RETRY_AFTER_SECONDS" | "RELAYFILE_ROUTER_RETRY_AFTER_SECONDS"
  >,
): number {
  return positiveInt(
    env.RELAYFILE_ROUTER_RETRY_AFTER_SECONDS ??
      env.RELAYFILE_DO_RETRY_AFTER_SECONDS,
    DEFAULT_WORKSPACE_DO_RETRY_AFTER_SECONDS,
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
