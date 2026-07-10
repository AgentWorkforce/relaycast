import { NextRequest, NextResponse } from "next/server";
import {
  createApiTokenSession,
  revokeApiTokenSessionById,
} from "@/lib/auth/api-token-store";
import {
  decryptJson,
  verifyScheduleWebhookSecret,
  type WorkflowRunScheduleRequest,
} from "@/lib/workflow-schedules/request";
import { getWorkflowScheduleCredentialEncryptionKey } from "@/lib/workflow-schedules/config";
import { workflowScheduleStore } from "@/lib/workflow-schedules/store";
import { toAbsoluteAppUrl } from "@/lib/app-path";
import { POST as runWorkflow } from "../../run/route";

const LAUNCH_ERROR_MAX_LENGTH = 2_000;
const SCHEDULE_TOKEN_QUERY_PARAM = "workflow_schedule_token";

function readWebhookSecret(request: NextRequest): string | null {
  const headerToken = request.headers.get("x-cloud-workflow-schedule-token")?.trim();
  if (headerToken) {
    return headerToken;
  }
  const queryToken = new URL(request.url).searchParams.get(SCHEDULE_TOKEN_QUERY_PARAM)?.trim();
  return queryToken || null;
}

function readScheduleId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const candidate = record.scheduleId ?? record.cloudScheduleId;
  return typeof candidate === "string" && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

function describeLaunchFailure(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    for (const key of ["message", "error", "code"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim().slice(0, LAUNCH_ERROR_MAX_LENGTH);
      }
    }
  }
  return fallback.slice(0, LAUNCH_ERROR_MAX_LENGTH);
}

async function recordTriggerFailure(
  scheduleId: string,
  triggeredAt: Date,
  error: string,
): Promise<void> {
  try {
    await workflowScheduleStore.update(scheduleId, {
      lastTriggeredRunId: null,
      lastTriggeredAt: triggeredAt,
      lastTriggerStatus: "failed",
      lastTriggerError: error.slice(0, LAUNCH_ERROR_MAX_LENGTH),
    });
  } catch (updateError) {
    console.error("[workflow-schedules] failed to persist trigger failure", {
      scheduleId,
      error,
      updateError: updateError instanceof Error ? updateError.message : String(updateError),
    });
  }
}

export async function POST(request: NextRequest) {
  const webhookSecret = readWebhookSecret(request);
  if (!webhookSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const scheduleId = readScheduleId(body);
  if (!scheduleId) {
    return NextResponse.json({ error: "scheduleId is required" }, { status: 400 });
  }

  const schedule = await workflowScheduleStore.get(scheduleId);
  if (!schedule || schedule.status === "deleted") {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }
  if (schedule.status !== "active") {
    return NextResponse.json({ error: "Schedule is not active" }, { status: 409 });
  }
  if (!verifyScheduleWebhookSecret(webhookSecret, schedule.webhookSecretHash)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const triggeredAt = new Date();
  const runId = crypto.randomUUID();
  if (schedule.scheduleType === "once") {
    const claimed = await workflowScheduleStore.claimOnceTrigger(schedule.id, triggeredAt);
    if (!claimed) {
      return NextResponse.json({ error: "Schedule was already triggered" }, { status: 409 });
    }
  }

  let issuedToken: Awaited<ReturnType<typeof createApiTokenSession>> | null = null;

  try {
    const workflowRequest = await decryptJson<WorkflowRunScheduleRequest>(
      schedule.workflowRequestEnvelope,
      getWorkflowScheduleCredentialEncryptionKey(),
    );
    issuedToken = await createApiTokenSession({
      subjectType: "cli",
      userId: schedule.userId,
      workspaceId: schedule.workspaceId,
      organizationId: schedule.organizationId,
      scopes: ["cli:auth"],
      accessTokenTtlSeconds: 5 * 60,
      refreshTokenTtlSeconds: 5 * 60,
    });

    const runUrl = toAbsoluteAppUrl(
      new URL(request.url).origin,
      "/api/v1/workflows/run",
    ).toString();
    const launchRequest = new NextRequest(runUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${issuedToken.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ...workflowRequest, runId }),
    });
    const launchResponse = await runWorkflow(launchRequest);
    const launchBody = await launchResponse.json().catch(() => null) as
      | { runId?: unknown; error?: unknown; message?: unknown; code?: unknown }
      | null;

    if (launchResponse.ok && typeof launchBody?.runId === "string") {
      await workflowScheduleStore.update(schedule.id, {
        lastTriggeredRunId: launchBody.runId,
        lastTriggeredAt: triggeredAt,
        lastTriggerStatus: "succeeded",
        lastTriggerError: null,
      });
    } else {
      await recordTriggerFailure(
        schedule.id,
        triggeredAt,
        describeLaunchFailure(launchBody, `Workflow launch failed with status ${launchResponse.status}`),
      );
    }

    return NextResponse.json(
      {
        scheduleId: schedule.id,
        ok: launchResponse.ok,
        run: launchBody,
      },
      { status: launchResponse.status },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordTriggerFailure(schedule.id, triggeredAt, message);
    console.error("[workflow-schedules] scheduled workflow launch failed", {
      scheduleId: schedule.id,
      runId,
      error: message,
    });
    return NextResponse.json(
      {
        scheduleId: schedule.id,
        ok: false,
        error: "scheduled_workflow_launch_failed",
        message,
      },
      { status: 500 },
    );
  } finally {
    if (issuedToken) {
      await revokeApiTokenSessionById(issuedToken.sessionId, "workflow_schedule_triggered").catch(
        () => undefined,
      );
    }
  }
}
