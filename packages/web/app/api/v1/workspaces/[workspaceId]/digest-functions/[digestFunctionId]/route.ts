import { NextRequest, NextResponse } from "next/server";
import {
  RequestAuth,
  requireAuthScope,
  requireDigestFunctionsManageScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { hasDigestFunctionWorkspaceAccess } from "@/lib/digest-functions/route-auth";
import { jsonError, type ErrorResponse } from "../../sandboxes/sandbox-utils";

type DigestFunctionDetailContext = {
  params: Promise<{ workspaceId: string; digestFunctionId: string }>;
};

type DigestFunctionDetailResponse = {
  digestFunctionId: string;
  workspaceId: string;
  name: string;
  version: number;
  status: string;
  sha256: string;
  bytes: number;
  entrypoint: string;
  runtime: string;
  createdAt: string;
  updatedAt: string;
};

type DigestFunctionsModule = {
  getDigestFunction?: (input: {
    workspaceId: string;
    digestFunctionId: string;
  }) => Promise<DigestFunctionDetailResponse | null>;
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
  context: DigestFunctionDetailContext,
): Promise<NextResponse<DigestFunctionDetailResponse | ErrorResponse | { error: string; code: string; details?: unknown }>> {
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

  let mod: DigestFunctionsModule | null;
  try {
    mod = await loadModule();
  } catch {
    return jsonError(
      "Failed to load digest function module",
      "digest_function_module_load_failed",
      500,
    );
  }
  if (!mod?.getDigestFunction) {
    return jsonError(
      "Digest function show is not yet implemented",
      "not_implemented",
      501,
    );
  }

  try {
    const row = await mod.getDigestFunction({ workspaceId, digestFunctionId });
    if (!row) {
      return jsonError("Digest function not found", "digest_function_not_found", 404);
    }
    return NextResponse.json<DigestFunctionDetailResponse>(row);
  } catch (error) {
    if (isOrchestrationError(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code ?? "digest_function_error", details: error.details },
        { status: error.status ?? 500 },
      );
    }
    console.error(
      "[digest-functions] show failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to load digest function", code: "digest_function_failed" },
      { status: 500 },
    );
  }
}
