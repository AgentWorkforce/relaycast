import { NextRequest, NextResponse } from "next/server";
import { mintRelayfileToken } from "@cloud/core/relayfile/client.js";
import { RelayFileApiError, RelayFileClient } from "@relayfile/sdk";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  CLOUD_OPS_REPLAY_SCOPE,
  hasCloudControlScope,
  hasWorkspaceAccess,
} from "@/lib/integrations/integration-route-handler";
import { resolveRelayfileConfig } from "@/lib/relayfile";

const REPLAY_AGENT_NAME = "cloud-ops-replay";

type RouteContext = {
  params: Promise<{ workspaceId: string; opId: string }>;
};

type ErrorResponse = { error: string };

export async function POST(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  const { workspaceId, opId } = await context.params;

  if (!auth) {
    return NextResponse.json<ErrorResponse>({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json<ErrorResponse>({ error: "Forbidden" }, { status: 403 });
  }
  if (!hasCloudControlScope(auth, CLOUD_OPS_REPLAY_SCOPE)) {
    return NextResponse.json<ErrorResponse>({ error: "Forbidden" }, { status: 403 });
  }

  if (!opId.trim()) {
    return NextResponse.json<ErrorResponse>(
      { error: "opId is required" },
      { status: 400 },
    );
  }

  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    return NextResponse.json<ErrorResponse>(
      { error: "Relayfile is not configured" },
      { status: 503 },
    );
  }

  const correlationId =
    request.headers.get("x-correlation-id")?.trim() ||
    `cloud-ops-replay:${workspaceId}:${opId}`;

  try {
    const client = new RelayFileClient({
      baseUrl: relayfileUrl,
      token: () =>
        mintRelayfileToken({
          workspaceId,
          relayAuthUrl,
          relayAuthApiKey,
          agentName: REPLAY_AGENT_NAME,
        }),
    });
    const queued = await client.replayOp(workspaceId, opId, correlationId);
    return NextResponse.json(queued);
  } catch (error) {
    if (error instanceof RelayFileApiError) {
      const status = error.status === 404 ? 404 : error.status >= 400 && error.status < 600 ? error.status : 502;
      return NextResponse.json<ErrorResponse>(
        { error: error.message || "Replay failed" },
        { status },
      );
    }
    console.error("Workspace op replay failed:", error);
    return NextResponse.json<ErrorResponse>(
      { error: "Failed to replay op" },
      { status: 500 },
    );
  }
}
