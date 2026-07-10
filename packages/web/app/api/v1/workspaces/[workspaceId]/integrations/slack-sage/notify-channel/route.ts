import { NextRequest, NextResponse } from "next/server";

import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  deleteNotifyChannelPref,
  getNotifyChannelPref,
  putNotifyChannelPref,
  SageInternalApiError,
} from "@/lib/integrations/sage-internal-api";

/**
 * Cloud → sage proxy for the per-workspace proactive notify-channel pref.
 * Auth is the user's existing session (the admin clicking save in the
 * Integrations → Slack UI). The sage-side endpoint authenticates
 * internally with the shared `sageCloudApiToken`. See sage's
 * `src/app/proactive-prefs.ts` for the receiving contracts.
 */

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function resolveWorkspaceAccess(
  request: NextRequest,
  workspaceId: string,
): Promise<NextResponse | null> {
  const auth = await resolveRequestAuth(request);
  if (!requireSessionAuth(auth)) {
    return NextResponse.json(
      { error: { message: "Sign in required" } },
      { status: 401 },
    );
  }
  const hasAccess = auth.context.workspaces.some(
    (workspace) => workspace.id === workspaceId,
  );
  if (!hasAccess) {
    return NextResponse.json(
      { error: { message: "You do not have access to this workspace" } },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Translate sage / network failures into client responses without leaking
 * internal exception text. CodeRabbit review on PR #453: the prior shape
 * forwarded raw error messages to the client for 5xx paths, exposing
 * upstream stack-trace-flavored text. Now: 4xx surfaces sage's
 * user-facing message (it's already client-safe — sage validates input
 * and returns short reasons), 5xx + non-error fallbacks log the detail
 * server-side and return a generic message.
 */
function mapSageError(error: unknown): NextResponse {
  const isSageError = error instanceof SageInternalApiError;
  const status =
    isSageError && error.status >= 400 && error.status < 600 ? error.status : 502;
  const detail = error instanceof Error ? error.message : String(error);

  if (status >= 500) {
    console.warn(
      JSON.stringify({
        event: "sage_internal_proxy_error",
        status,
        detail,
      }),
    );
    return NextResponse.json(
      { error: { message: "Sage call failed" } },
      { status },
    );
  }

  // 4xx: sage's message is the actionable signal (e.g. "workspaceId
  // required"); pass it through.
  return NextResponse.json(
    { error: { message: isSageError ? error.message : detail } },
    { status },
  );
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const { workspaceId } = await ctx.params;
  const denied = await resolveWorkspaceAccess(request, workspaceId);
  if (denied) return denied;

  try {
    const result = await getNotifyChannelPref(workspaceId);
    return NextResponse.json(result);
  } catch (error) {
    return mapSageError(error);
  }
}

export async function PUT(request: NextRequest, ctx: RouteContext) {
  const { workspaceId } = await ctx.params;
  const denied = await resolveWorkspaceAccess(request, workspaceId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { message: "Request body must be valid JSON" } },
      { status: 400 },
    );
  }
  if (!isRecord(body) || typeof body.channelId !== "string" || body.channelId.trim().length === 0) {
    return NextResponse.json(
      { error: { message: "channelId is required (non-empty string)" } },
      { status: 400 },
    );
  }

  try {
    const result = await putNotifyChannelPref(workspaceId, body.channelId.trim());
    return NextResponse.json(result);
  } catch (error) {
    return mapSageError(error);
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const { workspaceId } = await ctx.params;
  const denied = await resolveWorkspaceAccess(request, workspaceId);
  if (denied) return denied;

  try {
    const result = await deleteNotifyChannelPref(workspaceId);
    return NextResponse.json(result);
  } catch (error) {
    return mapSageError(error);
  }
}
