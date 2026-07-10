import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
  type RequestAuth,
} from "@/lib/auth/request-auth";
import {
  createRelayhistorySession,
  type RelayhistorySessionMode,
} from "@/lib/relayhistory-session";
import {
  hasRelayhistoryLoginScope,
  resolveRelayhistoryWorkspaceAccess,
} from "@/lib/relayhistory-access";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type RequestBody = {
  mode?: unknown;
  label?: unknown;
};

const RTH_SYNC_SCOPE = "rth:sync";

function jsonError(error: string, code: string, status: number) {
  return NextResponse.json({ error, code }, { status });
}

async function readBody(request: NextRequest): Promise<RequestBody | null> {
  const raw = await request.text();
  if (!raw.trim()) {
    return {};
  }
  try {
    const body = JSON.parse(raw) as unknown;
    return body && typeof body === "object" && !Array.isArray(body)
      ? body as RequestBody
      : null;
  } catch {
    return null;
  }
}

function parseMode(value: unknown): RelayhistorySessionMode | null {
  if (value === undefined || value === null) {
    return "sync";
  }
  return value === "read" || value === "sync" ? value : null;
}

function parseLabel(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 128)
    : undefined;
}

function authorizedMode(
  requestedMode: RelayhistorySessionMode,
  auth: RequestAuth,
): RelayhistorySessionMode | null {
  if (requestedMode === "read") {
    return hasRelayhistoryLoginScope(auth) ? "read" : null;
  }
  if (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, RTH_SYNC_SCOPE)
  ) {
    return "sync";
  }
  return null;
}

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (
    auth.source === "relayfile" ||
    auth.source === "service" ||
    !hasRelayhistoryLoginScope(auth)
  ) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId } = await context.params;
  const workspaceAccess = await resolveRelayhistoryWorkspaceAccess(workspaceId, auth);
  if (!workspaceAccess) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }

  const body = await readBody(request);
  if (!body) {
    return jsonError("Invalid request body", "invalid_request", 400);
  }
  if ("relayhistoryUrl" in body || "orgId" in body || "workspaceId" in body || "userId" in body) {
    return jsonError("Invalid request body", "invalid_request", 400);
  }

  const mode = parseMode(body.mode);
  if (!mode) {
    return jsonError("Invalid mode", "invalid_mode", 400);
  }
  const grantedMode = authorizedMode(mode, auth);
  if (!grantedMode) {
    return jsonError("Requested mode is not authorized", "mode_not_authorized", 403);
  }

  try {
    const session = await createRelayhistorySession({
      userId: auth.userId,
      orgId: workspaceAccess.orgId,
      workspaceId,
      mode: grantedMode,
      label: parseLabel(body.label),
    });
    return NextResponse.json(session);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Relayhistory session failed";
    return jsonError(message, "relayhistory_session_failed", 502);
  }
}
