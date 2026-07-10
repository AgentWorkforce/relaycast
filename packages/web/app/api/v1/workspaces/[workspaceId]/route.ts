import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { isValidWorkspaceId } from "@/lib/relay-workspaces";
import { deleteWorkspaceCascade } from "@/lib/workspace-deletion";
import {
  createCloudWorkspaceRegistry,
  formatWorkspaceResponse,
  hasWorkspaceOwnerAccess,
} from "@/lib/workspace-registry";

type WorkspaceRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export async function GET(
  request: NextRequest,
  { params }: WorkspaceRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId } = await params;
  if (!workspaceId || !isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  try {
    const { registry, serviceConfig } = createCloudWorkspaceRegistry();
    const workspace = await registry.get(workspaceId);
    if (!workspace || !hasWorkspaceOwnerAccess(workspace, auth.userId)) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    return NextResponse.json(
      formatWorkspaceResponse(workspace, serviceConfig, { includePermissions: true }),
    );
  } catch (error) {
    console.error("Workspace lookup failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "Failed to get workspace" }, { status: 500 });
  }
}

/**
 * `DELETE /api/v1/workspaces/:workspaceId` — hard-delete a workspace and
 * ALL its server-side state via {@link deleteWorkspaceCascade}.
 *
 * Auth mirrors GET: session auth or a `cli:auth` token, and the caller
 * must own the workspace (non-owners get 404 so existence is not leaked).
 * Safety: requires a JSON body `{ "confirm": "<workspaceId>" }`; a
 * mismatched/absent confirm => 400. Unknown/already-deleted => 404.
 *
 * @returns `200 { deleted: true, summary }` on success; 400/401/403/404
 *   per the rules above; 500 if the cascade rethrows.
 */
export async function DELETE(
  request: NextRequest,
  { params }: WorkspaceRouteContext,
) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId } = await params;
  if (!workspaceId || !isValidWorkspaceId(workspaceId)) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }

  let confirm: unknown;
  try {
    const raw = await request.text();
    confirm = raw.trim() ? (JSON.parse(raw) as { confirm?: unknown }).confirm : undefined;
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (confirm !== workspaceId) {
    return NextResponse.json(
      {
        error:
          "Confirmation required: send a JSON body { \"confirm\": \"<workspaceId>\" } matching the workspace being deleted.",
      },
      { status: 400 },
    );
  }

  try {
    const { registry } = createCloudWorkspaceRegistry();
    const workspace = await registry.get(workspaceId);
    if (!workspace || !hasWorkspaceOwnerAccess(workspace, auth.userId)) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    const summary = await deleteWorkspaceCascade(workspaceId);

    return NextResponse.json({ deleted: true, summary }, { status: 200 });
  } catch (error) {
    console.error(
      "Workspace deletion failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json(
      { error: "Failed to delete workspace" },
      { status: 500 },
    );
  }
}
