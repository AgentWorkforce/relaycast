import { NextRequest, NextResponse } from "next/server";
import {
  createRelaycronApiKey,
  createRelaycronSchedule,
  RelaycronClientError,
} from "@/lib/workflow-schedules/relaycron-client";
import {
  encryptJsonAsync,
  generateScheduleWebhookSecret,
  hashScheduleWebhookSecret,
  parseCreateWorkflowScheduleRequest,
} from "@/lib/workflow-schedules/request";
import { getWorkflowScheduleCredentialEncryptionKey } from "@/lib/workflow-schedules/config";
import {
  toPublicWorkflowSchedule,
  type PublicWorkflowScheduleRecord,
  type WorkflowScheduleRecord,
  workflowScheduleStore,
} from "@/lib/workflow-schedules/store";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { getConfiguredAppOrigin } from "@/lib/app-origin";
import { toAbsoluteAppUrl } from "@/lib/app-path";

const SCHEDULE_ROUTE_TIMEOUT_MS = 8_000;
const SCHEDULE_TOKEN_QUERY_PARAM = "workflow_schedule_token";

function relaycronErrorResponse(error: unknown) {
  if (error instanceof RelaycronClientError) {
    return NextResponse.json(
      {
        error: "relaycron_error",
        code: error.code,
        message: error.message,
      },
      { status: error.status >= 400 && error.status < 500 ? 400 : 502 },
    );
  }
  throw error;
}

function hasWorkflowScheduleAccess(auth: Awaited<ReturnType<typeof resolveRequestAuth>>): boolean {
  return requireSessionAuth(auth) || requireAuthScope(auth, "cli:auth");
}

class ScheduleRouteTimeoutError extends Error {
  constructor(readonly stage: string) {
    super(`Timed out while handling workflow schedules at stage: ${stage}`);
    this.name = "ScheduleRouteTimeoutError";
  }
}

async function withScheduleRouteTimeout<T>(stage: string, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ScheduleRouteTimeoutError(stage)),
          SCHEDULE_ROUTE_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

function scheduleRouteTimeoutResponse(error: ScheduleRouteTimeoutError, method = "GET") {
  console.error("[workflow-schedules] schedule route timed out", {
    method,
    stage: error.stage,
    timeoutMs: SCHEDULE_ROUTE_TIMEOUT_MS,
  });
  return NextResponse.json(
    {
      error: "workflow_schedules_timeout",
      stage: error.stage,
      message: "Timed out while handling workflow schedules.",
    },
    { status: 503 },
  );
}

