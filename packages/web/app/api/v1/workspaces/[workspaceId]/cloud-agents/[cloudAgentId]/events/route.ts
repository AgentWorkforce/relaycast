import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
} from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { resolveWorkspaceGatewayAccess } from "@/lib/proactive-runtime/dashboard";
import {
  jsonError,
  requireWorkspaceSandboxAuth,
} from "../../../sandboxes/sandbox-utils";

type RouteContext = {
  params: Promise<{ workspaceId: string; cloudAgentId: string }>;
};

type ResolveGatewayAccess = typeof resolveWorkspaceGatewayAccess;

type Deps = {
  resolveWorkspaceGatewayAccess: ResolveGatewayAccess;
  cloudAgentExists: (workspaceId: string, cloudAgentId: string, userId: string) => Promise<boolean>;
};

const DEFAULT_DEPS: Deps = {
  resolveWorkspaceGatewayAccess,
  cloudAgentExists: async (workspaceId, cloudAgentId, userId) => {
    const [row] = await getDb()
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.workspaceId, workspaceId),
          eq(providerCredentials.id, cloudAgentId),
          eq(providerCredentials.userId, userId),
        ),
      )
      .limit(1);
    return Boolean(row);
  },
};

function normalizeGatewayEventsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (!url.pathname || url.pathname === "/") {
    url.pathname = "/v1/agent-events";
  } else if (!url.pathname.endsWith("/v1/agent-events")) {
    url.pathname = `${url.pathname.replace(/\/+$/u, "")}/v1/agent-events`;
  }
  if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

export function createCloudAgentEventsRouteHandlers(deps: Deps = DEFAULT_DEPS) {
  async function GET(request: NextRequest, context: RouteContext) {
    const authResult = await requireWorkspaceSandboxAuth(request, context);
    if (!authResult.ok) {
      return authResult.response;
    }
    if (authResult.auth.source === "relayfile") {
      return jsonError("Forbidden", "forbidden", 403);
    }
    if (!requireSessionAuth(authResult.auth) && !requireAuthScope(authResult.auth, "cli:auth")) {
      return jsonError("Forbidden", "forbidden", 403);
    }

    const { cloudAgentId } = await context.params;
    if (!cloudAgentId) {
      return jsonError("Cloud agent not found", "cloud_agent_not_found", 404);
    }
    if (!await deps.cloudAgentExists(authResult.workspaceId, cloudAgentId, authResult.auth.userId)) {
      return jsonError("Cloud agent not found", "cloud_agent_not_found", 404);
    }

    try {
      const access = await deps.resolveWorkspaceGatewayAccess({
        userId: authResult.auth.userId,
        workspaceId: authResult.workspaceId,
        agentName: "pear-cloud-agent-events",
        requestedScopes: ["relayfile:fs:read:/integrations/**", "relayfile:fs:write:/integrations/**"],
      });

      return NextResponse.json({
        workspaceId: access.relayWorkspaceId,
        agentId: `pear-cloud-agent-${cloudAgentId}`,
        gatewayUrl: normalizeGatewayEventsUrl(access.gatewayBaseUrl),
        apiKey: access.token,
      });
    } catch (error) {
      console.error(
        "[cloud-agent-events] config request failed:",
        error instanceof Error ? error.message : String(error),
      );
      return jsonError("Agent gateway unavailable", "agent_gateway_unavailable", 503);
    }
  }

  return { GET };
}

export const { GET } = createCloudAgentEventsRouteHandlers();
