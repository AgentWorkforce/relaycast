import { NextRequest, NextResponse } from "next/server";
import { resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  hasRelayhistoryLoginScope,
  resolveRelayhistoryWorkspaceAccess,
} from "@/lib/relayhistory-access";
import { fetchRelayhistoryReflex } from "@/lib/relayhistory-reflex";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const REFLEX_PATTERNS_PATH = "/v1/reflex/patterns";
const FORWARDED_QUERY_PARAMS = ["scope", "kind", "limit", "since"] as const;

function buildUpstreamPath(request: NextRequest): string {
  const params = new URLSearchParams();
  for (const name of FORWARDED_QUERY_PARAMS) {
    for (const value of request.nextUrl.searchParams.getAll(name)) {
      params.append(name, value);
    }
  }

  const query = params.toString();
  return query ? `${REFLEX_PATTERNS_PATH}?${query}` : REFLEX_PATTERNS_PATH;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (
    auth.source === "relayfile" ||
    auth.source === "service" ||
    !hasRelayhistoryLoginScope(auth)
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId } = await context.params;
  const workspaceAccess = await resolveRelayhistoryWorkspaceAccess(workspaceId, auth);
  if (!workspaceAccess) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const response = await fetchRelayhistoryReflex(buildUpstreamPath(request), {
      userId: auth.userId,
      orgId: workspaceAccess.orgId,
      workspaceId,
      mode: "read",
    });

    if (!response.ok) {
      console.error("[reflex-patterns] upstream request failed:", response.status);
      return NextResponse.json(
        { error: "Failed to load Reflex patterns" },
        { status: 502 },
      );
    }

    return NextResponse.json(await response.json(), { status: response.status });
  } catch (error) {
    console.error(
      "[reflex-patterns] request failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to load Reflex patterns" },
      { status: 502 },
    );
  }
}
