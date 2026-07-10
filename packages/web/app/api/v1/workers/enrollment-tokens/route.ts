import { NextRequest, NextResponse } from "next/server";
import { requireSessionAuth, resolveRequestAuth } from "@/lib/auth/request-auth";
import type { RequestAuth } from "@/lib/auth/request-auth";
import type { AuthContext, AuthWorkspace } from "@/lib/auth/types";
import { getDb } from "@/lib/db/index";
import { requireOrgOwner } from "@/lib/invites/invite-store";
import { buildRegisterCommand, buildStartCommand } from "@/lib/workers/onboarding";
import { consumeRateLimit } from "@/lib/workers/rate-limit";
import { mintEnrollmentToken } from "@/lib/workers/tokens";

type SessionRequestAuth = RequestAuth & { source: "session"; context: AuthContext };

type EnrollmentTokenBody = {
  workspaceId: string;
  name?: string;
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

function normalizeTags(value: unknown): string[] | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value) || !value.every((tag) => typeof tag === "string")) {
    return null;
  }

  return [
    ...new Set(
      value
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0),
    ),
  ];
}

function normalizeEnrollmentTokenBody(payload: unknown): EnrollmentTokenBody | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }

  const body = payload as Partial<EnrollmentTokenBody>;
  if (typeof body.workspaceId !== "string" || body.workspaceId.trim().length === 0) {
    return null;
  }

  const name =
    body.name === undefined
      ? undefined
      : typeof body.name === "string"
      ? body.name.trim()
      : null;

  if (name === null || (name !== undefined && name.length > 128)) {
    return null;
  }

  const tags = normalizeTags(body.tags);
  if (tags === null) {
    return null;
  }

  return {
    workspaceId: body.workspaceId.trim(),
    ...(name ? { name } : {}),
    ...(tags !== undefined ? { tags } : {}),
  };
}

async function readRequestBody(request: NextRequest): Promise<EnrollmentTokenBody | null> {
  const rawBody = await request.text();
  if (!rawBody.trim()) {
    return null;
  }

  const parsed = JSON.parse(rawBody) as unknown;
  return normalizeEnrollmentTokenBody(parsed);
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireSessionAuth(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const rateLimit = consumeRateLimit(`worker-enrollment:${auth.userId}`, 20, 60 * 60 * 1000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": `${Math.ceil(rateLimit.retryAfterMs / 1000)}`,
        },
      },
    );
  }

  let body: EnrollmentTokenBody | null;
  try {
    body = await readRequestBody(request);
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!body) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const access = await requireWorkspaceOwnerOrAdmin(auth, body.workspaceId);
  if (!access.ok) {
    return access.response;
  }

  try {
    const createdAt = new Date();
    const { plaintext, expiresAt } = await mintEnrollmentToken(getDb(), {
      workspaceId: access.workspace.id,
      userId: auth.userId,
    });

    return NextResponse.json(
      {
        token: plaintext,
        expiresAt: expiresAt.toISOString(),
        createdAt: createdAt.toISOString(),
        registerCommand: buildRegisterCommand({
          workspaceId: access.workspace.id,
          token: plaintext,
          name: body.name,
          tags: body.tags,
        }),
        startCommand: buildStartCommand({ daemon: true }),
      },
      {
        headers: {
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    console.error(
      "Worker enrollment token mint failed:",
      error instanceof Error ? error.message : String(error),
    );
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
