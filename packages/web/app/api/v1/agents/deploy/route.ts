import { NextRequest, NextResponse } from "next/server";
import { CI_DEPLOYMENTS_WRITE_SCOPE } from "@/lib/auth/api-token-types";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { deployEntrypoint } from "@/lib/proactive-runtime/deploy-manager";
import type { ProactiveDeployContext } from "@/lib/proactive-runtime/deploy-auth";

type RequestAuth = NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>;

function toDeployContext(auth: RequestAuth): ProactiveDeployContext {
  return {
    userId: auth.userId,
    relayWorkspaceId: "",
    workspaceToken: "",
    appWorkspaceId: auth.workspaceId,
    organizationId: auth.organizationId,
    source: "session",
  };
}

function normalizeBody(value: unknown): { entrypoint: string; source: string; name?: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const entrypoint = typeof record.entrypoint === "string" ? record.entrypoint.trim() : "";
  const source = typeof record.source === "string" ? record.source : "";
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : undefined;

  if (!entrypoint || !source.trim()) {
    return null;
  }

  return { entrypoint, source, ...(name ? { name } : {}) };
}

export type AgentDeployRouteDeps = {
  resolveRequestAuth: typeof resolveRequestAuth;
  requireSessionAuth: typeof requireSessionAuth;
  requireAuthScope: typeof requireAuthScope;
  deployEntrypoint: typeof deployEntrypoint;
};

const defaultDeps: AgentDeployRouteDeps = {
  resolveRequestAuth,
  requireSessionAuth,
  requireAuthScope,
  deployEntrypoint,
};

export function createAgentDeployRouteHandlers(
  deps: AgentDeployRouteDeps = defaultDeps,
) {
  async function POST(request: NextRequest) {
    const auth = await deps.resolveRequestAuth(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (
      !deps.requireSessionAuth(auth) &&
      !deps.requireAuthScope(auth, "cli:auth") &&
      !deps.requireAuthScope(auth, "deployments:write") &&
      !deps.requireAuthScope(auth, CI_DEPLOYMENTS_WRITE_SCOPE)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = normalizeBody(await request.json().catch(() => null));
    if (!body) {
      return NextResponse.json(
        { error: "entrypoint and source are required" },
        { status: 400 },
      );
    }

    try {
      const deployed = await deps.deployEntrypoint(toDeployContext(auth), body);
      return NextResponse.json(deployed, { status: 201 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = /required|must call agent|single-file entrypoints/i.test(message) ? 400 : 503;
      return NextResponse.json({ error: message }, { status });
    }
  }

  return { POST };
}

export const { POST } = createAgentDeployRouteHandlers();
