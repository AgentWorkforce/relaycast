import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import {
  resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess,
} from "@/lib/workspaces/workspace-integration-identity";
import {
  PersonaDeployError,
  destroyAgent,
} from "@/lib/proactive-runtime/persona-deploy";
import { jsonError, type ErrorResponse } from "../../sandboxes/sandbox-utils";

type DestroyRouteContext = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

type DestroyResponse = {
  agentId: string;
  status: "destroyed";
  destroyedAt: string;
  cancelledScheduleIds: string[];
};

function canDestroy(
  auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>,
): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:write")
  );
}

function errorResponse(
  error: unknown,
): NextResponse<ErrorResponse | { error: string; code: string; details?: unknown }> {
  if (error instanceof PersonaDeployError) {
    return NextResponse.json(
      { error: error.message, code: error.code, details: error.details },
      { status: error.status },
    );
  }

  console.error(
    "[persona-bundle-destroy] request failed:",
    error instanceof Error ? error.message : String(error),
  );
  return NextResponse.json(
    { error: "Failed to destroy agent", code: "destroy_failed" },
    { status: 500 },
  );
}

export async function DELETE(
  request: NextRequest,
  context: DestroyRouteContext,
): Promise<
  NextResponse<
    DestroyResponse | ErrorResponse | { error: string; code: string; details?: unknown }
  >
> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (!canDestroy(auth)) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId, agentId } = await context.params;
  if (!workspaceId) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  if (!agentId) {
    return jsonError("Agent not found", "agent_not_found", 404);
  }
  // Accept either workspace id form (relaycast `rw_*` or app UUID) — the CLI
  // sends the relaycast id in the URL while the token's auth.workspaceId is the
  // app UUID. Exact-equality `hasWorkspaceAccess` 403s when they differ; deploy/
  // list use this identity-aware check. Thread the resolved APP id into
  // `destroyAgent` (agents.workspace_id is keyed by app UUID).
  let identity: Awaited<ReturnType<typeof resolveWorkspaceIntegrationIdentity>>;
  try {
    identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  } catch {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return jsonError("Forbidden", "forbidden", 403);
  }
  const appWorkspaceId = identity.appWorkspaceId ?? identity.requestedWorkspaceId;
  if (!isUuid(appWorkspaceId)) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }

  try {
    const result = await destroyAgent({
      workspaceId: appWorkspaceId,
      agentId,
      userId: auth.userId,
    });
    if (!result) {
      return jsonError("Agent not found", "agent_not_found", 404);
    }

    return NextResponse.json<DestroyResponse>(
      {
        agentId: result.agentId,
        status: "destroyed",
        destroyedAt: result.destroyedAt.toISOString(),
        cancelledScheduleIds: result.cancelledScheduleIds,
      },
      { status: 200 },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
