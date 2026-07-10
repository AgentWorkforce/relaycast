import { NextRequest, NextResponse } from "next/server";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { undeployAgent } from "@/lib/proactive-runtime/deploy-manager";
import type { ProactiveDeployContext } from "@/lib/proactive-runtime/deploy-auth";

type RouteContext = {
  params: Promise<{ agentId: string }>;
};

function toDeployContext(auth: Awaited<ReturnType<typeof resolveRequestAuth>>): ProactiveDeployContext {
  return {
    userId: auth!.userId,
    relayWorkspaceId: "",
    workspaceToken: "",
    appWorkspaceId: auth!.workspaceId,
    organizationId: auth!.organizationId,
    source: "session",
  };
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { agentId } = await params;
  const removed = await undeployAgent(toDeployContext(auth), agentId);
  if (!removed) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json(removed);
}
