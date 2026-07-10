import { NextRequest, NextResponse } from "next/server";

import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import { requireOrgMember } from "@/lib/invites/invite-store";
import {
  getRelayWorkspaceByRelaycastApiKey,
  isValidWorkspaceId,
} from "@/lib/relay-workspaces";
import {
  createCloudWorkspaceRegistry,
  hasWorkspaceOwnerAccess,
} from "@/lib/workspace-registry";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";
import {
  isAppWorkspaceId,
  readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId,
} from "@/lib/workspaces/relay-workspace-binding";

type ResolveWorkspaceRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type WorkspaceResolution = {
  relayWorkspaceId: string;
  cloudWorkspaceId: string | null;
  organizationId: string | null;
  provisioned: boolean;
};

type WorkspaceDisplayMetadata = {
  slug: string | null;
  name: string | null;
};

const ANONYMOUS_OWNER_ID = "00000000-0000-0000-0000-000000000000";
const RELAYCAST_WORKSPACE_KEY_PATTERN = /^rk_live_[A-Za-z0-9_-]+$/;

function workspaceDisplayMetadata(
  auth: RequestAuth,
  cloudWorkspaceId: string | null,
): WorkspaceDisplayMetadata {
  if (!cloudWorkspaceId || !requireSessionAuth(auth)) {
    return { slug: null, name: null };
  }
  const workspace =
    auth.context.workspaces.find((entry) => entry.id === cloudWorkspaceId) ??
    (auth.context.currentWorkspace?.id === cloudWorkspaceId
      ? auth.context.currentWorkspace
      : null);

  return {
    slug: workspace?.slug ?? null,
    name: workspace?.name ?? null,
  };
}

async function hasCloudWorkspaceAccess(
  auth: RequestAuth,
  resolution: Pick<
    WorkspaceResolution,
    "cloudWorkspaceId" | "organizationId" | "relayWorkspaceId"
  >,
): Promise<boolean> {
  if (
    auth.workspaceId === resolution.cloudWorkspaceId ||
    auth.workspaceId === resolution.relayWorkspaceId
  ) {
    return true;
  }

  if (requireSessionAuth(auth)) {
    return auth.context.workspaces.some(
      (workspace) =>
        workspace.id === resolution.cloudWorkspaceId ||
        (resolution.organizationId !== null &&
          workspace.organization_id === resolution.organizationId),
    );
  }

  return (
    resolution.organizationId !== null &&
    auth.organizationId === resolution.organizationId &&
    (await requireOrgMember(resolution.organizationId, auth.userId))
  );
}

async function resolveRelayWorkspace(
  auth: RequestAuth,
  workspaceId: string,
): Promise<WorkspaceResolution | null> {
  if (isValidWorkspaceId(workspaceId)) {
    const binding = await resolveAppWorkspaceByRelayWorkspaceId(workspaceId).catch(() => ({
      appWorkspaceId: null,
      organizationId: null,
    }));
    return {
      relayWorkspaceId: workspaceId,
      cloudWorkspaceId: binding.appWorkspaceId,
      organizationId: binding.organizationId,
      provisioned: false,
    };
  }

  if (RELAYCAST_WORKSPACE_KEY_PATTERN.test(workspaceId)) {
    const workspace = await getRelayWorkspaceByRelaycastApiKey(workspaceId);
    if (!workspace) {
      return null;
    }
    const binding = await resolveAppWorkspaceByRelayWorkspaceId(workspace.id).catch(() => ({
      appWorkspaceId: null,
      organizationId: null,
    }));
    return {
      relayWorkspaceId: workspace.id,
      cloudWorkspaceId: binding.appWorkspaceId,
      organizationId: binding.organizationId,
      provisioned: false,
    };
  }

  if (!isAppWorkspaceId(workspaceId)) {
    return null;
  }

  const binding = await readAppWorkspaceRelayBinding(workspaceId);
  if (!binding) {
    return null;
  }

  if (!(
    await hasCloudWorkspaceAccess(auth, {
      cloudWorkspaceId: binding.appWorkspaceId,
      organizationId: binding.organizationId,
      relayWorkspaceId: binding.relayWorkspaceId ?? "",
    })
  )) {
    return null;
  }

  const display = workspaceDisplayMetadata(auth, binding.appWorkspaceId);
  const resolved = await resolveOrProvisionRelayWorkspace({
    userId: auth.userId,
    appWorkspaceId: binding.appWorkspaceId,
    name: display.name ?? display.slug ?? undefined,
  });

  return {
    relayWorkspaceId: resolved.id,
    cloudWorkspaceId: binding.appWorkspaceId,
    organizationId: binding.organizationId,
    provisioned: resolved.provisioned,
  };
}

export async function GET(
  request: NextRequest,
  { params }: ResolveWorkspaceRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId: rawWorkspaceId } = await params;
  const workspaceId = rawWorkspaceId.trim();
  const resolution = await resolveRelayWorkspace(auth, workspaceId);
  if (!resolution) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const { registry, serviceConfig } = createCloudWorkspaceRegistry();
  const workspace = await registry.get(resolution.relayWorkspaceId);
  if (!workspace) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const hasOwnerAccess = hasWorkspaceOwnerAccess(workspace, auth.userId);
  const hasCloudAccess = await hasCloudWorkspaceAccess(auth, resolution);
  const hasAnonymousAccess = workspace.createdBy === ANONYMOUS_OWNER_ID;
  const hasAccess =
    hasAnonymousAccess ||
    hasOwnerAccess ||
    hasCloudAccess;
  if (!hasAccess) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  const display = workspaceDisplayMetadata(auth, resolution.cloudWorkspaceId);
  const descriptor = {
    // Keep this shape aligned with @agent-relay/cloud ActiveWorkspaceDescriptor.
    // Anonymous-only access may resolve the workspace but must not receive the
    // relaycastApiKey credential.
    ...(hasOwnerAccess || hasCloudAccess
      ? { relaycastApiKey: workspace.relaycastApiKey }
      : {}),
    workspaceId: workspace.id,
    cloudWorkspaceId: resolution.cloudWorkspaceId,
    relaycastWorkspaceId: workspace.id,
    relayfileWorkspaceId: workspace.relayfileWorkspaceId,
    relayauthWorkspaceId: workspace.relayauthWorkspaceId,
    organizationId: resolution.organizationId,
    slug: display.slug,
    name: display.name ?? workspace.name ?? workspace.id,
    urls: {
      relaycastUrl: serviceConfig.relaycastUrl,
      relayfileUrl: serviceConfig.relayfileUrl,
      relayauthUrl: serviceConfig.relayauthUrl,
    },
    provisioned: resolution.provisioned,
  };

  return NextResponse.json(descriptor);
}
