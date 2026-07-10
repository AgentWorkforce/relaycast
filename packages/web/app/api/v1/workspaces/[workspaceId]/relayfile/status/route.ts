import { mintScopedRelayfileToken } from "@cloud/core/relayfile/client.js";
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import {
  canLaunchRelayfileObserver,
  RELAYFILE_OBSERVER_AGENT_NAME,
  RELAYFILE_OBSERVER_TOKEN_TTL_SECONDS,
} from "@/lib/relayfile-observer";

const STATUS_SCOPES = ["sync:read"] as const;

type RelayfileStatusRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(
  request: NextRequest,
  { params }: RelayfileStatusRouteContext,
) {
  const { workspaceId } = await params;
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!canLaunchRelayfileObserver(auth, workspaceId)) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  let relayfileUrl: string;
  let relayAuthUrl: string;
  let relayAuthApiKey: string;
  try {
    ({ relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig());
  } catch (error) {
    console.error(
      "Relayfile status config resolution failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Relayfile is not configured" },
      { status: 500 },
    );
  }
  if (!relayAuthApiKey) {
    return NextResponse.json(
      { error: "Relayfile is not configured" },
      { status: 500 },
    );
  }

  let token: string;
  try {
    token = await mintScopedRelayfileToken({
      workspaceId,
      agentName: RELAYFILE_OBSERVER_AGENT_NAME,
      scopes: [...STATUS_SCOPES],
      relayAuthUrl,
      relayAuthApiKey,
      ttlSeconds: RELAYFILE_OBSERVER_TOKEN_TTL_SECONDS,
    });
  } catch (error) {
    console.error(
      "Relayfile status token mint failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to mint relayfile token" },
      { status: 502 },
    );
  }

  const statusUrl = new URL(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}/sync/status`,
    relayfileUrl,
  );
  // relayfile's /sync/* routes are wrapped in requireCorrelationId() and 400
  // ("missing X-Correlation-Id header") without it. Propagate the inbound id
  // for trace continuity, otherwise mint one.
  const correlationId =
    request.headers.get("x-correlation-id")?.trim() || crypto.randomUUID();
  const response = await globalThis.fetch(statusUrl.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Correlation-Id": correlationId,
    },
  });

  if (!response.ok) {
    // Map upstream auth errors to 502 so the browser doesn't confuse a
    // relayfile-side 401/403 with the user's cloud session expiring.
    const upstreamStatus = response.status === 401 || response.status === 403 ? 502 : response.status;
    const body = await response.text().catch(() => "");
    return NextResponse.json(
      { error: "Relayfile status fetch failed", detail: body },
      { status: upstreamStatus },
    );
  }

  const data = await response.json();
  return NextResponse.json(data);
}
