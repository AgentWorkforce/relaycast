import crypto from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import { createCredentialStoreS3Client } from "@/lib/storage";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import {
  displayNameForModelProvider,
  harnessForModelProvider,
  normalizeModelProvider,
} from "@/lib/billing/house-keys";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { ensureActiveProviderCredential } from "@/lib/integrations/provider-credential-activation";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type ByokBody = {
  modelProvider?: unknown;
  label?: unknown;
  key?: unknown;
};

function canWriteCredential(auth: NonNullable<Awaited<ReturnType<typeof resolveRequestAuth>>>): boolean {
  return (
    requireSessionAuth(auth) ||
    requireAuthScope(auth, "cli:auth") ||
    requireAuthScope(auth, "deployments:write")
  );
}

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

async function validateByokKey(modelProvider: string, key: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const timeoutSignal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    if (modelProvider === "anthropic") {
      response = await globalThis.fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
        signal: timeoutSignal,
      });
    } else if (modelProvider === "openai") {
      response = await globalThis.fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${key}` },
        signal: timeoutSignal,
      });
    } else if (modelProvider === "google") {
      const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
      url.searchParams.set("key", key);
      response = await globalThis.fetch(url, { signal: timeoutSignal });
    } else {
      response = await globalThis.fetch("https://openrouter.ai/api/v1/models", {
        headers: { authorization: `Bearer ${key}` },
        signal: timeoutSignal,
      });
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Provider key validation failed",
    };
  }

  if (response.ok) {
    return { ok: true };
  }

  const body = await response.text().catch(() => "");
  return {
    ok: false,
    message: body.trim() || `Provider returned ${response.status}`,
  };
}

async function findExisting(input: {
  userId: string;
  workspaceId: string;
  modelProvider: string;
  label: string | null;
  keyFingerprint: string;
}) {
  const labelPredicate = input.label === null
    ? isNull(providerCredentials.label)
    : eq(providerCredentials.label, input.label);
  const [existing] = await getDb()
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, input.userId),
        eq(providerCredentials.workspaceId, input.workspaceId),
        eq(providerCredentials.modelProvider, input.modelProvider),
        eq(providerCredentials.authType, "byo_api_key"),
        labelPredicate,
        eq(providerCredentials.keyFingerprint, input.keyFingerprint),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}

function fingerprintByokKey(modelProvider: string, key: string, encryptionKey: string): string {
  return crypto
    .createHmac("sha256", encryptionKey)
    .update("provider-credential-byok")
    .update("\0")
    .update(modelProvider)
    .update("\0")
    .update(key)
    .digest("hex");
}

export async function POST(request: NextRequest, context: RouteContext) {
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

  let body: ByokBody;
  try {
    body = (await request.json()) as ByokBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const modelProvider = typeof body.modelProvider === "string"
    ? normalizeModelProvider(body.modelProvider)
    : null;
  const key = typeof body.key === "string" ? body.key.trim() : "";
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
  if (!modelProvider || !key) {
    return NextResponse.json(
      { error: "modelProvider and key are required" },
      { status: 400 },
    );
  }

  const validation = await validateByokKey(modelProvider, key);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.message, code: "provider_key_invalid" },
      { status: 400 },
    );
  }

  const credentialEncryptionKey = resolveCredentialEncryptionKey();
  const keyFingerprint = fingerprintByokKey(modelProvider, key, credentialEncryptionKey);
  const existingId = await findExisting({
    userId: auth.userId,
    workspaceId,
    modelProvider,
    label,
    keyFingerprint,
  });
  if (existingId) {
    return NextResponse.json({ providerCredentialId: existingId, id: existingId });
  }

  const now = new Date();
  const providerCredentialId = crypto.randomUUID();
  // Worker-aware S3 client; on Lambda this is the standard
  // bucket-wide client, on the Worker it's STS-broker creds scoped to
  // `credentials/<userId>/*`.
  const s3 = await createCredentialStoreS3Client({ userId: auth.userId });
  const store = new CredentialStore({
    bucket: resolveWorkflowStorageBucket(),
    prefix: "credentials",
    encryptionKey: credentialEncryptionKey,
    client: s3,
  });
  await getDb().insert(providerCredentials).values({
    id: providerCredentialId,
    organizationId: auth.organizationId,
    workspaceId,
    userId: auth.userId,
    harness: harnessForModelProvider(modelProvider),
    modelProvider,
    authType: "byo_api_key",
    label: label ?? undefined,
    keyFingerprint,
    displayName: label ?? `${displayNameForModelProvider(modelProvider)} BYOK`,
    status: "creating",
    credentialStoredAt: null,
    lastAuthenticatedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await store.store(
      auth.userId,
      providerCredentialId,
      JSON.stringify({ type: "api_key", modelProvider, key }),
    );
  } catch (error) {
    await getDb()
      .delete(providerCredentials)
      .where(eq(providerCredentials.id, providerCredentialId))
      .catch((cleanupError: unknown) => {
        console.warn("[provider-credentials/byok] Failed to clean up pending credential row", {
          providerCredentialId,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
      });
    console.warn("[provider-credentials/byok] Failed to store provider credential", {
      providerCredentialId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: "Failed to store provider credential", code: "credential_store_failed" },
      { status: 502 },
    );
  }

  await getDb()
    .update(providerCredentials)
    .set({
      status: "connected",
      credentialStoredAt: now,
      lastAuthenticatedAt: now,
      updatedAt: now,
    })
    .where(eq(providerCredentials.id, providerCredentialId));

  // A byok-first provider group would otherwise have no active credential
  // until an OAuth auth-complete fires; promote one when none is active.
  await ensureActiveProviderCredential({
    userId: auth.userId,
    workspaceId,
    modelProvider,
  });

  return NextResponse.json(
    { providerCredentialId, id: providerCredentialId },
    { status: 201 },
  );
}
