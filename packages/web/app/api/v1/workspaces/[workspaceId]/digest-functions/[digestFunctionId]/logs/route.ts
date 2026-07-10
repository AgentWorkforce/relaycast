import { NextRequest, NextResponse } from "next/server";
import {
  RequestAuth,
  requireAuthScope,
  requireDigestFunctionsManageScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasDigestFunctionWorkspaceAccess } from "@/lib/digest-functions/route-auth";
import { jsonError, type ErrorResponse } from "../../../sandboxes/sandbox-utils";

type DigestFunctionLogsContext = {
  params: Promise<{ workspaceId: string; digestFunctionId: string }>;
};

type DigestFunctionLogsResponse = {
  digestFunctionId: string;
  logs: Array<{
    invocationId: string;
    occurredAt: string;
    level: string;
    message: string;
    durationMs?: number;
  }>;
  nextCursor: string | null;
};

type DigestFunctionsModule = {
  fetchRecentInvocationLogs?: (input: {
    workspaceId: string;
    digestFunctionId: string;
    since: Date | null;
    limit: number;
  }) => Promise<DigestFunctionLogsResponse | null>;
};

async function loadModule(): Promise<DigestFunctionsModule | null> {
  try {
    return (await import("@/lib/digest-functions")) as DigestFunctionsModule;
  } catch (error) {
    console.error(
      "[digest-functions] failed to load orchestration module:",
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

function canRead(auth: RequestAuth): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireDigestFunctionsManageScope(auth) ||
    requireAuthScope(auth, "digest-functions:read")
  );
}

function clampLimit(raw: string | null, defaultValue: number, max: number): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

function parseSince(raw: string | null): Date | null {
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isOrchestrationError(
  candidate: unknown,
): candidate is Error & { status?: number; code?: string; details?: unknown } {
  return (
    candidate instanceof Error &&
    typeof (candidate as { status?: number }).status === "number"
  );
}

export async function GET(
  request: NextRequest,
  context: DigestFunctionLogsContext,
): Promise<NextResponse<DigestFunctionLogsResponse | ErrorResponse | { error: string; code: string; details?: unknown }>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (!canRead(auth)) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId, digestFunctionId } = await context.params;
  if (!workspaceId) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  if (!(await hasDigestFunctionWorkspaceAccess(auth, workspaceId))) {
    return jsonError("Forbidden", "forbidden", 403);
  }
  if (!digestFunctionId) {
    return jsonError("Digest function not found", "digest_function_not_found", 404);
  }

  const sinceRaw = request.nextUrl.searchParams.get("since");
  if (sinceRaw && !parseSince(sinceRaw)) {
    return jsonError("Invalid since timestamp", "invalid_since", 400);
  }
  const since = parseSince(sinceRaw);
  const limit = clampLimit(request.nextUrl.searchParams.get("limit"), 50, 200);

  let mod: DigestFunctionsModule | null;
  try {
    mod = await loadModule();
  } catch {
    return jsonError(
      "Failed to load digest function logs",
      "digest_function_module_load_failed",
      500,
    );
  }
  if (!mod?.fetchRecentInvocationLogs) {
    return jsonError(
      "Digest function logs are not yet implemented",
      "not_implemented",
      501,
    );
  }

  try {
    const result = await mod.fetchRecentInvocationLogs({
      workspaceId,
      digestFunctionId,
      since,
      limit,
    });
    if (!result) {
      return jsonError("Digest function not found", "digest_function_not_found", 404);
    }
    return NextResponse.json<DigestFunctionLogsResponse>(result);
  } catch (error) {
    if (isOrchestrationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code ?? "digest_function_error", details: error.details },
        { status: error.status ?? 500 },
      );
    }
    console.error(
      "[digest-functions] logs failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to load digest function logs", code: "digest_function_failed" },
      { status: 500 },
    );
  }
}
