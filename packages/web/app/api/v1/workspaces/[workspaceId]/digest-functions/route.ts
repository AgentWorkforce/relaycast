import { NextRequest, NextResponse } from "next/server";
import {
  RequestAuth,
  requireAuthScope,
  requireDigestFunctionsManageScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasDigestFunctionWorkspaceAccess } from "@/lib/digest-functions/route-auth";
import {
  jsonError,
  readJsonBody,
  type ErrorResponse,
} from "../sandboxes/sandbox-utils";

type DigestFunctionRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type DigestFunctionDeployResponse = {
  digestFunctionId: string;
  version: number;
  status: string;
  sha256: string;
};

type DigestFunctionListResponse = {
  digestFunctions: Array<{
    digestFunctionId: string;
    name: string;
    version: number;
    status: string;
    sha256: string;
    bytes: number;
    createdAt: string;
  }>;
  nextCursor: string | null;
};

type DigestFunctionsModule = {
  deployDigestFunction?: (input: {
    workspaceId: string;
    requesterUserId: string;
    body: unknown;
  }) => Promise<{
    digestFunctionId: string;
    version: number;
    status: string;
    sha256: string;
  }>;
  listDigestFunctions?: (input: {
    workspaceId: string;
    cursor: string | null;
    limit: number;
  }) => Promise<DigestFunctionListResponse>;
  parseDigestFunctionDeployRequest?: (raw: unknown) => unknown;
  DigestFunctionDeployError?: new (
    message: string,
    code?: string,
    status?: number,
    details?: unknown,
  ) => Error & { status?: number; code?: string; details?: unknown };
};

async function loadDigestFunctionsModule(): Promise<DigestFunctionsModule | null> {
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

function canManage(auth: RequestAuth): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireDigestFunctionsManageScope(auth)
  );
}

function canRead(auth: RequestAuth): boolean {
  return canManage(auth) || requireAuthScope(auth, "digest-functions:read");
}

function clampLimit(raw: string | null, defaultValue: number, max: number): number {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return Math.min(parsed, max);
}

function isOrchestrationError(
  candidate: unknown,
): candidate is Error & { status?: number; code?: string; details?: unknown } {
  return (
    candidate instanceof Error &&
    typeof (candidate as { status?: number }).status === "number"
  );
}

function mapOrchestrationError(error: unknown): NextResponse<ErrorResponse | { error: string; code: string; details?: unknown }> {
  if (isOrchestrationError(error)) {
    return NextResponse.json(
      {
        error: error.message,
        code: error.code ?? "digest_function_error",
        details: error.details,
      },
      { status: error.status ?? 500 },
    );
  }
  console.error(
    "[digest-functions] route failed:",
    error instanceof Error ? error.message : String(error),
  );
  return NextResponse.json(
    { error: "Failed to process digest function request", code: "digest_function_failed" },
    { status: 500 },
  );
}

export async function POST(
  request: NextRequest,
  context: DigestFunctionRouteContext,
): Promise<NextResponse<DigestFunctionDeployResponse | ErrorResponse | { error: string; code: string; details?: unknown }>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (!canManage(auth)) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId } = await context.params;
  if (!workspaceId) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  if (!(await hasDigestFunctionWorkspaceAccess(auth, workspaceId))) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const body = await readJsonBody(request);
  if (body === null) {
    return jsonError("Invalid JSON body", "invalid_body", 400);
  }

  let mod: DigestFunctionsModule | null;
  try {
    mod = await loadDigestFunctionsModule();
  } catch {
    return jsonError(
      "Failed to load digest function module",
      "digest_function_module_load_failed",
      500,
    );
  }
  if (!mod?.deployDigestFunction || !mod?.parseDigestFunctionDeployRequest) {
    return jsonError(
      "Digest function deploy is not yet implemented",
      "not_implemented",
      501,
    );
  }

  try {
    const parsed = mod.parseDigestFunctionDeployRequest(body);
    const result = await mod.deployDigestFunction({
      workspaceId,
      requesterUserId: auth.userId,
      body: parsed,
    });
    return NextResponse.json<DigestFunctionDeployResponse>(result, { status: 201 });
  } catch (error) {
    return mapOrchestrationError(error);
  }
}

export async function GET(
  request: NextRequest,
  context: DigestFunctionRouteContext,
): Promise<NextResponse<DigestFunctionListResponse | ErrorResponse | { error: string; code: string; details?: unknown }>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return jsonError("Unauthorized", "unauthorized", 401);
  }
  if (!canRead(auth)) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const { workspaceId } = await context.params;
  if (!workspaceId) {
    return jsonError("Workspace not found", "workspace_not_found", 404);
  }
  if (!(await hasDigestFunctionWorkspaceAccess(auth, workspaceId))) {
    return jsonError("Forbidden", "forbidden", 403);
  }

  const cursor = request.nextUrl.searchParams.get("cursor");
  const limit = clampLimit(request.nextUrl.searchParams.get("limit"), 25, 100);

  let mod: DigestFunctionsModule | null;
  try {
    mod = await loadDigestFunctionsModule();
  } catch {
    return jsonError(
      "Failed to load digest function module",
      "digest_function_module_load_failed",
      500,
    );
  }
  if (!mod?.listDigestFunctions) {
    return jsonError(
      "Digest function listing is not yet implemented",
      "not_implemented",
      501,
    );
  }

  try {
    const result = await mod.listDigestFunctions({ workspaceId, cursor, limit });
    return NextResponse.json<DigestFunctionListResponse>(result);
  } catch (error) {
    return mapOrchestrationError(error);
  }
}
