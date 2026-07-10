import { NextRequest, NextResponse } from "next/server";
import { mintRelayfileToken } from "@cloud/core/relayfile/client.js";
import {
  canAccessWorkflowRun,
  requireAuthRunAccess,
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import { isValidWorkspaceId } from "@/lib/relay-workspaces";
import { workflowStore } from "@/lib/workflows";

type ExportContext = {
  params: Promise<{ runId: string }>;
};

export async function GET(request: NextRequest, { params }: ExportContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "workflow:runs:read")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    return NextResponse.json({ error: "Relayfile export is not configured" }, { status: 500 });
  }

  const { runId } = await params;
  if (!runId || !requireAuthRunAccess(auth, runId)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const run = await workflowStore.get(runId);
  if (!run || !canAccessWorkflowRun(auth, run)) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const workspaceId = run.relayWorkspaceId?.trim() ?? "";
  if (!isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "Workflow workspace unavailable" }, { status: 409 });
  }
  const upstreamUrl = new URL(
    `${relayfileUrl.replace(/\/$/, '')}/v1/workspaces/${encodeURIComponent(workspaceId)}/fs/export`,
  );
  const format = request.nextUrl.searchParams.get("format");
  if (format) {
    upstreamUrl.searchParams.set("format", format);
  }

  try {
    const upstream = await fetch(upstreamUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await mintRelayfileToken({
          workspaceId,
          relayAuthUrl,
          relayAuthApiKey,
          scopes: ["fs:read"],
        })}`,
      },
      cache: "no-store",
    });

    // Filter headers — only forward safe ones, not internal server headers
    const safeHeaders = new Headers();
    const ALLOWED_HEADERS = ['content-type', 'content-length', 'content-disposition', 'etag', 'last-modified', 'cache-control'];
    for (const key of ALLOWED_HEADERS) {
      const val = upstream.headers.get(key);
      if (val) safeHeaders.set(key, val);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: safeHeaders,
    });
  } catch (error) {
    console.error("Workflow export proxy failed:", error);
    return NextResponse.json({ error: "Failed to export workflow workspace" }, { status: 502 });
  }
}
