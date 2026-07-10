import { getCloudflareContext } from "@/lib/cloudflare-context";
import { tryResourceValue } from "@/lib/env";
import {
  requireAuthRunAccess,
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import type { NextRequest } from "next/server";

type ServiceBinding = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

export type ProactiveRuntimeIntegrationWatchDispatchInput = {
  workspaceId: string;
  provider: string;
  eventType: string;
  connectionId?: string | null;
  deliveryId?: string | null;
  paths?: readonly string[];
  payload?: unknown;
  occurredAt?: string;
};

export type ProactiveRuntimeIntegrationWatchDispatchResult = {
  matched: number;
  delivered: number;
  failed: number;
};

export type ProactiveRuntimeRunReadKind = "list" | "detail" | "envelope";

export type ProactiveRuntimeRunReadContext = {
  kind: ProactiveRuntimeRunReadKind;
  workspaceId: string;
  agentId: string;
  runId?: string;
  requireWorkspaceAccess: boolean;
};

function getProactiveRuntimeWorker(): ServiceBinding | null {
  try {
    const env = getCloudflareContext({ async: false }).env;
    const binding = env?.PROACTIVE_RUNTIME_WORKER;
    if (binding && typeof binding === "object" && "fetch" in binding) {
      return binding as ServiceBinding;
    }
  } catch {
    // Lambda/local routes cannot service-bind to the Cloudflare-only worker.
  }
  return null;
}

export async function fetchProactiveRuntimeWorker(
  path: string,
  init: RequestInit,
): Promise<Response> {
  const worker = getProactiveRuntimeWorker();
  if (!worker) {
    return Response.json(
      { ok: false, error: "PROACTIVE_RUNTIME_WORKER service binding is not configured" },
      { status: 503 },
    );
  }
  return worker.fetch(new Request(`https://proactive-runtime.internal${path}`, init));
}

function internalSecretHeaders(): Headers {
  const secret =
    tryResourceValue("AgentGatewayInternalSecret") ??
    process.env.AGENT_GATEWAY_INTERNAL_SECRET?.trim();
  if (!secret) {
    throw new Error("AgentGatewayInternalSecret is not configured");
  }
  return new Headers({
    "content-type": "application/json",
    "x-agent-gateway-secret": secret,
  });
}

function readErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const error = (value as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : null;
}

export async function dispatchIntegrationWatchEvent(
  input: ProactiveRuntimeIntegrationWatchDispatchInput,
): Promise<ProactiveRuntimeIntegrationWatchDispatchResult> {
  const response = await fetchProactiveRuntimeWorker(
    "/api/internal/proactive-runtime/integration-watch/dispatch",
    {
      method: "POST",
      headers: internalSecretHeaders(),
      body: JSON.stringify(input),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body || typeof body !== "object" || !(body as { ok?: unknown }).ok) {
    throw new Error(
      readErrorMessage(body) ??
        `Proactive runtime integration-watch dispatch failed with HTTP ${response.status}`,
    );
  }
  const data = (body as { data?: unknown }).data;
  if (!data || typeof data !== "object") {
    throw new Error("Proactive runtime integration-watch dispatch returned no data");
  }
  return data as ProactiveRuntimeIntegrationWatchDispatchResult;
}

export async function proxyProactiveRuntimeRequest(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();
  const response = await fetchProactiveRuntimeWorker(`${url.pathname}${url.search}`, {
    method: request.method,
    headers,
    body,
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function canReadDeploymentRuns(
  auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>,
): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:read")
  );
}

async function authorizeDeploymentRunRead(
  request: NextRequest,
  context: ProactiveRuntimeRunReadContext,
): Promise<{ workspaceId: string } | Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return Response.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (!canReadDeploymentRuns(auth)) {
    return Response.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }
  if (context.requireWorkspaceAccess && !hasWorkspaceAccess(auth, context.workspaceId)) {
    return Response.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }
  const workspaceId = context.workspaceId || auth.workspaceId;
  if (context.runId && !requireAuthRunAccess(auth, context.runId)) {
    return Response.json(
      { error: "Deployment run not found", code: "not_found" },
      { status: 404 },
    );
  }
  return { workspaceId };
}

export async function proxyAuthorizedDeploymentRunRead(
  request: NextRequest,
  context: ProactiveRuntimeRunReadContext,
): Promise<Response> {
  const authorized = await authorizeDeploymentRunRead(request, context);
  if (authorized instanceof Response) {
    return authorized;
  }

  const url = new URL(request.url);
  const response = await fetchProactiveRuntimeWorker(
    `/api/internal/proactive-runtime/deployment-run-observability/read${url.search}`,
    {
      method: "POST",
      headers: internalSecretHeaders(),
      body: JSON.stringify({
        kind: context.kind,
        workspaceId: authorized.workspaceId,
        agentId: context.agentId,
        ...(context.runId ? { runId: context.runId } : {}),
      }),
    },
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
