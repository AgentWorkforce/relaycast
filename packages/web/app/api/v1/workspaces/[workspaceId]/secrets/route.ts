import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRequestContext } from "@/lib/proactive-runtime/api";
import {
  listWorkspaceSecrets,
  writeWorkspaceSecret,
} from "@/lib/proactive-runtime/secret-store";
import { resolveOrProvisionRelayWorkspace } from "@/lib/workflows/relay-workspace";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export type WorkspaceSecretsCollectionRouteDeps = {
  requireWorkspaceRequestContext: typeof requireWorkspaceRequestContext;
  listWorkspaceSecrets: typeof listWorkspaceSecrets;
  writeWorkspaceSecret: typeof writeWorkspaceSecret;
  resolveOrProvisionRelayWorkspace: typeof resolveOrProvisionRelayWorkspace;
};

const defaultDeps: WorkspaceSecretsCollectionRouteDeps = {
  requireWorkspaceRequestContext,
  listWorkspaceSecrets,
  writeWorkspaceSecret,
  resolveOrProvisionRelayWorkspace,
};

export function createWorkspaceSecretsCollectionRouteHandlers(
  deps: WorkspaceSecretsCollectionRouteDeps = defaultDeps,
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
    const { workspaceId } = await params;
    const context = await deps.requireWorkspaceRequestContext(request, workspaceId);
    if (context instanceof NextResponse) {
      return context;
    }

    try {
      const relayWorkspaceId = await resolveRelayWorkspaceId(context.auth.userId, workspaceId);
      const items = await deps.listWorkspaceSecrets(relayWorkspaceId);
      return NextResponse.json({ ok: true, data: { items } });
    } catch (error) {
      console.error("Workspace secret list failed:", error instanceof Error ? error.message : String(error));
      return NextResponse.json({ error: "Failed to list workspace secrets" }, { status: 503 });
    }
  }

  async function POST(request: NextRequest, { params }: RouteContext) {
    const { workspaceId } = await params;
    const context = await deps.requireWorkspaceRequestContext(request, workspaceId);
    if (context instanceof NextResponse) {
      return context;
    }

    const body = await request.json().catch(() => null) as
      | { name?: unknown; value?: unknown; envVar?: unknown }
      | null;
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const value = typeof body?.value === "string" ? body.value : "";
    const envVar = typeof body?.envVar === "string" && body.envVar.trim() ? body.envVar.trim() : undefined;

    if (!name || !value.trim()) {
      return NextResponse.json({ error: "name and value are required" }, { status: 400 });
    }

    try {
      const relayWorkspaceId = await resolveRelayWorkspaceId(context.auth.userId, workspaceId);
      const record = await deps.writeWorkspaceSecret({
        relayWorkspaceId,
        name,
        value,
        ...(envVar ? { envVar } : {}),
      });
      return NextResponse.json(record, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /required|match/i.test(message) ? 400 : 503;
      return NextResponse.json({ error: message }, { status });
    }
  }

  return { GET, POST };
}

export const { GET, POST } = createWorkspaceSecretsCollectionRouteHandlers();
