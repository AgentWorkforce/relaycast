import { Hono } from "hono";
import type { AppContext, AppEnv } from "../env.js";
import {
  authorizeBearer,
  forwardToWorkspaceDO,
  jsonError,
  scopeMatchesCapability,
  scopeMatchesPath,
} from "../middleware/auth.js";
import {
  MAX_WEBHOOK_GLOBS_PER_SUBSCRIPTION,
  normalizeWebhookPathGlob,
  validateOutboundWebhookUrl,
} from "../webhook-delivery.js";
import type {
  QueuedResponse,
  WebhookDeliveryDeadLetterFeedResponse,
  WebhookDeliveryDeadLetterItem,
  WebhookDeliveryQueueMessage,
} from "../types.js";

export const webhookSubscriptionRoutes = new Hono<AppEnv>();

webhookSubscriptionRoutes.post(
  "/v1/workspaces/:workspaceId/webhooks",
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const body = await readJsonBody(c);
    if ("response" in body) {
      return body.response;
    }
    const pathGlobs = Array.isArray(body.value.pathGlobs)
      ? body.value.pathGlobs
          .filter((glob): glob is string => typeof glob === "string")
          .map((glob) => normalizeWebhookPathGlob(glob))
      : [];
    if (pathGlobs.length === 0) {
      return jsonError(c, 400, "bad_request", "pathGlobs must not be empty");
    }
    if (pathGlobs.length > MAX_WEBHOOK_GLOBS_PER_SUBSCRIPTION) {
      return jsonError(c, 400, "bad_request", "too many pathGlobs");
    }

    const url = typeof body.value.url === "string" ? body.value.url : "";
    const validation = validateOutboundWebhookUrl(
      url,
      c.env.RELAYFILE_WEBHOOK_HOST_ALLOWLIST,
    );
    if (!validation.ok) {
      return jsonError(c, 400, validation.code, validation.message);
    }

    const auth = await requireWebhookCapability(c, workspaceId, pathGlobs);
    if ("response" in auth) {
      return auth.response;
    }
    c.set("authClaims", auth.claims);

    const request = new Request(c.req.raw.url, {
      method: "POST",
      headers: c.req.raw.headers,
      body: JSON.stringify({
        ...body.value,
        url: validation.url,
        pathGlobs,
      }),
    });
    return forwardToWorkspaceDO(
      c,
      workspaceId,
      new URL(c.req.raw.url).pathname,
      request,
    );
  },
);

webhookSubscriptionRoutes.get(
  "/v1/workspaces/:workspaceId/webhooks",
  requireWorkspaceWideReadCapability,
  (c) => forwardToWorkspaceDO(c, requireParam(c, "workspaceId")),
);

webhookSubscriptionRoutes.delete(
  "/v1/workspaces/:workspaceId/webhooks/:subscriptionId",
  requireWorkspaceWideReadCapability,
  (c) => forwardToWorkspaceDO(c, requireParam(c, "workspaceId")),
);

webhookSubscriptionRoutes.get(
  "/v1/workspaces/:workspaceId/webhooks/dlq",
  requireWorkspaceWideReadCapability,
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const limit = clampLimit(c.req.query("limit"), 50, 200);
    const cursor = c.req.query("cursor")?.trim();
    const rows = await c.env.DB.prepare(
      `
        SELECT delivery_id, workspace_id, subscription_id, event_id, url,
               failed_at, attempt_count, last_error, replay_count, status
        FROM webhook_delivery_dead_letters
        WHERE workspace_id = ?
          AND (? IS NULL OR failed_at < ?)
        ORDER BY failed_at DESC
        LIMIT ?
      `,
    )
      .bind(workspaceId, cursor || null, cursor || null, limit + 1)
      .all<Record<string, unknown>>();
    const items = (rows.results ?? []).map(toDeadLetterItem);
    const slice = items.slice(0, limit);
    return c.json({
      items: slice,
      nextCursor:
        items.length > slice.length
          ? (slice[slice.length - 1]?.failedAt ?? null)
          : null,
    } satisfies WebhookDeliveryDeadLetterFeedResponse);
  },
);

