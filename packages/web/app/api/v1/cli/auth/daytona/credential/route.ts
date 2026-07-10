import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import {
  CredentialStore,
  type DaytonaCredential,
} from "@cloud/core/auth/credential-store.js";
import { parseCredentialExpiry } from "@cloud/core/auth/credential-expiry.js";
import { createCredentialStoreS3Client } from "@/lib/storage";
import { requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  displayNameForModelProvider,
  harnessForModelProvider,
} from "@/lib/billing/house-keys";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { ensureActiveProviderCredential } from "@/lib/integrations/provider-credential-activation";
import { optionalEnv, tryResourceValue } from "@/lib/env";

const DAYTONA_PROVIDER = "daytona";

type DaytonaCredentialUploadBody = {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  orgId?: unknown;
};

function resolveWorkflowStorageBucket(): string {
  try {
    const bucket = Resource.WorkflowStorage.bucketName?.trim();
    if (bucket) {
      return bucket;
    }
  } catch {
    // local dev/test fallback below
  }

  const fromEnv = optionalEnv("WORKFLOW_STORAGE_BUCKET");
  if (!fromEnv) {
    throw new Error("WorkflowStorage bucket is not configured");
  }
  return fromEnv;
}

function resolveCredentialEncryptionKey(): string {
  const resourceValue = tryResourceValue("CredentialEncryptionKey")?.trim();
  if (resourceValue) {
    return resourceValue;
  }
  const fromEnv = optionalEnv("CREDENTIAL_ENCRYPTION_KEY")?.trim();
  if (!fromEnv) {
    throw new Error("CredentialEncryptionKey is not configured");
  }
  return fromEnv;
}

function readRequiredString(
  body: DaytonaCredentialUploadBody,
  field: "accessToken" | "refreshToken" | "expiresAt",
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }
  return value.trim();
}

function parseDaytonaCredentialUpload(
  body: DaytonaCredentialUploadBody,
): DaytonaCredential {
  const accessToken = readRequiredString(body, "accessToken");
  const refreshToken = readRequiredString(body, "refreshToken");
  const expiresAt = readRequiredString(body, "expiresAt");
  if (Number.isNaN(Date.parse(expiresAt))) {
    throw new Error("expiresAt must be a valid ISO-8601 timestamp");
  }
  if (
    body.orgId !== undefined &&
    body.orgId !== null &&
    typeof body.orgId !== "string"
  ) {
    throw new Error("orgId must be a string when provided");
  }

  const orgId =
    typeof body.orgId === "string" && body.orgId.trim().length > 0
      ? body.orgId.trim()
      : undefined;

  return {
    provider: DAYTONA_PROVIDER,
    accessToken,
    refreshToken,
    expiresAt,
    ...(orgId ? { orgId } : {}),
  };
}

async function findExistingDaytonaCredential(input: {
  userId: string;
  workspaceId: string;
}): Promise<string | null> {
  const [existing] = await getDb()
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, input.userId),
        eq(providerCredentials.workspaceId, input.workspaceId),
        eq(providerCredentials.modelProvider, DAYTONA_PROVIDER),
        eq(providerCredentials.authType, "provider_oauth"),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: DaytonaCredentialUploadBody;
  try {
    body = (await request.json()) as DaytonaCredentialUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  let credential: DaytonaCredential;
  try {
    credential = parseDaytonaCredentialUpload(body);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }

  const credentialJson = JSON.stringify(credential);
  const credentialExpiresAt = parseCredentialExpiry(credentialJson);
  if (!credentialExpiresAt) {
    return NextResponse.json(
      { error: "expiresAt must be parseable" },
      { status: 400 },
    );
  }

  const credentialEncryptionKey = resolveCredentialEncryptionKey();
  const now = new Date();
  const existingId = await findExistingDaytonaCredential({
    userId: auth.userId,
    workspaceId: auth.workspaceId,
  });
  const providerCredentialId = existingId ?? crypto.randomUUID();

  const s3 = await createCredentialStoreS3Client({ userId: auth.userId });
  const store = new CredentialStore({
    bucket: resolveWorkflowStorageBucket(),
    prefix: "credentials",
    encryptionKey: credentialEncryptionKey,
    client: s3,
  });

  try {
    await store.store(auth.userId, DAYTONA_PROVIDER, credentialJson);
  } catch (error) {
    console.warn("[cli-auth/daytona] Failed to store Daytona credential", {
      providerCredentialId,
      userId: auth.userId,
      workspaceId: auth.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Failed to store Daytona credential", code: "credential_store_failed" },
      { status: 502 },
    );
  }

  if (existingId) {
    await getDb()
      .update(providerCredentials)
      .set({
        status: "connected",
        credentialStoredAt: now,
        credentialExpiresAt,
        lastAuthenticatedAt: now,
        refreshAttempts: 0,
        refreshExhausted: false,
        lastRefreshAttemptAt: null,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(providerCredentials.id, providerCredentialId));
  } else {
    await getDb().insert(providerCredentials).values({
      id: providerCredentialId,
      organizationId: auth.organizationId,
      workspaceId: auth.workspaceId,
      userId: auth.userId,
      harness: harnessForModelProvider(DAYTONA_PROVIDER),
      modelProvider: DAYTONA_PROVIDER,
      authType: "provider_oauth",
      displayName: displayNameForModelProvider(DAYTONA_PROVIDER),
      status: "connected",
      credentialStoredAt: now,
      credentialExpiresAt,
      lastAuthenticatedAt: now,
      refreshAttempts: 0,
      refreshExhausted: false,
      createdAt: now,
      updatedAt: now,
    });
  }

  await ensureActiveProviderCredential({
    userId: auth.userId,
    workspaceId: auth.workspaceId,
    modelProvider: DAYTONA_PROVIDER,
  });

  return NextResponse.json(
    {
      success: true,
      provider: DAYTONA_PROVIDER,
      providerCredentialId,
      id: providerCredentialId,
      credentialExpiresAt: credentialExpiresAt.toISOString(),
    },
    { status: existingId ? 200 : 201 },
  );
}
