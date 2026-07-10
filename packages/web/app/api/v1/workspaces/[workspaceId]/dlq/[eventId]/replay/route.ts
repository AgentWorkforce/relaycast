import { NextRequest, NextResponse } from "next/server";
import { requireWorkspaceRequestContext } from "@/lib/proactive-runtime/api";
import { resolveWorkspaceGatewayAccess } from "@/lib/proactive-runtime/dashboard";

type RouteContext = {
  params: Promise<{ workspaceId: string; eventId: string }>;
};

export async function POST(request: NextRequest, { params }: RouteContext) {
  const { workspaceId, eventId } = await params;
  const context = await requireWorkspaceRequestContext(request, workspaceId);
  if (context instanceof NextResponse) {
    return context;
  }

  try {
    const access = await resolveWorkspaceGatewayAccess({
      userId: context.auth.userId,
      workspaceId,
      agentName: "cloud-dashboard-dlq",
      requestedScopes: ["relayfile:fs:read:*", "relayfile:fs:write:*"],
    });
    const response = await fetch(
      `${access.gatewayBaseUrl.replace(/\/+$/, "")}/v1/workspaces/${encodeURIComponent(access.relayWorkspaceId)}/dlq/${encodeURIComponent(eventId)}/replay`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${access.token}`,
        },
      },
    );
    return NextResponse.json(await response.json().catch(() => null), { status: response.status });
  } catch (error) {
    console.error("Workspace DLQ replay failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Agent gateway unavailable" }, { status: 503 });
  }
}
