import { NextRequest, NextResponse } from "next/server";
import { CI_DEPLOYMENTS_READ_SCOPE } from "@/lib/auth/api-token-types";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { listDeployedAgents } from "@/lib/proactive-runtime/deploy-manager";
import type { ProactiveDeployContext } from "@/lib/proactive-runtime/deploy-auth";
import { countRelayfileConflicts } from "@/lib/relayfile-conflicts";

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

function resolveConflictSourceLocalDir(request: NextRequest): string | null {
  const configured = process.env.CLOUD_AGENT_LIST_CONFLICT_LOCAL_DIR?.trim();
  if (configured) {
    return configured;
  }

  const host = request.headers.get("host") ?? "";
  const localCaller =
    process.env.CLOUD_AGENT_LIST_ALLOW_LOCAL_CONFLICTS === "1" ||
    host.startsWith("localhost") ||
    host.startsWith("127.0.0.1");
  if (!localCaller) {
    return null;
  }

  return request.nextUrl.searchParams.get("localDir");
}

export async function GET(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (
    !requireSessionAuth(auth) &&
    !requireAuthScope(auth, "cli:auth") &&
    !requireAuthScope(auth, "deployments:read") &&
    !requireAuthScope(auth, CI_DEPLOYMENTS_READ_SCOPE)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const agents = await listDeployedAgents(toDeployContext(auth));
    const localDir = resolveConflictSourceLocalDir(request);
    if (!localDir) {
      return NextResponse.json({
        agents: agents.map((agent) => ({ ...agent, conflictCount: 0 })),
        conflictSource: { mode: "cloud-unavailable" },
      });
    }

    const { conflictCount, conflictsDir } = await countRelayfileConflicts(localDir);
    return NextResponse.json({
      agents: agents.map((agent) => ({ ...agent, conflictCount })),
      conflictSource: { mode: "local", conflictsDir },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 503 },
    );
  }
}
