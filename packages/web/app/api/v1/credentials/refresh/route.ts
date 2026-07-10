import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import { parseCredentialExpiry } from "@cloud/core/auth/credential-expiry.js";
import { createCredentialStoreS3Client } from "@/lib/storage";
import { requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import { normalizeModelProvider } from "@/lib/billing/house-keys";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";

type RefreshCredentialsBody = {
  provider?: string;
  credentials?: Record<string, unknown>;
};

function isValidProvider(
  provider: string,
): provider is "openai" | "anthropic" | "xai" | "daytona" {
  return (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "xai" ||
    provider === "daytona"
  );
}

function isCredentialsObject(
  value: RefreshCredentialsBody["credentials"],
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function POST(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "auth:token:refresh")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: RefreshCredentialsBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  if (!body || !body.provider || !isValidProvider(body.provider)) {
    return NextResponse.json(
      { error: "Invalid provider" },
      { status: 400 },
    );
  }

  const provider = normalizeModelProvider(body.provider) ?? body.provider;

  if (!isCredentialsObject(body.credentials)) {
    return NextResponse.json(
      { error: "Invalid credentials" },
      { status: 400 },
    );
  }

  try {
    const now = new Date();
    const credentialJson = JSON.stringify(body.credentials);
    // On the Cloudflare Worker we need scoped temp creds for
    // `credentials/<userId>/*` (the Worker has no IAM identity). On
    // Lambda this resolves to the standard bucket-wide client. Either
    // way we hand the resulting S3Client to CredentialStore so it
    // doesn't build its own with the empty default credential chain.
    const s3 = await createCredentialStoreS3Client({ userId: auth.userId });
    const store = new CredentialStore({
      bucket: Resource.WorkflowStorage.bucketName,
      prefix: "credentials",
      encryptionKey: Resource.CredentialEncryptionKey.value,
      client: s3,
    });

    await store.store(auth.userId, provider, credentialJson);

    const credentialExpiresAt = parseCredentialExpiry(credentialJson);

    try {
      const db = getDb();
      const existing = await db
        .select({ id: providerCredentials.id })
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.userId, auth.userId),
            eq(providerCredentials.workspaceId, auth.workspaceId),
            eq(providerCredentials.modelProvider, provider),
            eq(providerCredentials.authType, "provider_oauth"),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(providerCredentials)
          .set({
            status: "connected",
            credentialStoredAt: now,
            lastAuthenticatedAt: now,
            credentialExpiresAt,
            refreshAttempts: 0,
            refreshExhausted: false,
            lastError: null,
            updatedAt: now,
          })
          .where(eq(providerCredentials.id, existing[0].id));
      }
    } catch (err) {
      console.warn(
        "Failed to update provider_credentials record after credential refresh:",
        err instanceof Error ? err.message : String(err),
      );
    }

    return NextResponse.json({
      success: true,
      provider,
      refreshedAt: now.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Credential refresh write-back failed:", message);

    return NextResponse.json(
      { error: "Failed to refresh credentials" },
      { status: 500 },
    );
  }
}
