import { NextRequest, NextResponse } from "next/server";
import {
  areValidRequestedScopes,
  createWorkspaceJoinAccess,
  isValidAgentName,
  isValidWorkspaceId,
  mergeWorkspacePermissions,
} from "@/lib/relay-workspaces";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import {
  createCloudWorkspaceRegistry,
  hasWorkspaceOwnerAccess,
  resolveConfiguredRelaycastUrl,
} from "@/lib/workspace-registry";
import { requireOrgMember } from "@/lib/invites/invite-store";
import {
  isAppWorkspaceId,
  readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId,
} from "@/lib/workspaces/relay-workspace-binding";

type JoinWorkspaceBody = {
  agentName: string;
  permissions?: {
    ignored?: string[];
    readonly?: string[];
  };
  scopes?: string[];
};

type JoinRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type JoinWorkspaceResolution = {
  relayWorkspaceId: string;
  appWorkspaceId: string | null;
  organizationId: string | null;
};

function isJoinWorkspaceBody(payload: unknown): payload is JoinWorkspaceBody {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const body = payload as Partial<JoinWorkspaceBody>;
  if (typeof body.agentName !== "string" || !isValidAgentName(body.agentName.trim())) {
    return false;
  }

  if (
    body.permissions !== undefined &&
    (!body.permissions ||
      typeof body.permissions !== "object" ||
      Array.isArray(body.permissions) ||
      (body.permissions.ignored !== undefined && !Array.isArray(body.permissions.ignored)) ||
      (body.permissions.readonly !== undefined && !Array.isArray(body.permissions.readonly)) ||
      (Array.isArray(body.permissions.ignored) &&
        !body.permissions.ignored.every((entry) => typeof entry === "string")) ||
      (Array.isArray(body.permissions.readonly) &&
        !body.permissions.readonly.every((entry) => typeof entry === "string")))
  ) {
    return false;
  }

  if (body.scopes === undefined) {
    return true;
  }

  return areValidRequestedScopes(body.scopes);
}

async function resolveJoinWorkspaceId(workspaceId: string): Promise<JoinWorkspaceResolution | null> {
  const requestedWorkspaceId = workspaceId.trim();
  if (!requestedWorkspaceId) {
    return null;
  }

  if (isValidWorkspaceId(requestedWorkspaceId)) {
    let binding: Awaited<ReturnType<typeof resolveAppWorkspaceByRelayWorkspaceId>> = {
      appWorkspaceId: null,
      organizationId: null,
    };
    try {
      binding = await resolveAppWorkspaceByRelayWorkspaceId(requestedWorkspaceId);
    } catch {
      // Direct rw_* joins predate app workspace bindings and are still valid
      // for anonymous/shareable workspaces. Treat reverse-binding lookup as
      // best-effort so offline handlers and legacy workspaces do not require
      // the Cloud DB path.
    }
    return {
      relayWorkspaceId: requestedWorkspaceId,
      appWorkspaceId: binding.appWorkspaceId,
      organizationId: binding.organizationId,
    };
  }

  if (!isAppWorkspaceId(requestedWorkspaceId)) {
    return null;
  }

  const binding = await readAppWorkspaceRelayBinding(requestedWorkspaceId);
  if (!binding) {
    return null;
  }

  return {
    relayWorkspaceId: binding.relayWorkspaceId ?? requestedWorkspaceId,
    appWorkspaceId: binding.appWorkspaceId,
    organizationId: binding.organizationId,
  };
}

async function hasOrgWorkspaceAccess(
  auth: RequestAuth | null,
  resolution: JoinWorkspaceResolution,
): Promise<boolean> {
  if (!auth || !resolution.appWorkspaceId) {
    return false;
  }

  if (auth.source === "session") {
    return auth.context?.workspaces.some(
      (workspace) =>
        workspace.id === resolution.appWorkspaceId ||
        (resolution.organizationId !== null &&
          workspace.organization_id === resolution.organizationId),
    ) ?? false;
  }

  if (auth.workspaceId === resolution.appWorkspaceId) {
    return true;
  }

  // CLI login tokens are issued for the user's current workspace but carry
  // the current org. The join contract is org membership for known workspaces.
  return (
    resolution.organizationId !== null &&
    auth.organizationId === resolution.organizationId &&
    (await requireOrgMember(resolution.organizationId, auth.userId))
  );
}

export async function POST(
  request: NextRequest,
  { params }: JoinRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  const credentialsProvided = !!request.headers.get("authorization");

  // Credentials were provided but failed to resolve — reject rather than
  // silently downgrading to anonymous.
  if (!auth && credentialsProvided) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Authenticated users must have session auth or cli:auth scope
  if (auth && !requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId } = await params;
  const resolution = await resolveJoinWorkspaceId(workspaceId);
  if (!resolution) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isJoinWorkspaceBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  try {
    const { registry } = createCloudWorkspaceRegistry();
    const workspace = await registry.get(resolution.relayWorkspaceId);
    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }
    const enrichedResolution = {
      ...resolution,
      relayWorkspaceId: workspace.id,
    };

    // Anonymous-created workspaces (nil UUID owner) are joinable by
    // anyone who knows the workspace ID.  Authenticated workspaces
    // still require owner or org workspace access.
    const isAnonymousWorkspace = workspace.createdBy === "00000000-0000-0000-0000-000000000000";
    if (!isAnonymousWorkspace) {
      const hasWorkspaceAccess =
        auth &&
        (hasWorkspaceOwnerAccess(workspace, auth.userId) ||
          (await hasOrgWorkspaceAccess(auth, enrichedResolution)));
      if (!hasWorkspaceAccess) {
        return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
      }
    }

    const permissions = body.permissions
      ? mergeWorkspacePermissions(workspace.permissions, body.permissions)
      : workspace.permissions;
    const access = await createWorkspaceJoinAccess({
      workspaceId: workspace.id,
      agentName: body.agentName.trim(),
      permissions,
      requestedScopes: body.scopes,
    });
    const relaycastBaseUrl = resolveConfiguredRelaycastUrl();

    return NextResponse.json({
      workspaceId: workspace.id,
      token: access.token,
      tokenIssuedAt: access.tokenIssuedAt,
      tokenExpiresAt: access.tokenExpiresAt,
      suggestedRefreshAt: access.suggestedRefreshAt,
      relayfileUrl: access.relayfileUrl,
      wsUrl: access.wsUrl,
      relaycastApiKey: workspace.relaycastApiKey,
      scopes: access.scopes,
      ...(relaycastBaseUrl ? { relaycastBaseUrl } : {}),
    });
  } catch (error) {
    console.error("Workspace join failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Failed to join workspace" }, { status: 500 });
  }
}
