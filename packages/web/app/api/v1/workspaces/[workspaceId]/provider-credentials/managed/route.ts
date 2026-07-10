import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import {
  displayNameForModelProvider,
  harnessForModelProvider,
  normalizeModelProvider,
  resolveHouseKey,
} from "@/lib/billing/house-keys";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

function canWriteCredential(auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:write")
  );
}

async function parseProvider(request: NextRequest): Promise<string | null> {
  const fromQuery = request.nextUrl.searchParams.get("provider");
  if (fromQuery) {
    return normalizeModelProvider(fromQuery);
  }

  if (request.method === "POST") {
    const body = await request.json().catch(() => null) as { provider?: unknown; modelProvider?: unknown } | null;
    const raw = typeof body?.modelProvider === "string"
      ? body.modelProvider
      : typeof body?.provider === "string"
      ? body.provider
      : "";
    return normalizeModelProvider(raw);
  }

  return null;
}

async function getOrCreateManagedCredential(input: {
  userId: string;
  organizationId: string;
  workspaceId: string;
  modelProvider: string;
}): Promise<{ id: string; created: boolean }> {
  const db = getDb();
  const now = new Date();
  const id = crypto.randomUUID();
  const [insertedRow] = await db
    .insert(providerCredentials)
    .values({
      id,
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      harness: harnessForModelProvider(input.modelProvider),
      modelProvider: input.modelProvider,
      authType: "relay_managed",
      displayName: `${displayNameForModelProvider(input.modelProvider)} managed`,
      status: "connected",
      credentialStoredAt: null,
      lastAuthenticatedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: providerCredentials.id });
  if (insertedRow) {
    return { id: insertedRow.id, created: true };
  }

  const [existing] = await getDb()
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, input.userId),
        eq(providerCredentials.workspaceId, input.workspaceId),
        eq(providerCredentials.modelProvider, input.modelProvider),
        eq(providerCredentials.authType, "relay_managed"),
        isNull(providerCredentials.label),
      ),
    )
    .limit(1);
  if (existing) {
    return { id: existing.id, created: false };
  }

  throw new Error("Failed to create relay-managed provider credential");
}

function logManagedCredentialError(error: unknown, context: {
  workspaceId: string;
  modelProvider: string;
}) {
  console.error("[provider-credentials/managed] Failed to create managed provider credential", {
    area: "provider-credentials",
    route: "/api/v1/workspaces/[workspaceId]/provider-credentials/managed",
    workspaceId: context.workspaceId,
    modelProvider: context.modelProvider,
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : String(error),
    errorStack: error instanceof Error ? error.stack : undefined,
  });
}

async function handle(request: NextRequest, context: RouteContext) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canWriteCredential(auth)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { workspaceId } = await context.params;
  if (!hasWorkspaceAccess(auth, workspaceId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const modelProvider = await parseProvider(request);
  if (!modelProvider) {
    return NextResponse.json({ error: "provider is required" }, { status: 400 });
  }
  if (!resolveHouseKey(modelProvider)) {
    return NextResponse.json(
      { error: `Managed ${modelProvider} credentials are not configured`, code: "house_key_missing" },
      { status: 503 },
    );
  }

  try {
    const result = await getOrCreateManagedCredential({
      userId: auth.userId,
      organizationId: auth.organizationId,
      workspaceId,
      modelProvider,
    });
    return NextResponse.json(
      { providerCredentialId: result.id, id: result.id },
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    logManagedCredentialError(error, { workspaceId, modelProvider });
    return NextResponse.json(
      {
        error: "Failed to create managed provider credential",
        code: "managed_credential_create_failed",
      },
      { status: 500 },
    );
  }
}

export const GET = handle;
export const POST = handle;
