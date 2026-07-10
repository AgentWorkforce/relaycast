import {
  requireAuthScope,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import {
  createCloudWorkspaceRegistry,
  hasWorkspaceOwnerAccess,
} from "@/lib/workspace-registry";

export async function hasDigestFunctionWorkspaceAccess(
  auth: RequestAuth | null,
  workspaceId: string,
): Promise<boolean> {
  if (hasWorkspaceAccess(auth, workspaceId)) {
    return true;
  }

  if (!auth || auth.source !== "token" || !requireAuthScope(auth, "cli:auth")) {
    return false;
  }

  try {
    const { registry } = createCloudWorkspaceRegistry();
    const workspace = await registry.get(workspaceId);
    return workspace ? hasWorkspaceOwnerAccess(workspace, auth.userId) : false;
  } catch {
    return false;
  }
}
