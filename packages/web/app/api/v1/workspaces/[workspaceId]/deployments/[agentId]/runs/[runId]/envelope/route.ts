import { NextRequest } from "next/server";
import { proxyAuthorizedDeploymentRunRead } from "@/lib/proactive-runtime/service-client";

type RouteContext = {
  params: Promise<{ workspaceId: string; agentId: string; runId: string }>;
};

// GET /runs/:runId/envelope (cloud#1841): the byte-exact gateway envelope
// delivered to this run — the replayable `agentworkforce invoke --fixture`
// input (workforce#189). Persisted raw, redacted on read; see
// getDeploymentRunEnvelope for the redaction decision.
export async function GET(request: NextRequest, { params }: RouteContext) {
  const { workspaceId, agentId, runId } = await params;
  return proxyAuthorizedDeploymentRunRead(request, {
    kind: "envelope",
    workspaceId,
    agentId,
    runId,
    requireWorkspaceAccess: true,
  });
}
