import { isValidWorkspaceIdAny } from "@cloud/core/workspace/id.js";
import { NextRequest, NextResponse } from "next/server";
import {
  areValidRequestedScopes,
  createWorkspaceJoinAccess,
  ensureRelayWorkspace,
  getOwnedRelayWorkspace,
  isValidAgentName,
  mergeWorkspacePermissions,
  normalizeWorkspacePermissions,
} from "@/lib/relay-workspaces";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import {
  assertCloudAgentSpawnQuota,
  getEffectiveCloudAgentSpawnQuota,
} from "@/lib/cloud-agent-quotas";
import { getDb } from "@/lib/db";

type AgentPermissions = {
  ignored?: string[];
  readonly?: string[];
};

type ProvisionAgentRequest = {
  name: string;
  scopes?: string[];
  permissions?: AgentPermissions;
};

type ProvisionRequestBody = {
  workspaceId: string;
  agents: ProvisionAgentRequest[];
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isAgentPermissions(value: unknown): value is AgentPermissions {
  if (value === undefined) {
    return true;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const permissions = value as AgentPermissions;
  return (
    (permissions.ignored === undefined || isStringArray(permissions.ignored)) &&
    (permissions.readonly === undefined || isStringArray(permissions.readonly))
  );
}

function isProvisionRequestBody(payload: unknown): payload is ProvisionRequestBody {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }

  const body = payload as Partial<ProvisionRequestBody>;
  if (
    typeof body.workspaceId !== "string" ||
    !isValidWorkspaceIdAny(body.workspaceId.trim()) ||
    !Array.isArray(body.agents) ||
    body.agents.length === 0 ||
    body.agents.length > 64
  ) {
    return false;
  }

  const agentNames = new Set<string>();
  return body.agents.every((agent) => {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
      return false;
    }

    const candidate = agent as Partial<ProvisionAgentRequest>;
    const name = candidate.name?.trim() ?? "";
    if (!name || !isValidAgentName(name) || agentNames.has(name)) {
      return false;
    }

    if (candidate.scopes !== undefined && !areValidRequestedScopes(candidate.scopes)) {
      return false;
    }

    if (!isAgentPermissions(candidate.permissions)) {
      return false;
    }

    agentNames.add(name);
    return true;
  });
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isProvisionRequestBody(body)) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const workspaceId = body.workspaceId.trim();

  try {
    const workspace = await getOwnedRelayWorkspace(workspaceId, auth.userId);
    if (!workspace) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    const quota = await getEffectiveCloudAgentSpawnQuota(getDb(), auth.userId);
    try {
      assertCloudAgentSpawnQuota(body.agents.length, quota);
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error), quota },
        { status: 429 },
      );
    }

    await ensureRelayWorkspace(workspaceId, workspace.permissions);

    const agents = [];
    for (const agent of body.agents) {
      const name = agent.name.trim();
      const access = await createWorkspaceJoinAccess({
        workspaceId,
        agentName: name,
        requestedScopes: agent.scopes,
        permissions: mergeWorkspacePermissions(
          workspace.permissions,
          normalizeWorkspacePermissions(agent.permissions),
        ),
      });

      agents.push({
        name,
        token: access.token,
        scopes: access.scopes,
        workspaceId,
      });
    }

    return NextResponse.json({ agents });
  } catch (error) {
    console.error("Agent provisioning failed:", error);
    return NextResponse.json({ error: "Failed to provision agents" }, { status: 500 });
  }
}
