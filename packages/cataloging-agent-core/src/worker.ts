import { Hono } from "hono";

import {
  resolveCatalogWorkspaces,
  resolveRelayfileBaseUrl,
  resolveSubscriberNamespace,
  subscriberObjectName,
  getInsight,
  type CatalogingAgentConfig,
  type CatalogingWorkerEnv,
} from "./config.js";

export function buildCatalogingWorker<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
): Hono<{ Bindings: TEnv }> {
  const app = new Hono<{ Bindings: TEnv }>();

  app.onError((error, c) => {
    logCataloging("request_error", {
      domain: config.domain,
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      error: errorMessage(error),
    });
    return c.json(
      {
        status: "error",
        domain: config.domain,
        error: errorMessage(error),
      },
      500,
    );
  });

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.post("/cron", async (c) => {
    const startedAt = Date.now();
    const workspaces = await resolveCatalogWorkspaces(config, c.env);
    const relayfileUrl = await resolveRelayfileBaseUrl(config, c.env);
    const results = await Promise.all(
      workspaces.map((workspaceId) =>
        fetchSubscriber(config, c.env, workspaceId, "/run-overdue", {
          method: "POST",
          body: JSON.stringify({
            workspaceId,
            domain: config.domain,
            relayfileUrl,
          }),
        }),
      ),
    );
    const failed = results.filter((result) => !result.ok);
    logCataloging(failed.length > 0 ? "cron_completed_with_failures" : "cron_completed", {
      domain: config.domain,
      checked: results.length,
      failed: failed.length,
      durationMs: Date.now() - startedAt,
      failures: failed.map((result) => ({
        workspaceId: result.workspaceId,
        status: result.status,
        error: result.error,
        body: summarizeBody(result.body),
      })),
    });

    return c.json({
      status: "ok",
      domain: config.domain,
      checked: results.length,
      results,
    });
  });

  app.post("/run/:insightId", async (c) => {
    const startedAt = Date.now();
    const workspaceId = workspaceIdFromRequest(c.req.raw);
    if (!workspaceId) {
      return c.json({ error: "missing workspaceId" }, 400);
    }

    const relayfileUrl = await resolveRelayfileBaseUrl(config, c.env);
    const insightId = c.req.param("insightId");
    if (!getInsight(config, insightId)) {
      return c.json({ error: "unknown insight", insightId }, 404);
    }

    const response = await subscriberFetch(config, c.env, workspaceId, `/run/${encodeURIComponent(insightId)}`, {
      method: "POST",
      headers: catalogingHeaders(workspaceId),
      body: JSON.stringify({
        workspaceId,
        domain: config.domain,
        relayfileUrl,
      }),
    });

    logCataloging(response.ok ? "manual_run_forwarded" : "manual_run_failed", {
      domain: config.domain,
      workspaceId,
      insightId,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response;
  });

  app.post("/ensure-subscriptions", async (c) => {
    const startedAt = Date.now();
    const workspaces = await resolveCatalogWorkspaces(config, c.env);
    const relayfileUrl = await resolveRelayfileBaseUrl(config, c.env);
    const results = await Promise.all(
      workspaces.map((workspaceId) =>
        fetchSubscriber(config, c.env, workspaceId, "/subscribe", {
          method: "POST",
          body: JSON.stringify({
            workspaceId,
            domain: config.domain,
            relayfileUrl,
          }),
        }),
      ),
    );
    const failed = results.filter((result) => !result.ok);
    logCataloging(failed.length > 0 ? "ensure_subscriptions_completed_with_failures" : "ensure_subscriptions_completed", {
      domain: config.domain,
      checked: results.length,
      subscribed: results.filter((result) => result.ok).length,
      failed: failed.length,
      durationMs: Date.now() - startedAt,
      failures: failed.map((result) => ({
        workspaceId: result.workspaceId,
        status: result.status,
        error: result.error,
        body: summarizeBody(result.body),
      })),
    });

    return c.json({
      status: "ok",
      domain: config.domain,
      subscribed: results.filter((result) => result.ok).length,
      results,
    });
  });

  app.get("/status", async (c) => {
    const workspaceId = workspaceIdFromRequest(c.req.raw);
    if (!workspaceId) {
      return c.json({ error: "missing workspaceId" }, 400);
    }

    return subscriberFetch(config, c.env, workspaceId, "/status", {
      method: "GET",
      headers: catalogingHeaders(workspaceId),
    });
  });

  app.get("/statuses", async (c) => {
    const workspaces = await resolveCatalogWorkspaces(config, c.env);
    const results = await Promise.all(
      workspaces.map((workspaceId) =>
        fetchSubscriber(config, c.env, workspaceId, "/status", {
          method: "GET",
        }),
      ),
    );

    return c.json({
      status: "ok",
      domain: config.domain,
      checked: results.length,
      unhealthy: results.filter((result) => !result.ok).length,
      results,
    });
  });

  return app;
}

async function fetchSubscriber<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
  env: TEnv,
  workspaceId: string,
  path: string,
  init: RequestInit,
): Promise<ForwardResult> {
  try {
    const response = await subscriberFetch(config, env, workspaceId, path, {
      ...init,
      headers: catalogingHeaders(workspaceId, init.headers),
    });
    return {
      workspaceId,
      ok: response.ok,
      status: response.status,
      body: await readResponseBody(response),
    };
  } catch (error) {
    logCataloging("subscriber_forward_error", {
      domain: config.domain,
      workspaceId,
      path,
      error: errorMessage(error),
    });
    return {
      workspaceId,
      ok: false,
      status: 0,
      error: errorMessage(error),
    };
  }
}

function subscriberFetch<TEnv extends CatalogingWorkerEnv>(
  config: CatalogingAgentConfig<TEnv>,
  env: TEnv,
  workspaceId: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  const namespace = resolveSubscriberNamespace(config, env);
  const id = namespace.idFromName(subscriberObjectName(config.domain, workspaceId));
  const stub = namespace.get(id);
  return stub.fetch(new Request(`https://cataloging-subscriber.local${path}`, init));
}

function workspaceIdFromRequest(request: Request): string | null {
  const url = new URL(request.url);
  return (
    readHeader(request.headers, "x-workspace-id") ??
    readHeader(request.headers, "x-relayfile-workspace-id") ??
    url.searchParams.get("workspaceId")?.trim() ??
    url.searchParams.get("workspace_id")?.trim() ??
    null
  );
}

function catalogingHeaders(workspaceId: string, existing?: HeadersInit): Headers {
  const headers = new Headers(existing);
  headers.set("content-type", "application/json");
  headers.set("x-workspace-id", workspaceId);
  return headers;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json().catch(() => null);
  }
  return response.text().catch(() => "");
}

function readHeader(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value?.trim() || undefined;
}

function logCataloging(event: string, fields: Record<string, unknown>): void {
  const payload = {
    event,
    at: new Date().toISOString(),
    ...fields,
  };
  const line = `[cataloging] ${JSON.stringify(payload)}`;
  if (event.includes("error") || event.includes("failure")) {
    console.error(line);
    return;
  }
  console.log(line);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function summarizeBody(body: unknown): unknown {
  if (typeof body === "string") {
    return body.slice(0, 500);
  }
  return body;
}

interface ForwardResult {
  workspaceId: string;
  ok: boolean;
  status: number;
  body?: unknown;
  error?: string;
}
