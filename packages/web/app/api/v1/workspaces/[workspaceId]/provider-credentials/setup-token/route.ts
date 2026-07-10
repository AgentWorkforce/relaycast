import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
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
} from "@/lib/billing/house-keys";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { ensureActiveProviderCredential } from "@/lib/integrations/provider-credential-activation";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { hasWorkspaceAccess } from "@/lib/integrations/integration-route-handler";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

type SetupTokenBody = {
  label?: unknown;
  token?: unknown;
};

// Claude setup-tokens are long-lived Anthropic OAuth access tokens. They are
// the only model provider this route accepts; OpenAI/Google/OpenRouter keep
// using the BYOK route.
const MODEL_PROVIDER = "anthropic";

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

async function validateSetupToken(token: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const timeoutSignal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    // Setup-tokens are OAuth access tokens, so authenticate with a Bearer
    // header plus the OAuth beta opt-in rather than the x-api-key path BYOK
    // uses. /v1/models is a cheap authenticated read.
    response = await globalThis.fetch("https://api.anthropic.com/v1/models", {
      headers: {
        authorization: `Bearer ${token}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
      signal: timeoutSignal,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "Setup token validation failed",
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
}) {
  const [existing] = await getDb()
    .select({
      id: providerCredentials.id,
      keyFingerprint: providerCredentials.keyFingerprint,
      status: providerCredentials.status,
    })
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.userId, input.userId),
        eq(providerCredentials.workspaceId, input.workspaceId),
        eq(providerCredentials.modelProvider, MODEL_PROVIDER),
        eq(providerCredentials.authType, "oauth_token"),
      ),
    )
    .limit(1);
  return existing ?? null;
}

function fingerprintSetupToken(token: string, encryptionKey: string): string {
  return crypto
    .createHmac("sha256", encryptionKey)
    .update("provider-credential-oauth-token")
    .update("\0")
    .update(MODEL_PROVIDER)
    .update("\0")
    .update(token)
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

  let body: SetupTokenBody;
  try {
    body = (await request.json()) as SetupTokenBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : null;
  if (!token) {
    return NextResponse.json(
      { error: "token is required" },
      { status: 400 },
    );
  }

  const validation = await validateSetupToken(token);
  if (!validation.ok) {
    return NextResponse.json(
      { error: validation.message, code: "setup_token_invalid" },
      { status: 400 },
    );
  }

  const credentialEncryptionKey = resolveCredentialEncryptionKey();
  const keyFingerprint = fingerprintSetupToken(token, credentialEncryptionKey);
  const existingCredential = await findExisting({
    userId: auth.userId,
    workspaceId,
  });
  if (existingCredential?.keyFingerprint === keyFingerprint && existingCredential.status === "connected") {
    return NextResponse.json({ providerCredentialId: existingCredential.id, id: existingCredential.id });
  }

  const now = new Date();
  const providerCredentialId = existingCredential?.id ?? crypto.randomUUID();
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
  if (!existingCredential) {
    await getDb().insert(providerCredentials).values({
      id: providerCredentialId,
      organizationId: auth.organizationId,
      workspaceId,
      userId: auth.userId,
      harness: harnessForModelProvider(MODEL_PROVIDER),
      modelProvider: MODEL_PROVIDER,
      authType: "oauth_token",
      label,
      keyFingerprint,
      displayName: label ?? `${displayNameForModelProvider(MODEL_PROVIDER)} setup token`,
      status: "creating",
      credentialStoredAt: null,
      lastAuthenticatedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  try {
    // Store under the provider-NAME key (not the row UUID). Unlike BYOK
    // (UUID-keyed, multiple keys per provider), a setup-token mirrors the
    // legacy provider_oauth shape: one credential per provider, delivered to
    // sandboxes through the CLI-credentials path — listConnectedProviders +
    // getCliCredentials(userId, "anthropic") -> the launcher reads the
    // {type:'oauth_token'} shape and injects CLAUDE_CODE_OAUTH_TOKEN. Storing
    // under the UUID would make the credential invisible to that path.
    await store.store(
      auth.userId,
      MODEL_PROVIDER,
      JSON.stringify({ type: "oauth_token", modelProvider: MODEL_PROVIDER, token }),
    );
  } catch (error) {
    if (!existingCredential) {
      await getDb()
        .delete(providerCredentials)
        .where(eq(providerCredentials.id, providerCredentialId))
        .catch((cleanupError: unknown) => {
          console.warn("[provider-credentials/setup-token] Failed to clean up pending credential row", {
            providerCredentialId,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
        });
    }
    console.warn("[provider-credentials/setup-token] Failed to store provider credential", {
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
      label,
      keyFingerprint,
      displayName: label ?? `${displayNameForModelProvider(MODEL_PROVIDER)} setup token`,
      status: "connected",
      credentialStoredAt: now,
      lastAuthenticatedAt: now,
      updatedAt: now,
    })
    .where(eq(providerCredentials.id, providerCredentialId));

  // A setup-token-first provider group would otherwise have no active
  // credential until an OAuth auth-complete fires; promote one when none
  // is active.
  await ensureActiveProviderCredential({
    userId: auth.userId,
    workspaceId,
    modelProvider: MODEL_PROVIDER,
  });

  return NextResponse.json(
    { providerCredentialId, id: providerCredentialId },
    { status: existingCredential ? 200 : 201 },
  );
}
