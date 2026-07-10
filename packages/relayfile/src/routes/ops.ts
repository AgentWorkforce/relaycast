import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import {
  forwardToWorkspaceDO,
  requireBearerScope,
  requireCorrelationId,
} from "../middleware/auth.js";

export const opsRoutes = new Hono<AppEnv>();

opsRoutes.get(
  "/v1/workspaces/:workspaceId/ops",
  requireBearerScope("ops:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

opsRoutes.get(
  "/v1/workspaces/:workspaceId/ops/:opId",
  requireBearerScope("ops:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

opsRoutes.post(
  "/v1/workspaces/:workspaceId/ops/:opId/replay",
  requireBearerScope("ops:replay"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);

// Mirrors the relayfile daemon's `relayfile writeback list --state <state>`
// surface so cloud-hosted workspaces accept the same query the local-mount
// CLI uses. See `handleListWritebacks` for the response shape (a
// `WritebackListResponse` whose items conform to the `@relayfile/sdk`
// `WritebackItem` contract, including the canonical
// `WritebackDeadLetterError` payload on dead-lettered rows).
opsRoutes.get(
  "/v1/workspaces/:workspaceId/writeback",
  requireBearerScope("ops:read"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, c.req.param("workspaceId")),
);
