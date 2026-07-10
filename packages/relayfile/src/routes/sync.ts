import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  forwardToWorkspaceDO,
  requireBearerScope,
  requireCorrelationId,
} from "../middleware/auth.js";

export const syncRoutes = new Hono<AppEnv>();

syncRoutes.get(
  "/v1/workspaces/:workspaceId/sync/status",
  requireBearerScope("sync:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.get(
  "/v1/workspaces/:workspaceId/sync/ingress",
  requireBearerScope("sync:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.get(
  "/v1/workspaces/:workspaceId/sync/dead-letter",
  requireBearerScope("sync:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.get(
  "/v1/workspaces/:workspaceId/sync/dead-letter/:envelopeId",
  requireBearerScope("sync:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.post(
  "/v1/workspaces/:workspaceId/sync/dead-letter/:envelopeId/ack",
  requireBearerScope("sync:trigger"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.post(
  "/v1/workspaces/:workspaceId/sync/dead-letter/:envelopeId/replay",
  requireBearerScope("sync:trigger"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.post(
  "/v1/workspaces/:workspaceId/sync/webhook-health",
  requireBearerScope("sync:trigger"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.post(
  "/v1/workspaces/:workspaceId/sync/refresh",
  requireBearerScope("sync:trigger"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.get(
  "/v1/workspaces/:workspaceId/writeback/pending",
  requireBearerScope("sync:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

syncRoutes.post(
  "/v1/workspaces/:workspaceId/writeback/:itemId/ack",
  requireBearerScope("sync:trigger"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);
