import { NextRequest } from "next/server";
import { proxyAuthorizedDeploymentRunRead } from "@/lib/proactive-runtime/service-client";

type RouteContext = {
  params: Promise<{ agentId: string }>;
};

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { agentId } = await params;
  return proxyAuthorizedDeploymentRunRead(request, {
    kind: "list",
    workspaceId: "",
    agentId,
    requireWorkspaceAccess: false,
  });
}
