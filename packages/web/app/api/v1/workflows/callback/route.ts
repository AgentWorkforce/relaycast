import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createRelayAuthClient, revokeWorkflowIdentity } from "@cloud/core/relayauth/client.js";
import { revokeApiTokenSessionsForRun } from "@/lib/auth/api-token-store";
import { workflowStore, type WorkflowPathPushResult, type WorkflowRecord } from "@/lib/workflows";
import { resolveRepoAllowlistOrRelaxed } from "@/lib/integrations/workflow-repository-allowlists";
import {
  PushBackError,
  pushWorkflowPathPatch,
  readWorkflowPathPatch,
  type DefaultBranchCache,
} from "@/lib/integrations/github-push-back";

type CallbackBody = {
  runId: string;
  callbackToken?: string;
  status: string;
  result?: unknown;
  error?: string;
};

function isCallbackBody(payload: unknown): payload is CallbackBody {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const body = payload as Partial<CallbackBody>;
  return (
    typeof body.runId === "string" &&
    body.runId.length > 0 &&
    (body.callbackToken === undefined || body.callbackToken === null || typeof body.callbackToken === "string") &&
    typeof body.status === "string" &&
    body.status.length > 0 &&
    (!("error" in body) || body.error === undefined || typeof body.error === "string")
  );
}

function getCallbackToken(request: NextRequest): string | null {
  const token = request.headers.get("x-callback-token")?.trim();
  return token && token.length > 0 ? token : null;
}

function getRelayauthIdentityId(run: object): string | null {
  const identityId = (run as { relayauthIdentityId?: unknown }).relayauthIdentityId;
  return typeof identityId === "string" && identityId.length > 0 ? identityId : null;
}

function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function failedPushResult(
  code: Extract<WorkflowPathPushResult, { status: "failed" }>["code"],
  message: string,
): WorkflowPathPushResult {
  return {
    status: "failed",
    code,
    message: message.slice(0, 500),
    failedAt: new Date().toISOString(),
  };
}

async function persistPushResult(runId: string, pathName: string, result: WorkflowPathPushResult): Promise<void> {
  await workflowStore.update(runId, {
    pushedTo: {
      [pathName]: result,
    },
  });
}

async function pushAllowedPathPatches(run: WorkflowRecord): Promise<void> {
  if (!run.paths || run.paths.length === 0) {
    return;
  }

  await workflowStore.update(run.runId, { pushedTo: {} });

  // Single shared cache so multiple paths in the same repo only fetch
  // `/repos/{owner}/{repo}` once for default-branch resolution.
  const defaultBranchCache: DefaultBranchCache = new Map();

  for (const path of run.paths) {
    if (!path.repoOwner || !path.repoName) {
      continue;
    }

    let allowlist;
    try {
      allowlist = await resolveRepoAllowlistOrRelaxed(
        run.workspaceId,
        path.repoOwner,
        path.repoName,
      );
    } catch (error) {
      // Preserve the underlying failure code when it's a PushBackError —
      // an "installation_token_failed" (Nango misconfig, install
      // revoked) shouldn't show up in pushedTo as "github_api_error",
      // because that masks the actual root cause from operators
      // reading the run record.
      const code = error instanceof PushBackError ? error.code : "github_api_error";
      const message = error instanceof Error ? error.message : String(error);
      await persistPushResult(run.runId, path.name, failedPushResult(code, message));
      continue;
    }
    if (!allowlist?.pushAllowed) {
      continue;
    }

    let patchRead;
    try {
      patchRead = await readWorkflowPathPatch({
        userId: run.userId,
        runId: run.runId,
        pathName: path.name,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await persistPushResult(run.runId, path.name, failedPushResult("patch_unapplyable", message));
      continue;
    }

    if (!patchRead.hasChanges) {
      continue;
    }

    const result = await pushWorkflowPathPatch({
      run,
      path,
      allowlist,
      patch: patchRead.patch,
      s3Key: patchRead.s3Key,
      defaultBranchCache,
    });
    await persistPushResult(run.runId, path.name, result);
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid callback body" }, { status: 400 });
  }

  if (!isCallbackBody(body)) {
    return NextResponse.json({ error: "Invalid callback body" }, { status: 400 });
  }

  const run = await workflowStore.get(body.runId);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const bodyToken = typeof body.callbackToken === "string" && body.callbackToken.length > 0 ? body.callbackToken : null;
  const headerToken = getCallbackToken(request);
  if (!bodyToken && !headerToken) {
    return NextResponse.json({ error: "Invalid callback token" }, { status: 401 });
  }

  if (bodyToken && headerToken && bodyToken !== headerToken) {
    return NextResponse.json({ error: "Invalid callback token" }, { status: 401 });
  }

  const token = bodyToken || headerToken!;
  const expected = Buffer.from(run.callbackToken, "utf8");
  const received = Buffer.from(token, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return NextResponse.json({ error: "Invalid callback token" }, { status: 401 });
  }

  // Once a run reaches a terminal status (`completed`/`failed`/`cancelled`),
  // refuse any further status changes. Without this, a delayed `running`
  // heartbeat racing the reaper or a user cancellation would resurrect the
  // row back to `running`, leaving an inconsistent run whose sandbox is gone
  // and whose tokens are revoked.
  if (isTerminalStatus(run.status) && body.status !== run.status) {
    return NextResponse.json(
      {
        error: "Run is already in a terminal status",
        runId: body.runId,
        currentStatus: run.status,
      },
      { status: 409 },
    );
  }

  const updatedRun = await workflowStore.update(body.runId, {
    status: body.status,
    ...(Object.hasOwn(body, "result") ? { result: body.result } : {}),
    ...(body.error !== undefined ? { error: body.error } : {}),
  });

  if (body.status === "completed") {
    // Idempotency guard: callback delivery is at-least-once (network
    // retries, queue redelivery), so a re-delivered `completed` callback
    // would re-enter the push-back loop, double-push to GitHub, and
    // overwrite an already-populated `pushedTo`. First delivery wins —
    // if `pushedTo` already has any keys, skip push-back entirely. Filling
    // remaining keys is intentionally not attempted here (the operator
    // can re-trigger via a different mechanism if needed).
    const previousPushedTo = (run as { pushedTo?: Record<string, unknown> | null }).pushedTo;
    const alreadyPushed =
      previousPushedTo !== null &&
      previousPushedTo !== undefined &&
      Object.keys(previousPushedTo).length > 0;
    if (!alreadyPushed) {
      try {
        await pushAllowedPathPatches(updatedRun);
      } catch (error) {
        console.error("Workflow push-back loop failed:", error);
      }
    }
  }

  if (body.status === "completed" || body.status === "failed") {
    const relayauthClient = createRelayAuthClient();
    const relayauthIdentityId = getRelayauthIdentityId(run);
    if (relayauthClient && relayauthIdentityId) {
      try {
        await revokeWorkflowIdentity(relayauthClient, relayauthIdentityId);
      } catch (err) {
        console.error("Failed to revoke workflow identity:", err);
      }
    }
    await revokeApiTokenSessionsForRun(body.runId, `run_${body.status}`);
  }

  return NextResponse.json({ runId: body.runId, status: body.status });
}
