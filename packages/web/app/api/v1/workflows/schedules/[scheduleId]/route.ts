import { NextRequest, NextResponse } from "next/server";
import {
  deleteRelaycronSchedule,
  updateRelaycronSchedule,
  RelaycronClientError,
} from "@/lib/workflow-schedules/relaycron-client";
import {
  decryptJson,
  encryptJsonAsync,
  extractWorkflowRequest,
} from "@/lib/workflow-schedules/request";
import { getWorkflowScheduleCredentialEncryptionKey } from "@/lib/workflow-schedules/config";
import {
  toPublicWorkflowSchedule,
  workflowScheduleStore,
  type WorkflowScheduleRecord,
} from "@/lib/workflow-schedules/store";
import { requireAuthScope, requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";

type RouteContext = {
  params: Promise<{ scheduleId: string }>;
};

function hasWorkflowScheduleAccess(auth: Awaited<ReturnType<typeof resolveRequestAuth>>): boolean {
  return requireSessionAuth(auth) || requireAuthScope(auth, "cli:auth");
}

async function requireSchedule(
  request: NextRequest,
  scheduleId: string,
): Promise<
  | { auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>; schedule: WorkflowScheduleRecord }
  | NextResponse
> {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!hasWorkflowScheduleAccess(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const schedule = requireSessionAuth(auth)
    ? await workflowScheduleStore.get(scheduleId)
    : await workflowScheduleStore.getForWorkspace(scheduleId, auth.workspaceId);
  if (!schedule) {
    return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
  }
  if (requireSessionAuth(auth)) {
    const organizationWorkspaceIds = new Set(
      auth.context.workspaces
        .filter((workspace) => workspace.organization_id === auth.context.currentOrganization.id)
        .map((workspace) => workspace.id),
    );
    if (!organizationWorkspaceIds.has(schedule.workspaceId)) {
      return NextResponse.json({ error: "Schedule not found" }, { status: 404 });
    }
  }
  return { auth, schedule };
}

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

function parsePatchBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Invalid request body");
  }
  const record = body as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of ["name", "description", "cron_expression", "scheduled_at", "timezone", "status"]) {
    if (record[key] !== undefined) {
      patch[key] = record[key];
    }
  }
  if (patch.status !== undefined && patch.status !== "active" && patch.status !== "paused") {
    throw new Error("status must be active or paused");
  }
  if (typeof patch.scheduled_at === "string" && Number.isNaN(new Date(patch.scheduled_at).getTime())) {
    throw new Error("scheduled_at must be an ISO timestamp");
  }

  let workflowRequest: unknown;
  if (record.workflowRequest !== undefined || record.run !== undefined) {
    workflowRequest = extractWorkflowRequest({
      workflowRequest: record.workflowRequest ?? record.run,
    });
  }

  return { patch, workflowRequest };
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { scheduleId } = await context.params;
  const resolved = await requireSchedule(request, scheduleId);
  if (resolved instanceof NextResponse) {
    return resolved;
  }
  return NextResponse.json({ schedule: toPublicWorkflowSchedule(resolved.schedule) });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { scheduleId } = await context.params;
  const resolved = await requireSchedule(request, scheduleId);
  if (resolved instanceof NextResponse) {
    return resolved;
  }

  let parsed;
  try {
    parsed = parsePatchBody(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid request body" },
      { status: 400 },
    );
  }

  const credentialEncryptionKey = getWorkflowScheduleCredentialEncryptionKey();
  const relaycronApiKey = await decryptJson<string>(
    resolved.schedule.relaycronApiKeyEnvelope,
    credentialEncryptionKey,
  );

  try {
    const relaycronPatch: Parameters<typeof updateRelaycronSchedule>[2] = {};
    if (typeof parsed.patch.name === "string") relaycronPatch.name = parsed.patch.name.trim();
    if (typeof parsed.patch.description === "string") {
      relaycronPatch.description = parsed.patch.description.trim();
    }
    if (typeof parsed.patch.cron_expression === "string") {
      relaycronPatch.cron_expression = parsed.patch.cron_expression.trim();
    }
    if (typeof parsed.patch.scheduled_at === "string") {
      relaycronPatch.scheduled_at = new Date(parsed.patch.scheduled_at).toISOString();
    }
    if (typeof parsed.patch.timezone === "string") relaycronPatch.timezone = parsed.patch.timezone.trim();
    if (parsed.patch.status === "active" || parsed.patch.status === "paused") {
      relaycronPatch.status = parsed.patch.status;
    }

    if (Object.keys(relaycronPatch).length > 0) {
      await updateRelaycronSchedule(
        relaycronApiKey,
        resolved.schedule.relaycronScheduleId,
        relaycronPatch,
      );
    }

    const localPatch: Parameters<typeof workflowScheduleStore.update>[1] = {};
    if (relaycronPatch.name !== undefined) localPatch.name = relaycronPatch.name;
    if (relaycronPatch.description !== undefined) localPatch.description = relaycronPatch.description;
    if (relaycronPatch.cron_expression !== undefined) {
      localPatch.cronExpression = relaycronPatch.cron_expression;
    }
    if (relaycronPatch.scheduled_at !== undefined) {
      localPatch.scheduledAt = new Date(relaycronPatch.scheduled_at);
    }
    if (relaycronPatch.timezone !== undefined) localPatch.timezone = relaycronPatch.timezone;
    if (relaycronPatch.status !== undefined) localPatch.status = relaycronPatch.status;
    if (parsed.workflowRequest !== undefined) {
      localPatch.workflowRequestEnvelope = await encryptJsonAsync(
        parsed.workflowRequest,
        credentialEncryptionKey,
      );
    }

    const schedule = await workflowScheduleStore.update(scheduleId, localPatch);
    return NextResponse.json({ schedule: toPublicWorkflowSchedule(schedule) });
  } catch (error) {
    return relaycronErrorResponse(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { scheduleId } = await context.params;
  const resolved = await requireSchedule(request, scheduleId);
  if (resolved instanceof NextResponse) {
    return resolved;
  }

  const relaycronApiKey = await decryptJson<string>(
    resolved.schedule.relaycronApiKeyEnvelope,
    getWorkflowScheduleCredentialEncryptionKey(),
  );
  try {
    await deleteRelaycronSchedule(relaycronApiKey, resolved.schedule.relaycronScheduleId);
    await workflowScheduleStore.delete(scheduleId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return relaycronErrorResponse(error);
  }
}
