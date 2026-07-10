import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createCloudWorkspaceRegistry } from "@/lib/workspace-registry";
import { optionalEnv } from "@/lib/env";
import { getAuthContext } from "@/lib/auth/auth-api";
import { getAuthSessionSecret } from "@/lib/auth/secrets";
import { readSessionFromRequest } from "@/lib/auth/session";
import type { AuthContext, AuthWorkspace } from "@/lib/auth/types";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";

export type WorkspacePageContext = {
  auth: AuthContext;
  workspace: AuthWorkspace;
  organizationName: string;
};

export async function requireWorkspacePageContext(
  workspaceId: string,
): Promise<WorkspacePageContext> {
  const cookieStore = await cookies();
  const session = readSessionFromRequest(
    { cookies: cookieStore as never },
    getAuthSessionSecret(),
  );

  if (!session) {
    redirect("/");
  }

  const auth = await getAuthContext(session.userId, session.currentWorkspaceId);
  const workspace = auth.workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) {
    redirect("/dashboard");
  }

  const organization =
    auth.organizations.find((candidate) => candidate.id === workspace.organization_id)
    ?? auth.currentOrganization;

  return {
    auth,
    workspace,
    organizationName: organization.name,
  };
}

export function resolveAgentGatewayBaseUrl(): string | null {
  return (
    optionalEnv("AGENT_GATEWAY_BASE_URL")
    ?? optionalEnv("NEXT_PUBLIC_AGENT_GATEWAY_BASE_URL")
    ?? null
  );
}

export async function resolveWorkspaceGatewayAccess(input: {
  userId: string;
  workspaceId: string;
  agentName?: string;
  requestedScopes?: string[];
}): Promise<{
  gatewayBaseUrl: string;
  relayWorkspaceId: string;
  token: string;
}> {
  const gatewayBaseUrl = resolveAgentGatewayBaseUrl();
  if (!gatewayBaseUrl) {
    throw new Error("Agent gateway base URL is not configured");
  }

  const access = await resolveWorkspaceRelayAccess(input);

  return {
    gatewayBaseUrl,
    relayWorkspaceId: access.relayWorkspaceId,
    token: access.token,
  };
}

export async function resolveWorkspaceRelayAccess(input: {
  userId: string;
  workspaceId: string;
  agentName?: string;
  requestedScopes?: string[];
}): Promise<{
  relayWorkspaceId: string;
  token: string;
}> {
  const resolved = await resolveOrProvisionRelayWorkspace({
    userId: input.userId,
    appWorkspaceId: input.workspaceId,
    name: input.workspaceId,
  });
  const { registry } = createCloudWorkspaceRegistry();
  const access = await registry.join(
    resolved.id,
    input.agentName?.trim() || "cloud-dashboard",
    {
      requestedScopes:
        input.requestedScopes
        ?? ["relayfile:fs:read:*", "relayfile:fs:write:*"],
    },
  );

  return {
    relayWorkspaceId: resolved.id,
    token: access.token,
  };
}
