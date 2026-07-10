import { Hono } from "hono";
import { purgeWorkspaceCompletely } from "../cleanup.js";
import type { AppEnv } from "../env.js";
import {
  forwardToWorkspaceDO,
  getAdminStubKey,
  requireBearerAnyScope,
  requireBearerScope,
  requireCorrelationId,
} from "../middleware/auth.js";

export const adminRoutes = new Hono<AppEnv>();

/**
 * `DELETE /v1/workspaces/:workspaceId` — hard-delete an entire workspace
 * (R2 object bodies, DO SQLite storage, and D1 metadata).
 *
 * Called by the cloud control plane after it has revoked the workspace's
 * provider integrations. Gated by the `admin:workspace` scope so only a
 * trusted control-plane token (minted server-side) can trigger destruction
 * — never a per-agent fs:read/fs:write token. Responds `200` with the
 * {@link WorkspacePurgeResult}. Idempotent: purging an already-deleted
 * workspace returns `200` with zeroed counts so a retried delete succeeds.
 */
adminRoutes.delete(
  "/v1/workspaces/:workspaceId",
  requireBearerScope("admin:workspace"),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    const result = await purgeWorkspaceCompletely(c.env, workspaceId);
    return c.json(result, 200);
  },
);

adminRoutes.get(
  "/v1/admin/backends",
  requireBearerAnyScope("admin:read", "admin:replay"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, getAdminStubKey(c)),
);

adminRoutes.get(
  "/v1/admin/ingress",
  requireBearerAnyScope("admin:read", "admin:replay"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, getAdminStubKey(c)),
);

adminRoutes.get(
  "/v1/admin/sync",
  requireBearerAnyScope("admin:read", "admin:replay"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, getAdminStubKey(c)),
);

adminRoutes.post(
  "/v1/admin/replay/envelope/:envelopeId",
  requireBearerScope("admin:replay"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, getAdminStubKey(c)),
);

adminRoutes.post(
  "/v1/admin/replay/op/:opId",
  requireBearerScope("admin:replay"),
  requireCorrelationId(),
  async (c) => forwardToWorkspaceDO(c, getAdminStubKey(c)),
);

/**
 * `POST /v1/workspaces/:workspaceId/admin/drain-legacy-writeback-drafts`
 * (cloud#2029 #2) — operator-triggered, bounded legacy-draft drain. Gated by
 * `admin:workspace` (the destructive-capable control-plane scope, same as the
 * workspace purge) since the destructive pass deletes draft files. Forwards to
 * the workspace DO handler, which dry-runs by default; the operator passes the
 * Slack command roots + `dryRun:false` to execute. Manual-first: NO automatic
 * alarm runs this. See handlers/drain-legacy-drafts.ts for the eligibility +
 * writeback-suppressed-removal safety contract.
 */
adminRoutes.post(
  "/v1/workspaces/:workspaceId/admin/drain-legacy-writeback-drafts",
  requireBearerScope("admin:workspace"),
  requireCorrelationId(),
  async (c) => {
    const workspaceId = c.req.param("workspaceId");
    return forwardToWorkspaceDO(
      c,
      workspaceId,
      "/internal/drain-legacy-writeback-drafts",
    );
  },
);
