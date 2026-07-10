import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
} from "@/lib/auth/request-auth";
import { resolveWorkspaceGatewayAccess } from "@/lib/proactive-runtime/dashboard";
import {
  jsonError,
  requireWorkspaceSandboxAuth,
} from "../sandboxes/sandbox-utils";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type ResolveGatewayAccess = typeof resolveWorkspaceGatewayAccess;

type Deps = {
  resolveWorkspaceGatewayAccess: ResolveGatewayAccess;
};

const DEFAULT_DEPS: Deps = {
  resolveWorkspaceGatewayAccess,
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

export function createWorkspaceAgentEventsRouteHandlers(deps: Deps = DEFAULT_DEPS) {
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

    try {
      const access = await deps.resolveWorkspaceGatewayAccess({
        userId: authResult.auth.userId,
        workspaceId: authResult.workspaceId,
        agentName: "pear-project-events",
        requestedScopes: ["relayfile:fs:read:/integrations/**", "relayfile:fs:write:/integrations/**"],
      });

      return NextResponse.json({
        workspaceId: access.relayWorkspaceId,
        agentId: "pear-project-events",
        gatewayUrl: normalizeGatewayEventsUrl(access.gatewayBaseUrl),
        apiKey: access.token,
      });
    } catch (error) {
      console.error(
        "[workspace-agent-events] config request failed:",
        error instanceof Error ? error.message : String(error),
      );
      return jsonError("Agent gateway unavailable", "agent_gateway_unavailable", 503);
    }
  }

  return { GET };
}

export const { GET } = createWorkspaceAgentEventsRouteHandlers();
