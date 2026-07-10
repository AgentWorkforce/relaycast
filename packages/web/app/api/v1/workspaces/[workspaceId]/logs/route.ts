import { NextRequest, NextResponse } from "next/server";
import { RelayFileClient } from "@relayfile/sdk";
import { sql } from "drizzle-orm";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import { resolveWorkspaceRelayAccess } from "@/lib/proactive-runtime/dashboard";
import { resolveRelayfileConfig } from "@/lib/relayfile";
import {
  hasWorkspaceIntegrationAccess,
  resolveWorkspaceIntegrationIdentity,
} from "@/lib/workspaces/workspace-integration-identity";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type RawRows<T> = { rows?: T[] };

type DeploymentRunLogRow = {
  id: string;
  deployment_id: string;
  event_source: string;
  stdout: string | null;
  stderr: string | null;
  mount_log_tail: string | null;
  started_at: Date | string;
  ended_at: Date | string | null;
  status: string;
  error: string | null;
};

function workspaceLogRoot(relayWorkspaceId: string): string {
  return `/_logs/${encodeURIComponent(relayWorkspaceId)}`;
}

function isWorkspaceLogPath(path: string, relayWorkspaceId: string): boolean {
  const root = workspaceLogRoot(relayWorkspaceId);
  if (!path.startsWith(`${root}/`)) {
    return false;
  }

  return path
    .split("/")
    .every((segment) => segment !== "." && segment !== "..");
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as RawRows<T>;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function addTextEntries(input: {
  entries: Array<Record<string, unknown>>;
  agentId: string;
  run: DeploymentRunLogRow;
  stream: "stdout" | "stderr" | "mount";
  text: string | null;
}): void {
  if (!input.text?.trim()) {
    return;
  }
  for (const line of input.text.split("\n")) {
    if (!line.trim()) continue;
    input.entries.push({
      agentId: input.agentId,
      runId: input.run.id,
      deploymentId: input.run.deployment_id,
      eventSource: input.run.event_source,
      stream: input.stream,
      status: input.run.status,
      ts: toIso(input.run.ended_at) ?? toIso(input.run.started_at),
      msg: line,
    });
  }
}

async function readAgentDeploymentRunLogEntries(input: {
  workspaceId: string;
  agentId: string;
}): Promise<Array<Record<string, unknown>>> {
  const result = await getDb().execute(sql`
    SELECT
      adr.id,
      adr.deployment_id,
      adr.event_source,
      adr.stdout,
      adr.stderr,
      adr.mount_log_tail,
      adr.started_at,
      adr.ended_at,
      adr.status,
      adr.error
    FROM agent_deployment_runs adr
    INNER JOIN agents a ON a.id = adr.agent_id
    WHERE adr.agent_id = ${input.agentId}
      AND a.workspace_id = ${input.workspaceId}
      AND a.status != 'destroyed'
    ORDER BY adr.started_at DESC
    LIMIT 25
  `);
  const entries: Array<Record<string, unknown>> = [];
  for (const run of rowsOf<DeploymentRunLogRow>(result)) {
    entries.push({
      agentId: input.agentId,
      runId: run.id,
      deploymentId: run.deployment_id,
      eventSource: run.event_source,
      stream: "system",
      status: run.status,
      ts: toIso(run.started_at),
      msg: run.error ?? `deployment run ${run.status}`,
    });
    addTextEntries({ entries, agentId: input.agentId, run, stream: "stdout", text: run.stdout });
    addTextEntries({ entries, agentId: input.agentId, run, stream: "stderr", text: run.stderr });
    addTextEntries({ entries, agentId: input.agentId, run, stream: "mount", text: run.mount_log_tail });
  }
  return entries;
}

export async function GET(request: NextRequest, { params }: RouteContext) {
  const { workspaceId } = await params;
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // Reconcile the app workspace UUID and the bound `rw_*` relay id before the
  // access check (matching the deployments routes). A cli / follow-user token's
  // resolved workspaceId is the app UUID; without this reconciliation, a caller
  // addressing logs by the relay id (or vice versa) fails hasWorkspaceAccess and
  // gets a spurious 404 even though it has access to the workspace.
  let identity: Awaited<ReturnType<typeof resolveWorkspaceIntegrationIdentity>>;
  try {
    identity = await resolveWorkspaceIntegrationIdentity(workspaceId);
  } catch {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (!hasWorkspaceIntegrationAccess(auth, identity)) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (
    !requireSessionAuth(auth) &&
    !requireAuthScope(auth, "workflow:logs:read") &&
    !requireAuthScope(auth, "deployments:read")
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const appWorkspaceId = identity.appWorkspaceId ?? identity.requestedWorkspaceId;

  try {
    const access = await resolveWorkspaceRelayAccess({
      userId: auth.userId,
      workspaceId: appWorkspaceId,
      agentName: "cloud-dashboard-logs",
      requestedScopes: ["relayfile:fs:read:*"],
    });
    const path = request.nextUrl.searchParams.get("path")?.trim();
    const agentId = request.nextUrl.searchParams.get("agentId")?.trim();

    if (path && !isWorkspaceLogPath(path, access.relayWorkspaceId)) {
      return NextResponse.json({ error: "Invalid log path" }, { status: 400 });
    }

    const { relayfileUrl } = resolveRelayfileConfig();
    const client = new RelayFileClient({
      baseUrl: relayfileUrl,
      token: access.token,
    });

    if (path) {
      const file = await client.readFile(access.relayWorkspaceId, path);
      const entries = file.content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as Record<string, unknown>;
          } catch {
            return { msg: line };
          }
        })
        .filter((entry) => !agentId || entry.agentId === agentId);

      return NextResponse.json({
        ok: true,
        data: {
          workspace: access.relayWorkspaceId,
          path,
          entries,
        },
      });
    }

    const listing = await client.queryFiles(access.relayWorkspaceId, {
      path: workspaceLogRoot(access.relayWorkspaceId),
      limit: 100,
    });
    if (agentId && listing.items.length === 0) {
      const entries = await readAgentDeploymentRunLogEntries({ workspaceId: appWorkspaceId, agentId });
      return NextResponse.json({
        ok: true,
        data: {
          workspace: access.relayWorkspaceId,
          items: [],
          entries,
          source: "agent_deployment_runs",
          nextCursor: null,
        },
      });
    }
    return NextResponse.json({
      ok: true,
      data: {
        workspace: access.relayWorkspaceId,
        items: listing.items,
        nextCursor: listing.nextCursor,
      },
    });
  } catch (error) {
    console.error("Workspace logs proxy failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Workspace logs unavailable" }, { status: 503 });
  }
}
