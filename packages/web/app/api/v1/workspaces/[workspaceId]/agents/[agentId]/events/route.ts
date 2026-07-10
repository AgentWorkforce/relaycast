import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRequestContext } from "@/lib/proactive-runtime/api";
import { resolveWorkspaceGatewayAccess } from "@/lib/proactive-runtime/dashboard";

type RouteContext = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.toString();
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { workspaceId, agentId } = await params;
  const context = await requireWorkspaceRequestContext(request, workspaceId);
  if (context instanceof NextResponse) {
    return context;
  }

  try {
    const access = await resolveWorkspaceGatewayAccess({
      userId: context.auth.userId,
      workspaceId,
      agentName: "cloud-dashboard-events",
      requestedScopes: ["relayfile:fs:read:*"],
    });
    const base = `${access.gatewayBaseUrl.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(access.relayWorkspaceId)}/agents/${encodeURIComponent(agentId)}/events`;
    const response = await fetch(base, {
      cache: "no-store",
      headers: {
        authorization: `Bearer ${access.token}`,
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(payload, { status: response.status });
    }

    const wsUrl = new URL(toWebSocketUrl(base));
    wsUrl.searchParams.set("access_token", access.token);

    return NextResponse.json({
      ...(payload && typeof payload === "object" ? payload : {}),
      observer: {
        wsUrl: wsUrl.toString(),
      },
    });
  } catch (error) {
    console.error(
      "Workspace agent events proxy failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "Agent gateway unavailable" }, { status: 503 });
  }
}
