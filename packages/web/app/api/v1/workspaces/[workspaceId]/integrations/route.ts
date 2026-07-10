import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  buildIntegrationListEntry,
  type IntegrationListEntry,
} from "@/lib/integrations/integration-list";
import { listWorkspaceIntegrations } from "@/lib/integrations/workspace-integrations";
import {
  hasWorkspaceIntegrationReadAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type ErrorResponse = { error: string };

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId } = await context.params;

  if (!auth) {
    return NextResponse.json<ErrorResponse>({ error: "Unauthorized" }, { status: 401 });
  }

  const identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  if (!hasWorkspaceIntegrationReadAccess(auth, identity)) {
    return NextResponse.json<ErrorResponse>({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const integrations = await listWorkspaceIntegrations(identity.relayWorkspaceId);
    const entries = await Promise.all(integrations.map(buildIntegrationListEntry));
    return NextResponse.json<IntegrationListEntry[]>(entries);
  } catch (error) {
    console.error("Workspace integration listing failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to list integrations" },
      { status: 500 },
    );
  }
}
