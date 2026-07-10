import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  forwardToWorkspaceDO,
  jsonError,
  requireBearerScope,
  requireCorrelationId,
  verifyInternalHmac,
} from "../middleware/auth.js";
import { withWorkspaceWriteAdmission } from "../middleware/workspace-write-admission.js";

export const webhookRoutes = new Hono<AppEnv>();

webhookRoutes.post(
  "/v1/internal/webhook-envelopes",
  requireCorrelationId(),
  async (c) => {
    const body = await c.req.raw.clone().arrayBuffer();

    try {
      await verifyInternalHmac(
        c.req.raw.headers,
        body,
        c.env.INTERNAL_HMAC_SECRET,
      );
    } catch (error) {
      const authError = error as {
        status: number;
        code: string;
        message: string;
      };
      return jsonError(c, authError.status, authError.code, authError.message);
    }

    let workspaceId = "";
    try {
      const payload = JSON.parse(new TextDecoder().decode(body)) as {
        workspaceId?: unknown;
      };
      workspaceId =
        typeof payload.workspaceId === "string"
          ? payload.workspaceId.trim()
          : "";
    } catch {
      return jsonError(c, 400, "bad_request", "invalid json body");
    }

    if (!workspaceId) {
      return jsonError(c, 400, "bad_request", "missing workspaceId");
    }

    return withWorkspaceWriteAdmission(c, workspaceId, "webhook_envelope", () =>
      forwardToWorkspaceDO(c, workspaceId),
    );
  },
);

webhookRoutes.post(
  "/v1/workspaces/:workspaceId/webhooks/ingest",
  requireBearerScope("sync:trigger"),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    return withWorkspaceWriteAdmission(c, workspaceId, "webhook_ingest", () =>
      forwardToWorkspaceDO(c, workspaceId),
    );
  },
);
