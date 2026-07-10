import {
  requireAuthScope,
  requireSessionAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import { isValidWorkspaceId } from "@/lib/relay-workspaces";
import {
  isAppWorkspaceId,
  readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId,
} from "@/lib/workspaces/relay-workspace-binding";

export type ResolvedRelayhistoryWorkspaceAccess = {
  orgId: string;
};

const RTH_READ_SCOPE = "rth:read";
const RTH_SYNC_SCOPE = "rth:sync";

export function hasRelayhistoryLoginScope(auth: RequestAuth): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, RTH_READ_SCOPE) ||
    requireAuthScope(auth, RTH_SYNC_SCOPE)
  );
}

export async function resolveRelayhistoryWorkspaceAccess(
  rawWorkspaceId: string,
  auth: RequestAuth,
): Promise<ResolvedRelayhistoryWorkspaceAccess | null> {
  if (isAppWorkspaceId(rawWorkspaceId)) {
    const binding = await readAppWorkspaceRelayBinding(rawWorkspaceId).catch(() => null);
    const sessionWorkspace = auth.context?.workspaces.find(
      (workspace) => workspace.id === rawWorkspaceId,
    );
    const orgId =
      binding?.organizationId ??
      sessionWorkspace?.organization_id ??
      (rawWorkspaceId === auth.workspaceId ? auth.organizationId : null);
    if (!orgId) {
      return null;
    }
    if (auth.source === "session") {
      return sessionWorkspace?.organization_id === orgId ? { orgId } : null;
    }
    return rawWorkspaceId === auth.workspaceId && auth.organizationId === orgId
      ? { orgId }
      : null;
  }

  if (!isValidWorkspaceId(rawWorkspaceId)) {
    if (rawWorkspaceId === auth.workspaceId) {
      return { orgId: auth.organizationId };
    }
    if (auth.source !== "session") {
      return null;
    }
    const sessionWorkspace = auth.context?.workspaces.find(
      (workspace) => workspace.id === rawWorkspaceId,
    );
    return sessionWorkspace ? { orgId: sessionWorkspace.organization_id } : null;
  }

  const binding = await resolveAppWorkspaceByRelayWorkspaceId(rawWorkspaceId).catch(() => ({
    appWorkspaceId: null,
    organizationId: null,
  }));
  if (!binding.appWorkspaceId || !binding.organizationId) {
    return null;
  }
  if (auth.source === "session") {
    const sessionWorkspace = auth.context?.workspaces.find(
      (workspace) => workspace.id === binding.appWorkspaceId,
    );
    return sessionWorkspace?.organization_id === binding.organizationId
      ? { orgId: binding.organizationId }
      : null;
  }
  return binding.appWorkspaceId === auth.workspaceId &&
    auth.organizationId === binding.organizationId
    ? { orgId: binding.organizationId }
    : null;
}
