import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRequestContext } from "@/lib/proactive-runtime/api";
import {
  deleteWorkspaceSecret,
  readWorkspaceSecret,
} from "@/lib/proactive-runtime/secret-store";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";

type RouteContext = {
  params: Promise<{ workspaceId: string; secretName: string }>;
};

export type WorkspaceSecretDetailRouteDeps = {
  requireWorkspaceRequestContext: typeof requireWorkspaceRequestContext;
  deleteWorkspaceSecret: typeof deleteWorkspaceSecret;
  readWorkspaceSecret: typeof readWorkspaceSecret;
  resolveOrProvisionRelayWorkspace: typeof resolveOrProvisionRelayWorkspace;
};

const defaultDeps: WorkspaceSecretDetailRouteDeps = {
  requireWorkspaceRequestContext,
  deleteWorkspaceSecret,
  readWorkspaceSecret,
  resolveOrProvisionRelayWorkspace,
};

export function createWorkspaceSecretDetailRouteHandlers(
  deps: WorkspaceSecretDetailRouteDeps = defaultDeps,
) {
  async function resolveRelayWorkspaceId(userId: string, workspaceId: string): Promise<string> {
    const resolved = await deps.resolveOrProvisionRelayWorkspace({
      userId,
      appWorkspaceId: workspaceId,
      name: workspaceId,
    });
    return resolved.id;
  }

  async function GET(request: NextRequest, { params }: RouteContext) {
    const { workspaceId, secretName } = await params;
    const context = await deps.requireWorkspaceRequestContext(request, workspaceId);
    if (context instanceof NextResponse) {
      return context;
    }

    try {
      const relayWorkspaceId = await resolveRelayWorkspaceId(context.auth.userId, workspaceId);
      const record = await deps.readWorkspaceSecret(relayWorkspaceId, secretName);
      if (!record) {
        return NextResponse.json({ error: "Secret not found" }, { status: 404 });
      }
      return NextResponse.json(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /match/i.test(message) ? 400 : 503;
      return NextResponse.json({ error: message }, { status });
    }
  }

  async function DELETE(request: NextRequest, { params }: RouteContext) {
    const { workspaceId, secretName } = await params;
    const context = await deps.requireWorkspaceRequestContext(request, workspaceId);
    if (context instanceof NextResponse) {
      return context;
    }

    try {
      const relayWorkspaceId = await resolveRelayWorkspaceId(context.auth.userId, workspaceId);
      const removed = await deps.deleteWorkspaceSecret(relayWorkspaceId, secretName);
      if (!removed) {
        return NextResponse.json({ error: "Secret not found" }, { status: 404 });
      }
      return NextResponse.json(removed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /match/i.test(message) ? 400 : 503;
      return NextResponse.json({ error: message }, { status });
    }
  }

  return { GET, DELETE };
}

export const { GET, DELETE } = createWorkspaceSecretDetailRouteHandlers();
