import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import {
  resolveWorkspaceIntegrationIdentity,
  hasWorkspaceIntegrationAccess,
} from "@/lib/workspaces/workspace-integration-identity";
import { getAgentDeploymentTickTarget } from "@/lib/proactive-runtime/persona-deploy";
import {
  DeploymentTriggerDeliveryError,
} from "@/lib/proactive-runtime/deployment-trigger-delivery";
import { enqueueDeploymentTickDelivery } from "@/lib/proactive-runtime/deployment-tick-deliveries";
import { readCloudflareWaitUntil } from "@/lib/proactive-runtime/cloudflare-waituntil";
import { DEPLOYMENT_TRIGGER_DELIVERY_OPTIONS } from "@/lib/proactive-runtime/deployment-trigger-route-options";

type TriggerRouteContext = {
  params: Promise<{ workspaceId: string; agentId: string }>;
};

type TriggerResponse = {
  agentId: string;
  workspaceId: string;
  deploymentId: string;
  status: "starting";
};

type Auth = NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>;

// Same write gate as the deployments POST route: the dashboard session is
// the primary caller; CLI/API tokens with deploy authority may also fire.
function canTrigger(auth: Auth): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:write")
  );
}

/**
 * POST /deployments/:agentId/trigger — operator-initiated one-off fire
 * ("Trigger now" on the agent detail page).
 *
 * Reuses `enqueueDeploymentTickDelivery` VERBATIM — no delivery-path
 * changes. Double-fire safety is structural: every enqueue creates its own
 * deployment row, so the delivery id (`deployment-tick:<deploymentId>`) is
 * unique per call and cannot collide with (or dedupe against) scheduler
 * fires. Two deliberate triggers are two runs, by design; the dashboard
 * button guards accidental double-clicks client-side.
 *
 * The payload self-describes as a manual fire: `eventSourceForPayload`
 * derives `cron:manual:<scheduleId>` for the runs table, and the envelope
 * capture (cloud#1841) persists it verbatim so exported fixtures are
 * honest about their provenance.
 */
export async function POST(
  request: NextRequest,
  context: TriggerRouteContext,
): Promise<NextResponse<TriggerResponse | { error: string; code?: string }>> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized", code: "unauthorized" }, { status: 401 });
  }
  if (!canTrigger(auth)) {
    return NextResponse.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }

  const { workspaceId, agentId } = await context.params;
  if (!workspaceId) {
    return NextResponse.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }
  // The URL may carry the relaycast `rw_*` id while the token's auth.workspaceId
  // is the app UUID (or vice-versa). Resolve both forms and accept either —
  // matching how deploy/list authorize — instead of the exact-equality
  // `hasWorkspaceAccess`, which 403s when the two id forms differ. Thread the
  // resolved APP id downstream: `agents.workspace_id` is keyed by app UUID, so
  // passing the raw `rw_` id would turn the 403 into a 404.
  let identity: Awaited<ReturnType<typeof resolveWorkspaceIntegrationIdentity>>;
  try {
    identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  } catch {
    return NextResponse.json(
      { error: "Workspace not found", code: "workspace_not_found" },
      { status: 404 },
    );
  }
  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return NextResponse.json({ error: "Forbidden", code: "forbidden" }, { status: 403 });
  }
  const appWorkspaceId = identity.appWorkspaceId ?? identity.requestedWorkspaceId;
  if (!isUuid(appWorkspaceId)) {
    return NextResponse.json(
      { error: "Workspace not found", code: "workspace_not_found" },
      { status: 404 },
    );
  }

  const target = await getAgentDeploymentTickTarget({ workspaceId: appWorkspaceId, agentId });
  if (!target) {
    return NextResponse.json({ error: "Deployment target not found", code: "not_found" }, { status: 404 });
  }
  if (target.status !== "active") {
    return NextResponse.json({ error: "Deployment target is not active", code: "inactive" }, { status: 409 });
  }

  // The tick target carries the pinned agent spec; use its first declared
  // schedule name so the runs table reads `cron:manual:<schedule>` for
  // scheduled agents, falling back to plain "manual" for unscheduled ones
  // (the endpoint allows firing any ACTIVE agent — the UI only surfaces
  // the button for scheduled agents, but a manual fire of an unscheduled
  // active agent is harmless and useful).
  const firstSchedule = target.agentSpec?.schedules?.[0];
  const scheduleId =
    firstSchedule &&
    typeof firstSchedule === "object" &&
    "name" in firstSchedule &&
    typeof (firstSchedule as { name: unknown }).name === "string"
      ? (firstSchedule as { name: string }).name
      : "manual";
  const payload = {
    type: "cron.tick",
    scheduleName: "manual",
    scheduleId,
    manual: true,
    triggeredByUserId: auth.userId ?? null,
    occurredAt: new Date().toISOString(),
  };

  try {
    const waitUntil = readCloudflareWaitUntil();
    if (!waitUntil) {
      return NextResponse.json(
        { error: "Failed to deliver manual trigger", code: "trigger_delivery_failed" },
        { status: 502 },
      );
    }

    const result = await enqueueDeploymentTickDelivery({
      workspaceId: appWorkspaceId,
      target,
      payload,
      waitUntil,
      options: DEPLOYMENT_TRIGGER_DELIVERY_OPTIONS,
    });
    return NextResponse.json<TriggerResponse>(result, { status: 202 });
  } catch (error) {
    if (error instanceof DeploymentTriggerDeliveryError) {
      console.error("[trigger-now] preflight failed:", error.code, error.message);
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status },
      );
    }
    console.error(
      "[trigger-now] delivery failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to deliver manual trigger", code: "trigger_delivery_failed" },
      { status: 502 },
    );
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
