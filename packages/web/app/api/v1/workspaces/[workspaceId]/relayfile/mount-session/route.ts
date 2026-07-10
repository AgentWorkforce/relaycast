import { NextRequest, NextResponse } from "next/server";
import {
  areValidRequestedScopes,
  createWorkspaceJoinAccess,
  isValidWorkspaceId,
} from "@/lib/relay-workspaces";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  callerAllowsRequestedScopes,
  NIL_UUID,
  requestedMountSessionScopes,
  validateMountSessionBody,
} from "@/lib/relayfile-mount-session";
import {
  createCloudWorkspaceRegistry,
  hasWorkspaceOwnerAccess,
  resolveConfiguredRelaycastUrl,
} from "@/lib/workspace-registry";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";

type MountSessionRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

function jsonError(error: string, status: number): Response {
  return NextResponse.json({ error }, { status });
}

export async function POST(
  request: NextRequest,
  { params }: MountSessionRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("unauthorized", 401);
  }

  const { workspaceId } = await params;
  if (!workspaceId || !isValidWorkspaceId(workspaceId)) {
    return jsonError("workspace_not_found", 404);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonError("invalid_request", 400);
  }

  const validation = validateMountSessionBody(payload);
  if (!validation.ok) {
    return jsonError(validation.error, 400);
  }

  if (
    validation.value.scopes !== undefined &&
    !areValidRequestedScopes(validation.value.scopes)
  ) {
    return jsonError("invalid_scopes", 400);
  }

  if (
    validation.value.scopes !== undefined &&
    auth.source === "relayfile" &&
    !callerAllowsRequestedScopes(auth, validation.value.scopes)
  ) {
    return jsonError("invalid_scopes", 400);
  }

  try {
    const { registry } = createCloudWorkspaceRegistry();
    const workspace = await registry.get(workspaceId);
    if (!workspace) {
      return jsonError("workspace_not_found", 404);
    }

    const isOwner = hasWorkspaceOwnerAccess(workspace, auth.userId);
    const hasScopedAccess = hasWorkspaceAccess(auth, workspaceId);
    const isAnonymousWorkspace = workspace.createdBy === NIL_UUID;

    if (!isOwner && !hasScopedAccess) {
      if (!isAnonymousWorkspace) {
        return jsonError("workspace_not_found", 404);
      }
      return jsonError("forbidden", 403);
    }

    const access = await createWorkspaceJoinAccess({
      workspaceId: workspace.id,
      agentName: validation.value.agentName,
      requestedScopes: requestedMountSessionScopes({
        remotePath: validation.value.remotePath,
        scopes: validation.value.scopes,
      }),
      permissions: workspace.permissions,
    });
    const relaycastBaseUrl = resolveConfiguredRelaycastUrl();

    return NextResponse.json({
      workspaceId: workspace.id,
      relayfileBaseUrl: access.relayfileUrl,
      relayfileToken: access.token,
      wsUrl: access.wsUrl,
      remotePath: validation.value.remotePath,
      localDir: validation.value.localDir,
      mode: validation.value.mode,
      scopes: access.scopes,
      tokenIssuedAt: access.tokenIssuedAt,
      expiresAt: access.tokenExpiresAt,
      suggestedRefreshAt: access.suggestedRefreshAt,
      relaycastApiKey: workspace.relaycastApiKey,
      ...(relaycastBaseUrl ? { relaycastBaseUrl } : {}),
    });
  } catch (error) {
    console.error(
      "Mount session failed:",
      error instanceof Error ? error.message : String(error),
    );
    return jsonError("mount_session_failed", 500);
  }
}
