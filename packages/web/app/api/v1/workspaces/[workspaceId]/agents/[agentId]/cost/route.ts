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
      agentName: "cloud-dashboard-cost",
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
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(payload, { status: response.status });
    }

    return NextResponse.json(
      {
        ok: true,
        data: payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null,
      },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      "Workspace agent cost proxy failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "Agent gateway unavailable" }, { status: 503 });
  }
}
