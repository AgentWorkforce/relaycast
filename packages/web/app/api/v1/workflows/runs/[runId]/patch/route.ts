import { NextRequest, NextResponse } from "next/server";
import { workflowStore } from "@/lib/workflows";
import { getWorkflowStorageObject, isWorkflowStorageConfigured } from "@/lib/storage";
import { canAccessWorkflowRun, requireAuthRunAccess, requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";

/**
 * GET /api/v1/workflows/runs/[runId]/patch
 *
 * Download the git patch of changes made by agents during a workflow run.
 * The bootstrap script commits a baseline before the workflow starts and
 * uploads either a legacy `changes.patch` diff or one `changes-{name}.patch`
 * diff per submitted path to S3 after the workflow completes.
 *
 * Returns:
 *   { patch: string, hasChanges: boolean }
 *   or { patches: { [name]: { patch: string, hasChanges: boolean } } }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ runId: string }> }
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "workflow:runs:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId } = await params;
  if (!requireAuthRunAccess(auth, runId)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const run = await workflowStore.get(runId);
  if (!run || !canAccessWorkflowRun(auth, run)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  if (run.status !== "completed" && run.status !== "failed") {
    return NextResponse.json(
      { error: "Run is still in progress. Patch is available after completion." },
      { status: 409 }
    );
  }

  if (!isWorkflowStorageConfigured()) {
    return NextResponse.json({ patch: "", hasChanges: false });
  }

  async function readPatch(patchKey: string): Promise<{ patch: string; hasChanges: boolean }> {
    try {
      const response = await getWorkflowStorageObject({ key: patchKey });
      if (!response?.body) {
        return { patch: "", hasChanges: false };
      }

      const reader = response.body.getReader();
      const chunks: Buffer[] = [];
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(Buffer.from(next.value));
        }
      } finally {
        reader.releaseLock();
      }
      const patch = Buffer.concat(chunks).toString("utf-8");

      return {
        patch,
        hasChanges: patch.trim().length > 0,
      };
    } catch (err: unknown) {
      if (
        err &&
        typeof err === "object" &&
        "name" in err &&
        (err.name === "NoSuchKey" || err.name === "NotFound")
      ) {
        return { patch: "", hasChanges: false };
      }
      throw err;
    }
  }

  try {
    if (run.paths && run.paths.length > 0) {
      const requestedPath = new URL(request.url).searchParams.get("path")?.trim();
      if (requestedPath) {
        const entry = run.paths.find((pathEntry) => pathEntry.name === requestedPath);
        if (!entry) {
          return NextResponse.json({ error: "Path not found" }, { status: 404 });
        }
        return NextResponse.json(
          await readPatch(`${run.userId}/${runId}/changes-${entry.name}.patch`),
        );
      }

      const patches: Record<string, { patch: string; hasChanges: boolean }> = {};
      for (const entry of run.paths) {
        patches[entry.name] = await readPatch(`${run.userId}/${runId}/changes-${entry.name}.patch`);
      }
      return NextResponse.json({ patches });
    }

    return NextResponse.json(await readPatch(`${run.userId}/${runId}/changes.patch`));
  } catch (err) {
    console.error("Patch download error:", err);
    return NextResponse.json({ error: "Failed to read patch" }, { status: 500 });
  }
}
