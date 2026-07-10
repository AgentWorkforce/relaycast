import { NextRequest, NextResponse } from "next/server";
import { Daytona } from "@daytonaio/sdk";
import { createRelayAuthClient, revokeWorkflowIdentity } from "@cloud/core/relayauth/client.js";
import { canAccessWorkflowRun, requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { revokeApiTokenSessionsForRun } from "@/lib/auth/api-token-store";
import { configureDaytonaFetchFirstAdapter } from "@/lib/daytona-fetch-adapter";
import { workflowStore } from "@/lib/workflows";
import { resolveServerDaytonaAuthParams } from "@/lib/daytona-auth";
import { resolveDaytonaAuthCredentials } from "@cloud/core/auth/credentials.js";

type RouteContext = {
  params: Promise<{ runId: string }>;
};

function getRelayauthIdentityId(run: object): string | null {
  const identityId = (run as { relayauthIdentityId?: unknown }).relayauthIdentityId;
  return typeof identityId === "string" && identityId.length > 0 ? identityId : null;
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId } = await params;
  const run = await workflowStore.get(runId);
  if (!run || !canAccessWorkflowRun(auth, run)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return NextResponse.json({ error: "Run already " + run.status }, { status: 409 });
  }

  // Stop and delete the Daytona sandbox
  if (run.sandboxId) {
    try {
      const serverAuth = resolveServerDaytonaAuthParams();
      const daytonaAuth = resolveDaytonaAuthCredentials({
        apiKey: serverAuth.daytonaApiKey,
        jwtToken: serverAuth.daytonaJwtToken,
        organizationId: serverAuth.daytonaOrganizationId,
      });
      configureDaytonaFetchFirstAdapter();
      const daytona = new Daytona(daytonaAuth);
      const sandbox = await daytona.get(run.sandboxId);
      await daytona.stop(sandbox);
      await daytona.delete(sandbox);
    } catch (err) {
      // Sandbox may already be stopped/deleted — continue with status update
      console.warn("[cancel] Sandbox cleanup error (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // Update run status
  await workflowStore.update(runId, { status: "cancelled" });

  const relayauthIdentityId = getRelayauthIdentityId(run);
  if (relayauthIdentityId) {
    try {
      const relayauthClient = createRelayAuthClient();
      if (relayauthClient) {
        await revokeWorkflowIdentity(relayauthClient, relayauthIdentityId);
      }
    } catch (err) {
      console.warn("[cancel] RelayAuth identity cleanup error (non-fatal):", err instanceof Error ? err.message : err);
    }
  }

  // Revoke API tokens for this run
  await revokeApiTokenSessionsForRun(runId, "run_cancelled").catch(() => {});

  return NextResponse.json({ runId, status: "cancelled" });
}
