import { NextRequest, NextResponse } from "next/server";

import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  listSageBotChannels,
  SageInternalApiError,
} from "@/lib/integrations/sage-internal-api";

/**
 * Cloud → sage proxy for "channels the sage bot is a member of".
 * Powers the dropdown in the Integrations → Slack notify-channel
 * picker. Mirrors the same `listBotChannels` filter that sage's own
 * `pickChannel` and fallback chain consider, so the UI choices match
 * what would actually receive a proactive post.
 */

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(request: NextRequest, ctx: RouteContext) {
  const { workspaceId } = await ctx.params;
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

  try {
    const result = await listSageBotChannels(workspaceId);
    return NextResponse.json(result);
  } catch (error) {
    // CodeRabbit review on PR #453: don't leak raw exception messages on
    // 5xx. 4xx → pass through (sage's message is the actionable signal);
    // 5xx + non-error fallbacks → log detail server-side, return generic.
    const isSageError = error instanceof SageInternalApiError;
    const status =
      isSageError && error.status >= 400 && error.status < 600 ? error.status : 502;
    const detail = error instanceof Error ? error.message : String(error);

    if (status >= 500) {
      console.warn(
        JSON.stringify({
          event: "sage_internal_proxy_error",
          path: "bot-channels",
          status,
          detail,
        }),
      );
      return NextResponse.json(
        { error: { message: "Sage call failed" } },
        { status },
      );
    }

    return NextResponse.json(
      { error: { message: isSageError ? error.message : detail } },
      { status },
    );
  }
}
