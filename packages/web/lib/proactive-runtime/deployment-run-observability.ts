import type { NextRequest } from "next/server";
import {
  requireAuthScope,
  requireAuthRunAccess,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";
import {
  getAuthorizedDeploymentRun,
  getAuthorizedDeploymentRunEnvelope,
  listAuthorizedDeploymentRuns,
  type AuthorizedRunDetailContext,
  type AuthorizedRunListContext,
} from "./deployment-run-observability-core";

type Auth = NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>;

type RunListContext = AuthorizedRunListContext & {
  requireWorkspaceAccess: boolean;
};

type RunDetailContext = RunListContext & {
  runId: string;
};

function canReadDeploymentRuns(auth: Auth): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:read")
  );
}

async function requireRunReadAuth(
  request: NextRequest,
  context: RunListContext,
): Promise<Auth | Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return Response.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (!canReadDeploymentRuns(auth)) {
    return Response.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }
  if (context.requireWorkspaceAccess && !hasWorkspaceAccess(auth, context.workspaceId)) {
    return Response.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }
  return auth;
}

export async function listDeploymentRuns(
  request: NextRequest,
  context: RunListContext,
): Promise<Response> {
  const auth = await requireRunReadAuth(request, context);
  if (auth instanceof Response) {
    return auth;
  }
  const resolvedContext = { ...context, workspaceId: context.workspaceId || auth.workspaceId };
  return listAuthorizedDeploymentRuns(request, resolvedContext);
}

export async function getDeploymentRun(
  request: NextRequest,
  context: RunDetailContext,
): Promise<Response> {
  const auth = await requireRunReadAuth(request, context);
  if (auth instanceof Response) {
    return auth;
  }
  const resolvedContext = { ...context, workspaceId: context.workspaceId || auth.workspaceId };
  if (!requireAuthRunAccess(auth, resolvedContext.runId)) {
    return Response.json({ error: "Deployment run not found", code: "not_found" }, { status: 404 });
  }
  return getAuthorizedDeploymentRun(request, resolvedContext);
}

export async function getDeploymentRunEnvelope(
  request: NextRequest,
  context: RunDetailContext,
): Promise<Response> {
  const auth = await requireRunReadAuth(request, context);
  if (auth instanceof Response) {
    return auth;
  }
  const resolvedContext = { ...context, workspaceId: context.workspaceId || auth.workspaceId };
  if (!requireAuthRunAccess(auth, resolvedContext.runId)) {
    return Response.json({ error: "Deployment run not found", code: "not_found" }, { status: 404 });
  }
  return getAuthorizedDeploymentRunEnvelope(resolvedContext);
}