async function deleteRelaycronScheduleBestEffort(
  relaycronApiKey: string | null,
  relaycronScheduleId: string | null,
) {
  if (!relaycronScheduleId || !relaycronApiKey) {
    return;
  }
  try {
    const { deleteRelaycronSchedule } = await import(
      "@/lib/workflow-schedules/relaycron-client"
    );
    await withScheduleRouteTimeout(
      "deleteRelaycronSchedule",
      deleteRelaycronSchedule(relaycronApiKey, relaycronScheduleId),
    );
  } catch (cleanupError) {
    console.error("[workflow-schedules] failed to roll back relaycron schedule", {
      relaycronScheduleId,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

async function deleteRelaycronSchedulesByCloudScheduleIdBestEffort(
  relaycronApiKey: string | null,
  cloudScheduleId: string,
) {
  if (!relaycronApiKey) {
    return;
  }
  try {
    const { listRelaycronSchedules, deleteRelaycronSchedule } = await import(
      "@/lib/workflow-schedules/relaycron-client"
    );
    const schedules = await listRelaycronSchedules(relaycronApiKey);
    await Promise.allSettled(
      schedules
        .filter((schedule) =>
          schedule.metadata &&
          typeof schedule.metadata === "object" &&
          !Array.isArray(schedule.metadata) &&
          (schedule.metadata as Record<string, unknown>).cloudScheduleId === cloudScheduleId
        )
        .map((schedule) => deleteRelaycronSchedule(relaycronApiKey, schedule.id)),
    );
  } catch (cleanupError) {
    console.warn("[workflow-schedules] failed to cleanup relaycron schedules by metadata", {
      cloudScheduleId,
      error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    });
  }
}

async function toPublicSchedulesWithVerifiedRunLinks(
  schedules: WorkflowScheduleRecord[],
): Promise<PublicWorkflowScheduleRecord[]> {
  const publicSchedules = schedules.map(toPublicWorkflowSchedule);
  const runIds = [
    ...new Set(
      publicSchedules
        .map((schedule) => schedule.lastTriggeredRunId)
        .filter((runId): runId is string => typeof runId === "string" && runId.length > 0),
    ),
  ];
  if (runIds.length === 0) {
    return publicSchedules;
  }

  const existingRunIds = await withScheduleRouteTimeout(
    "verifyTriggeredRuns",
    workflowScheduleStore.existingWorkflowRunIds(runIds),
  );

  return publicSchedules.map((schedule) => {
    if (!schedule.lastTriggeredRunId || existingRunIds.has(schedule.lastTriggeredRunId)) {
      return schedule;
    }
    return {
      ...schedule,
      lastTriggeredRunId: null,
      lastTriggerStatus: schedule.lastTriggerStatus ?? "failed",
      lastTriggerError:
        schedule.lastTriggerError ?? "Workflow launch did not create a run record.",
    };
  });
}

export async function GET(request: NextRequest) {
  let auth;
  try {
    auth = await withScheduleRouteTimeout("auth", resolveRequestAuth(request));
  } catch (error) {
    if (error instanceof ScheduleRouteTimeoutError) {
      return scheduleRouteTimeoutResponse(error);
    }
    throw error;
  }
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasWorkflowScheduleAccess(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (requireSessionAuth(auth)) {
    const organizationWorkspaceIds = auth.context.workspaces
      .filter((workspace) => workspace.organization_id === auth.context.currentOrganization.id)
      .map((workspace) => workspace.id);
    let schedules;
    try {
      schedules = await withScheduleRouteTimeout(
        "listByWorkspaceIds",
        workflowScheduleStore.listByWorkspaceIds(organizationWorkspaceIds),
      );
    } catch (error) {
      if (error instanceof ScheduleRouteTimeoutError) {
        return scheduleRouteTimeoutResponse(error);
      }
      throw error;
    }
    try {
      return NextResponse.json({
        schedules: await toPublicSchedulesWithVerifiedRunLinks(schedules),
      });
    } catch (error) {
      if (error instanceof ScheduleRouteTimeoutError) {
        return scheduleRouteTimeoutResponse(error);
      }
      throw error;
    }
  }

  let schedules;
  try {
    schedules = await withScheduleRouteTimeout(
      "listByWorkspace",
      workflowScheduleStore.listByWorkspace(auth.workspaceId),
    );
  } catch (error) {
    if (error instanceof ScheduleRouteTimeoutError) {
      return scheduleRouteTimeoutResponse(error);
    }
    throw error;
  }
  try {
    return NextResponse.json({
      schedules: await toPublicSchedulesWithVerifiedRunLinks(schedules),
    });
  } catch (error) {
    if (error instanceof ScheduleRouteTimeoutError) {
      return scheduleRouteTimeoutResponse(error);
    }
    throw error;
  }
}

export async function POST(request: NextRequest) {
  let auth;
  try {
    auth = await withScheduleRouteTimeout("auth", resolveRequestAuth(request));
  } catch (error) {
    if (error instanceof ScheduleRouteTimeoutError) {
      return scheduleRouteTimeoutResponse(error, "POST");
    }
    throw error;
  }
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasWorkflowScheduleAccess(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let parsed;
  try {
    const body = await withScheduleRouteTimeout("parseRequestBody", request.json());
    parsed = parseCreateWorkflowScheduleRequest(body);
  } catch (error) {
    if (error instanceof ScheduleRouteTimeoutError) {
      return scheduleRouteTimeoutResponse(error, "POST");
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request body" },
      { status: 400 },
    );
  }

  const scheduleId = crypto.randomUUID();
  const webhookSecret = generateScheduleWebhookSecret();
  const callbackUrl = toAbsoluteAppUrl(
    getConfiguredAppOrigin(),
    "/api/v1/workflows/schedules/trigger",
  );
  callbackUrl.searchParams.set(SCHEDULE_TOKEN_QUERY_PARAM, webhookSecret);
  const credentialEncryptionKey = getWorkflowScheduleCredentialEncryptionKey();

  let relaycronApiKey: string | null = null;
  let relaycronScheduleId: string | null = null;
  try {
    relaycronApiKey = await withScheduleRouteTimeout(
      "createRelaycronApiKey",
      createRelaycronApiKey(`cloud-workflow-schedule:${scheduleId}`),
    );
    const relaycronSchedule = await withScheduleRouteTimeout(
      "createRelaycronSchedule",
      createRelaycronSchedule(relaycronApiKey, {
        name: parsed.name,
        description: parsed.description,
        schedule_type: parsed.scheduleType,
        cron_expression: parsed.cronExpression,
        scheduled_at: parsed.scheduledAt,
        timezone: parsed.timezone,
        payload: {
          type: "cloud.workflow_schedule",
          scheduleId,
        },
        transport: {
          type: "webhook",
          url: callbackUrl.toString(),
          headers: {
            "X-Cloud-Workflow-Schedule-Token": webhookSecret,
          },
          timeout_ms: 30000,
        },
        metadata: {
          ...(parsed.scheduleMetadata && typeof parsed.scheduleMetadata === "object"
            ? parsed.scheduleMetadata
            : {}),
          cloudScheduleId: scheduleId,
          workspaceId: auth.workspaceId,
        },
      }),
    );
    relaycronScheduleId = relaycronSchedule.id;

    const schedule = await withScheduleRouteTimeout(
      "createLocalSchedule",
      workflowScheduleStore.create({
        id: scheduleId,
        relaycronScheduleId,
        relaycronApiKeyEnvelope: await encryptJsonAsync(relaycronApiKey, credentialEncryptionKey),
        userId: auth.userId,
        workspaceId: auth.workspaceId,
        organizationId: auth.organizationId,
        name: parsed.name,
        description: parsed.description,
        scheduleType: parsed.scheduleType,
        cronExpression: parsed.cronExpression,
        scheduledAt: parsed.scheduledAtDate,
        timezone: parsed.timezone,
        workflowRequestEnvelope: await encryptJsonAsync(parsed.workflowRequest, credentialEncryptionKey),
        webhookSecretHash: hashScheduleWebhookSecret(webhookSecret),
      }),
    );

    return NextResponse.json({ schedule: toPublicWorkflowSchedule(schedule) }, { status: 201 });
  } catch (error) {
    await deleteRelaycronScheduleBestEffort(relaycronApiKey, relaycronScheduleId);
    if (!relaycronScheduleId) {
      await deleteRelaycronSchedulesByCloudScheduleIdBestEffort(relaycronApiKey, scheduleId);
    }
    if (error instanceof ScheduleRouteTimeoutError) {
      return scheduleRouteTimeoutResponse(error, "POST");
    }
    return relaycronErrorResponse(error);
  }
}
