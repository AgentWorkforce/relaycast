import { Hono } from "hono";
import type { AppContext, AppEnv } from "../env.js";
import {
  getWorkspaceStub,
  jsonError,
  verifyInternalHmac,
} from "../middleware/auth.js";
import { fetchWorkspaceDOWithBackpressure } from "../workspace-do-backpressure.js";

export const integrationRoutes = new Hono<AppEnv>();

integrationRoutes.put(
  "/v1/workspaces/:workspaceId/integrations/:provider",
  async (c) => forwardInternalCredentialPush(c),
);

async function forwardInternalCredentialPush(c: AppContext): Promise<Response> {
  const rawBody = await c.req.raw.clone().arrayBuffer();
  try {
    await verifyInternalHmac(
      c.req.raw.headers,
      rawBody,
      c.env.INTERNAL_HMAC_SECRET,
    );
  } catch (error) {
    const authError =
      error && typeof error === "object" && "status" in error
        ? (error as { status: number; code: string; message: string })
        : { status: 401, code: "unauthorized", message: "unauthorized" };
    return jsonError(c, authError.status, authError.code, authError.message);
  }

  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) {
    return jsonError(c, 400, "bad_request", "missing workspaceId");
  }
  const url = new URL(c.req.url);
  const headers = new Headers(c.req.raw.headers);
  headers.set("X-Workspace-Id", workspaceId);
  return fetchWorkspaceDOWithBackpressure(
    getWorkspaceStub(c, workspaceId),
    new Request(url.toString(), {
      method: "PUT",
      headers,
      body: rawBody,
      redirect: "manual",
    }),
    {
      reason: "durable_object_overloaded",
      retryAfterSeconds: positiveInt(c.env.RELAYFILE_DO_RETRY_AFTER_SECONDS, 5),
    },
  );
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
