import { mintScopedRelayfileToken } from "@cloud/core/relayfile/client.js";
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  buildRelayfileObserverLaunchHtml,
  buildRelayfileObserverLaunchUrl,
  canLaunchRelayfileObserver,
  RELAYFILE_OBSERVER_AGENT_NAME,
  RELAYFILE_OBSERVER_SCOPES,
  RELAYFILE_OBSERVER_TOKEN_TTL_SECONDS,
  resolveRelayfileObserverPublicOrigin,
} from "@/lib/relayfile-observer";
import { resolveRelayfileConfig } from "@/lib/relayfile";

type RelayfileObserverRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(
  request: NextRequest,
  { params }: RelayfileObserverRouteContext,
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

  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    return NextResponse.json(
      { error: "RelayFile observer is not configured" },
      { status: 500 },
    );
  }

  const token = await mintScopedRelayfileToken({
    workspaceId,
    agentName: RELAYFILE_OBSERVER_AGENT_NAME,
    scopes: [...RELAYFILE_OBSERVER_SCOPES],
    relayAuthUrl,
    relayAuthApiKey,
    ttlSeconds: RELAYFILE_OBSERVER_TOKEN_TTL_SECONDS,
  });
  const requestUrl = new URL(request.url);
  const publicOrigin = resolveRelayfileObserverPublicOrigin(request.headers, requestUrl.origin);
  const launchUrl = buildRelayfileObserverLaunchUrl(publicOrigin, {
    baseUrl: relayfileUrl,
    token,
    workspaceId,
  });

  return new Response(buildRelayfileObserverLaunchHtml(launchUrl), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}
