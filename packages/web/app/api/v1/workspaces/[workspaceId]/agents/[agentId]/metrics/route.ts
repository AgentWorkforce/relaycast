import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRequestContext } from "@/lib/proactive-runtime/api";
import { resolveWorkspaceGatewayAccess } from "@/lib/proactive-runtime/dashboard";

type RouteContext = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

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
      agentName: "cloud-dashboard-metrics",
      requestedScopes: ["relayfile:fs:read:*"],
    });
    const url = new URL(
      `${access.gatewayBaseUrl.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(access.relayWorkspaceId)}/metrics`,
    );
    url.searchParams.set("agentId", agentId);
    url.searchParams.set("windowMinutes", request.nextUrl.searchParams.get("windowMinutes") ?? "240");

    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        authorization: `Bearer ${access.token}`,
      },
    });
    return NextResponse.json(await response.json().catch(() => null), { status: response.status });
  } catch (error) {
    console.error(
      "Workspace agent metrics proxy failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "Agent gateway unavailable" }, { status: 503 });
  }
}
