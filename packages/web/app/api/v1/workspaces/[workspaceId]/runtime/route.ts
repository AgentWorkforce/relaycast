import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import type { RequestAuth } from "@/lib/auth/request-auth";
import type { AuthContext, AuthWorkspace } from "@/lib/auth/types";
import { getDb } from "@/lib/db/index";
import { workers, workspaces } from "@/lib/db/schema";
import { requireOrgOwner } from "@/lib/invites/invite-store";

type RuntimeRouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type SessionRequestAuth = RequestAuth & { source: "session"; context: AuthContext };

type RuntimeDescriptor =
  | { id: "daytona" }
  | { id: "worker"; config: { workerId: string } };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findWorkspace(auth: SessionRequestAuth, workspaceId: string): AuthWorkspace | null {
  return auth.context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

function hasWorkspaceAccess(auth: RequestAuth, workspaceId: string): boolean {
  if (auth.source === "session") {
    return auth.context?.workspaces.some((workspace) => workspace.id === workspaceId) ?? false;
  }

  return auth.workspaceId === workspaceId;
}

async function requireWorkspaceOwnerOrAdmin(
  auth: SessionRequestAuth,
  workspaceId: string,
): Promise<{ ok: true; workspace: AuthWorkspace } | { ok: false; response: NextResponse }> {
  const workspace = findWorkspace(auth, workspaceId);
  if (!workspace) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Workspace not found" }, { status: 404 }),
    };
  }

  // TODO: Accept workspace-level admin roles here once the app has them.
  const isOwner = await requireOrgOwner(workspace.organization_id, auth.userId);
  if (!isOwner) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }

  return { ok: true, workspace };
}

function normalizeRuntimeDescriptor(value: unknown): RuntimeDescriptor | null {
  if (!isRecord(value) || typeof value.id !== "string") {
    return null;
  }

  if (value.id === "daytona") {
    return { id: "daytona" };
  }

  if (value.id !== "worker" || !isRecord(value.config)) {
    return null;
  }

  const workerId = value.config.workerId;
  if (typeof workerId !== "string" || !UUID_PATTERN.test(workerId)) {
    return null;
  }

  return { id: "worker", config: { workerId } };
}

async function readRuntimeDescriptor(request: NextRequest): Promise<RuntimeDescriptor | null> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return null;
  }

  const descriptor =
    isRecord(payload) && "runtime" in payload ? payload.runtime : payload;

  return normalizeRuntimeDescriptor(descriptor);
}

export async function GET(request: NextRequest, { params }: RuntimeRouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { workspaceId } = await params;
  if (!UUID_PATTERN.test(workspaceId)) {
    return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
  }
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const [row] = await getDb()
      .select({ defaultRuntime: workspaces.defaultRuntime })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    return NextResponse.json(row.defaultRuntime ?? { id: "daytona" });
  } catch (error) {
    console.error(
      "Workspace runtime lookup failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, { params }: RuntimeRouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId } = await params;
  const access = await requireWorkspaceOwnerOrAdmin(auth, workspaceId);
  if (!access.ok) {
    return access.response;
  }

  const runtime = await readRuntimeDescriptor(request);
  if (!runtime) {
    return NextResponse.json({ error: "Invalid runtime" }, { status: 400 });
  }

  const db = getDb();

  try {
    if (runtime.id === "worker") {
      const [worker] = await db
        .select({ id: workers.id, status: workers.status })
        .from(workers)
        .where(
          and(
            eq(workers.id, runtime.config.workerId),
            eq(workers.workspaceId, access.workspace.id),
          ),
        )
        .limit(1);

      if (!worker) {
        return NextResponse.json({ error: "Worker not found" }, { status: 404 });
      }

      if (worker.status === "revoked") {
        return NextResponse.json({ error: "Worker is revoked" }, { status: 409 });
      }
    }

    const normalizedRuntime = runtime.id === "daytona" ? null : runtime;
    const [updated] = await db
      .update(workspaces)
      .set({
        defaultRuntime: normalizedRuntime,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.id, access.workspace.id))
      .returning({ id: workspaces.id });

    if (!updated) {
      return NextResponse.json({ error: "Workspace not found" }, { status: 404 });
    }

    return NextResponse.json(runtime);
  } catch (error) {
    console.error(
      "Workspace runtime update failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
