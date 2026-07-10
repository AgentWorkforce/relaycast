import { NextRequest } from "next/server";
import { proxyAuthorizedDeploymentRunRead } from "@/lib/proactive-runtime/service-client";

type RouteContext = {
  params: Promise<{ agentId: string; runId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { agentId, runId } = await params;
  return proxyAuthorizedDeploymentRunRead(request, {
    kind: "detail",
    workspaceId: "",
    agentId,
    runId,
    requireWorkspaceAccess: false,
  });
}
