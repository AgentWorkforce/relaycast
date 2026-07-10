import { NextRequest, NextResponse } from "next/server";
import {
  createDaytonaClient,
  jsonError,
  markSandboxDeleted,
  requireSandboxRecord,
  requireWorkspaceSandboxAuth,
  type WorkspaceSandboxRouteContext,
} from "../sandbox-utils";

export async function DELETE(
  request: NextRequest,
  context: WorkspaceSandboxRouteContext,
) {
  const access = await requireWorkspaceSandboxAuth(request, context);
  if (!access.ok) {
    return access.response;
  }

  const sandboxRecord = await requireSandboxRecord(
    access.workspaceId,
    access.sandboxId,
  );
  if (!sandboxRecord.ok) {
    return sandboxRecord.response;
  }

  try {
    const daytona = createDaytonaClient();
    const sandbox = await daytona.get(access.sandboxId!);
    await daytona.delete(sandbox);
    await markSandboxDeleted(access.workspaceId, access.sandboxId!);
    return NextResponse.json({ sandboxId: access.sandboxId, deleted: true });
  } catch (error) {
    console.error(
      "[workforce-sandbox] delete failed:",
      error instanceof Error ? error.message : String(error),
    );
    return jsonError("Failed to delete sandbox", "sandbox_delete_failed", 502);
  }
}
