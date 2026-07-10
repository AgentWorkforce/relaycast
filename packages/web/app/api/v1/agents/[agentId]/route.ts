import { NextRequest, NextResponse } from "next/server";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  inspectDeployedAgent,
  undeployAgent,
} from "@/lib/proactive-runtime/deploy-manager";
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

async function requireUserAuth(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return auth;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const auth = await requireUserAuth(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { agentId } = await params;
  const record = await inspectDeployedAgent(toDeployContext(auth), agentId);
  if (!record) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json(record);
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const auth = await requireUserAuth(request);
  if (auth instanceof NextResponse) {
    return auth;
  }

  const { agentId } = await params;
  const removed = await undeployAgent(toDeployContext(auth), agentId);
  if (!removed) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  return NextResponse.json(removed);
}
