import type { RequestAuth } from "@/lib/auth/request-auth";
import {
  hasWorkspaceAccess,
  hasWorkspaceReadAccess,
} from "@/lib/integrations/integration-route-handler";
import {
  type WorkspaceIntegrationIdentity,
  resolveAppWorkspaceIdForRelayRuntime,
  resolveAppWorkspaceIdForRuntime,
  resolveRelayWorkspaceIdForRuntime,
  resolveWorkspaceIntegrationIdentity,
  uniqueWorkspaceIds,
} from "@/lib/workspaces/workspace-integration-identity-core";

export {
  type WorkspaceIntegrationIdentity,
  resolveAppWorkspaceIdForRelayRuntime,
  resolveAppWorkspaceIdForRuntime,
  resolveRelayWorkspaceIdForRuntime,
  resolveWorkspaceIntegrationIdentity,
  uniqueWorkspaceIds,
};

export function hasWorkspaceIntegrationAccess(
  auth: RequestAuth | null,
  identity: WorkspaceIntegrationIdentity,
): boolean {
  return identity.candidateWorkspaceIds.some((workspaceId) =>
    hasWorkspaceAccess(auth, workspaceId)
  );
}

export function hasWorkspaceIntegrationReadAccess(
  auth: RequestAuth | null,
  identity: WorkspaceIntegrationIdentity,
): boolean {
  return identity.candidateWorkspaceIds.some((workspaceId) =>
    hasWorkspaceReadAccess(auth, workspaceId)
  );
}