webhookSubscriptionRoutes.post(
  "/v1/workspaces/:workspaceId/webhooks/dlq/:deliveryId/replay",
  requireWorkspaceWideReadCapability,
  async (c) => {
    if (!c.env.WEBHOOK_QUEUE) {
      return jsonError(
        c,
        503,
        "webhook_queue_unavailable",
        "webhook queue is not configured",
      );
    }
    const workspaceId = c.req.param("workspaceId");
    const deliveryId = requireParam(c, "deliveryId");
    const row = await c.env.DB.prepare(
      `
        SELECT payload_json
        FROM webhook_delivery_dead_letters
        WHERE workspace_id = ? AND delivery_id = ?
      `,
    )
      .bind(workspaceId, deliveryId)
      .first<{ payload_json: string }>();
    if (!row) {
      return jsonError(
        c,
        404,
        "not_found",
        "webhook delivery dead letter not found",
      );
    }
    const payload = JSON.parse(row.payload_json) as WebhookDeliveryQueueMessage;
    await c.env.WEBHOOK_QUEUE.send({
      ...payload,
      enqueuedAt: new Date().toISOString(),
    } satisfies WebhookDeliveryQueueMessage);
    await c.env.DB.prepare(
      `
        UPDATE webhook_delivery_dead_letters
        SET status = 'queued',
            replay_count = replay_count + 1,
            updated_at = ?
        WHERE workspace_id = ? AND delivery_id = ?
      `,
    )
      .bind(new Date().toISOString(), workspaceId, deliveryId)
      .run();
    return c.json(
      {
        status: "queued",
        id: deliveryId,
        correlationId: c.get("correlationId"),
      } satisfies QueuedResponse,
      202,
    );
  },
);

async function requireWebhookCapability(
  c: AppContext,
  workspaceId: string,
  pathGlobs: readonly string[],
): Promise<
  | {
      claims: AppEnv["Variables"]["authClaims"];
    }
  | { response: Response }
> {
  try {
    const claims = await authorizeBearer(
      c.req.header("Authorization"),
      c.env,
      workspaceId,
      "",
    );
    const authorized = pathGlobs.every((glob) => {
      if (glob === "/" || glob === "/**") {
        return scopeMatchesCapability(claims, "fs:read");
      }
      return scopeMatchesPath(claims, "fs:read", glob);
    });
    if (!authorized) {
      return {
        response: jsonError(
          c,
          403,
          "forbidden",
          "missing required scope: fs:read",
        ),
      };
    }
    return {
      claims: {
        workspaceId: claims.workspaceId,
        agentName: claims.agentName,
        scopes: [...claims.scopes],
        exp: claims.exp,
      },
    };
  } catch (error) {
    const authError = error as {
      status?: number;
      code?: string;
      message?: string;
    };
    return {
      response: jsonError(
        c,
        authError.status ?? 401,
        authError.code ?? "unauthorized",
        authError.message ?? "missing or invalid bearer token",
      ),
    };
  }
}

async function requireWorkspaceWideReadCapability(
  c: AppContext,
  next: () => Promise<void>,
): Promise<Response | void> {
  const workspaceId = requireParam(c, "workspaceId");
  try {
    const claims = await authorizeBearer(
      c.req.header("Authorization"),
      c.env,
      workspaceId,
      "",
    );
    if (!claims.scopes.has("fs:read")) {
      return jsonError(c, 403, "forbidden", "missing required scope: fs:read");
    }
    c.set("authClaims", {
      workspaceId: claims.workspaceId,
      agentName: claims.agentName,
      scopes: [...claims.scopes],
      exp: claims.exp,
    });
    await next();
  } catch (error) {
    const authError = error as {
      status?: number;
      code?: string;
      message?: string;
    };
    return jsonError(
      c,
      authError.status ?? 401,
      authError.code ?? "unauthorized",
      authError.message ?? "missing or invalid bearer token",
    );
  }
}

async function readJsonBody(
  c: AppContext,
): Promise<{ value: Record<string, unknown> } | { response: Response }> {
  try {
    const value = await c.req.raw.clone().json();
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return {
        response: jsonError(c, 400, "bad_request", "invalid json body"),
      };
    }
    return { value: value as Record<string, unknown> };
  } catch {
    return { response: jsonError(c, 400, "bad_request", "invalid json body") };
  }
}

function clampLimit(
  raw: string | undefined,
  fallback: number,
  max: number,
): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(parsed), max);
}

function toDeadLetterItem(
  row: Record<string, unknown>,
): WebhookDeliveryDeadLetterItem {
  return {
    deliveryId: String(row.delivery_id ?? ""),
    workspaceId: String(row.workspace_id ?? ""),
    subscriptionId: String(row.subscription_id ?? ""),
    eventId: String(row.event_id ?? ""),
    url: String(row.url ?? ""),
    failedAt: String(row.failed_at ?? ""),
    attemptCount: Number(row.attempt_count ?? 0),
    lastError: String(row.last_error ?? ""),
    replayCount: Number(row.replay_count ?? 0),
    status:
      row.status === "queued" || row.status === "delivered"
        ? row.status
        : "dead_lettered",
  };
}

function requireParam(c: AppContext, name: string): string {
  const value = c.req.param(name)?.trim();
  if (!value) {
    throw new Error(`missing route param: ${name}`);
  }
  return value;
}
