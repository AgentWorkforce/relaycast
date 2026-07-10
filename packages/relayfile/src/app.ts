import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { AppEnv } from "./env.js";
import { handleError, handleNotFound } from "./middleware/error.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { adminRoutes } from "./routes/admin.js";
import { fsRoutes } from "./routes/fs.js";
import { healthRoutes } from "./routes/health.js";
import { importRoutes } from "./routes/import.js";
import { integrationRoutes } from "./routes/integrations.js";
import { opsRoutes } from "./routes/ops.js";
import { syncRoutes } from "./routes/sync.js";
import { webhookSubscriptionRoutes } from "./routes/webhook-subscriptions.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { emitMetric } from "./durable-objects/metrics.js";

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", cors());
  app.use("*", secureHeaders());
  // Rate-limit before any other work — must run after CORS/headers
  // (so the 429 carries CORS headers and the secure-headers policy)
  // but before request-id tagging so the limiter's KV reads don't
  // hold a request slot when the rest of the handler isn't going to
  // execute. See packages/router/src/rate-limit.ts for the design.
  app.use("*", rateLimitMiddleware);
  app.use("*", async (c, next) => {
    const requestId = crypto.randomUUID();
    const correlationId = c.req.header("X-Correlation-Id")?.trim() || requestId;

    c.set("requestId", requestId);
    c.set("correlationId", correlationId);

    await next();

    c.header("X-Request-Id", requestId);
    c.header("X-Correlation-Id", correlationId);
  });
  app.use("*", async (c, next) => {
    await next();
    const { route, workspaceId } = normalizeRouteMetricLabels(
      c.req.method,
      new URL(c.req.url).pathname,
    );
    emitMetric("relayfile_worker_route_requests_total", 1, {
      route,
      method: c.req.method.toUpperCase(),
      status: c.res.status,
      workspace_id: workspaceId ?? "",
    });
  });

  app.route("/", healthRoutes);
  app.route("/", integrationRoutes);
  app.route("/", fsRoutes);
  app.route("/", importRoutes);
  app.route("/", syncRoutes);
  app.route("/", webhookSubscriptionRoutes);
  app.route("/", webhookRoutes);
  app.route("/", opsRoutes);
  app.route("/", adminRoutes);

  app.notFound(handleNotFound);
  app.onError(handleError);

  return app;
}

export const app = createApp();

function normalizeRouteMetricLabels(
  method: string,
  pathname: string,
): { route: string; workspaceId?: string } {
  const workspaceMatch = pathname.match(/^\/v1\/workspaces\/([^/]+)(\/.*)?$/);
  if (workspaceMatch) {
    const suffix = normalizeWorkspaceMetricSuffix(workspaceMatch[2] || "");
    return {
      route: `${method.toUpperCase()} /v1/workspaces/:workspaceId${suffix}`,
      workspaceId: workspaceMatch[1],
    };
  }
  return {
    route: `${method.toUpperCase()} ${normalizeGlobalMetricPath(pathname)}`,
  };
}

function normalizeWorkspaceMetricSuffix(suffix: string): string {
  if (suffix.match(/^\/ops\/[^/]+\/replay$/)) {
    return "/ops/:opId/replay";
  }
  if (suffix.match(/^\/ops\/[^/]+$/)) {
    return "/ops/:opId";
  }
  if (suffix.match(/^\/sync\/dead-letter\/[^/]+\/ack$/)) {
    return "/sync/dead-letter/:envelopeId/ack";
  }
  if (suffix.match(/^\/sync\/dead-letter\/[^/]+\/replay$/)) {
    return "/sync/dead-letter/:envelopeId/replay";
  }
  if (suffix.match(/^\/sync\/dead-letter\/[^/]+$/)) {
    return "/sync/dead-letter/:envelopeId";
  }
  if (suffix.match(/^\/webhooks\/dlq\/[^/]+\/replay$/)) {
    return "/webhooks/dlq/:deliveryId/replay";
  }
  if (suffix.match(/^\/webhooks\/[^/]+$/)) {
    return "/webhooks/:subscriptionId";
  }
  if (suffix.match(/^\/writeback\/[^/]+\/ack$/)) {
    return "/writeback/:itemId/ack";
  }
  if (suffix.match(/^\/integrations\/[^/]+$/)) {
    return "/integrations/:provider";
  }
  return suffix;
}

function normalizeGlobalMetricPath(pathname: string): string {
  if (pathname.match(/^\/v1\/admin\/replay\/envelope\/[^/]+$/)) {
    return "/v1/admin/replay/envelope/:envelopeId";
  }
  if (pathname.match(/^\/v1\/admin\/replay\/op\/[^/]+$/)) {
    return "/v1/admin/replay/op/:opId";
  }
  return pathname;
}
