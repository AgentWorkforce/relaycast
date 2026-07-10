import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import type { RequestAuth } from "@/lib/auth/request-auth";
import type { AuthContext, AuthWorkspace } from "@/lib/auth/types";
import { requireOrgOwner } from "@/lib/invites/invite-store";
import { buildFleetEnrollCommand, mintNodeEnrollmentToken } from "@/lib/fleet/nodes";
import { toAbsoluteAppUrl } from "@/lib/app-path";
import { consumeRateLimit } from "@/lib/workers/rate-limit";

type SessionRequestAuth = RequestAuth & { source: "session"; context: AuthContext };

type EnrollmentBody = {
  workspaceId: string;
  name?: string;
  capabilities?: string[];
  maxAgents?: number;
  tags?: string[];
};

function findWorkspace(auth: SessionRequestAuth, workspaceId: string): AuthWorkspace | null {
  return auth.context.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
}

async function requireWorkspaceOwnerOrAdmin(
  auth: SessionRequestAuth,
  workspaceId: string,
): Promise<{ ok: true; workspace: AuthWorkspace } | { ok: false; response: NextResponse }> {
  const workspace = findWorkspace(auth, workspaceId);
  if (!workspace) {
    return { ok: false, response: NextResponse.json({ error: "Workspace not found" }, { status: 404 }) };
  }
  const isOwner = await requireOrgOwner(workspace.organization_id, auth.userId);
  if (!isOwner) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { ok: true, workspace };
}

function normalizeStringList(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) return null;
  return [...new Set(value.map((entry) => entry.trim()).filter(Boolean))];
}

function normalizeBody(payload: unknown): EnrollmentBody | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Partial<EnrollmentBody>;
  if (typeof body.workspaceId !== "string" || !body.workspaceId.trim()) return null;
  const name = body.name === undefined ? undefined : typeof body.name === "string" ? body.name.trim() : null;
  if (name === null || (name !== undefined && name.length > 128)) return null;
  const capabilities = normalizeStringList(body.capabilities);
  const tags = normalizeStringList(body.tags);
  if (capabilities === null || tags === null) return null;
  const maxAgents = body.maxAgents === undefined
    ? undefined
    : typeof body.maxAgents === "number" && Number.isInteger(body.maxAgents) && body.maxAgents >= 0
      ? body.maxAgents
      : null;
  if (maxAgents === null) return null;
  return {
    workspaceId: body.workspaceId.trim(),
    ...(name ? { name } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(maxAgents !== undefined ? { maxAgents } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!requireSessionAuth(auth)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const rateLimit = consumeRateLimit(`node-enrollment:${auth.userId}`, 20, 60 * 60 * 1000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Retry-After": `${Math.ceil(rateLimit.retryAfterMs / 1000)}` } },
    );
  }

  let body: EnrollmentBody | null;
  try {
    body = normalizeBody(await request.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (!body) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

  const access = await requireWorkspaceOwnerOrAdmin(auth, body.workspaceId);
  if (!access.ok) return access.response;

  try {
    const createdAt = new Date();
    const { plaintext, expiresAt, relayWorkspaceId } = await mintNodeEnrollmentToken({
      workspaceId: access.workspace.id,
      workspaceName: access.workspace.name,
      userId: auth.userId,
      defaults: {
        name: body.name,
        capabilities: body.capabilities,
        maxAgents: body.maxAgents,
        tags: body.tags,
      },
    });
    // The cloud app is served under a base path (basePath="/cloud" in
    // next.config). `request.nextUrl.origin` is only protocol+host, so a bare
    // `/api/v1/fleet/register` would 404 — the registered route lives under the
    // base path. Use the same base-path resolver the rest of the app uses so
    // the minted URL is correct in prod (/cloud) and in any preview/local env.
    const enrollmentUrl = toAbsoluteAppUrl(request.nextUrl.origin, "/api/v1/fleet/register").toString();
    return NextResponse.json(
      {
        token: plaintext,
        expiresAt: expiresAt.toISOString(),
        createdAt: createdAt.toISOString(),
        relayWorkspaceId,
        enrollmentUrl,
        enrollCommand: buildFleetEnrollCommand({
          enrollmentToken: plaintext,
          enrollmentUrl,
          name: body.name,
        }),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Node enrollment token mint failed:", error instanceof Error ? error.message : String(error));
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
