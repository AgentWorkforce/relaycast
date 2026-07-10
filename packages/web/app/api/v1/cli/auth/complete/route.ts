import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { Resource } from "sst";
import { parseCredentialEmail } from "@cloud/core/auth/credential-email.js";
import { parseCredentialExpiry } from "@cloud/core/auth/credential-expiry.js";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import { completeAuthSession } from "@cloud/core/auth/sandbox-auth.js";
import { createCredentialStoreS3Client } from "@/lib/storage";
import { requireAuthScope, resolveRequestAuth } from "@/lib/auth/request-auth";
import {
  displayNameForModelProvider,
  harnessForModelProvider,
  normalizeModelProvider,
} from "@/lib/billing/house-keys";
import { cliAuthSessionStore } from "@/lib/auth/session-store";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { ensureActiveProviderCredential } from "@/lib/integrations/provider-credential-activation";
import { optionalEnv } from "@/lib/env";
import { consumeRateLimit } from "@/lib/workers/rate-limit";

function resolveCredentialEncryptionKey(): string {
  const fromEnv = optionalEnv("CREDENTIAL_ENCRYPTION_KEY");
  if (fromEnv) {
    return fromEnv;
  }

  return Resource.CredentialEncryptionKey.value;
}

function resolveWorkflowStorageBucket(): string {
  const fromEnv = optionalEnv("WORKFLOW_STORAGE_BUCKET");
  if (fromEnv) {
    return fromEnv;
  }

  return Resource.WorkflowStorage.bucketName;
}

export async function POST(request: NextRequest) {
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown";
  const rateLimit = consumeRateLimit(`cli-auth-complete:${ip}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(rateLimit.retryAfterMs / 1000)),
        },
      },
    );
  }

  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { sessionId?: string; success?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { sessionId, success } = body;
  if (!sessionId || typeof sessionId !== "string") {
    return NextResponse.json(
      { error: "Missing required field: sessionId" },
      { status: 400 }
    );
  }

  try {
    const credentialEncryptionKey = resolveCredentialEncryptionKey();
    const result = await completeAuthSession({
      sessionId,
      success: success === true,
      credentialEncryptionKey,
      sessionStore: cliAuthSessionStore,
    });

    // Upsert provider_credentials record when credentials were successfully stored.
    if (result.success && result.provider) {
      try {
        const db = getDb();
        const now = new Date();
        const provider = normalizeModelProvider(result.provider) ?? result.provider;
        let credentialExpiresAt: Date | null = null;
        let accountEmail: string | null = null;

        // Authoritative read-back: a credential is only "connected" if its
        // encrypted blob is actually retrievable from the store the runtime
        // and deploy paths read from. completeAuthSession() stores
        // best-effort and can silently fail (e.g. the sandbox login never
        // wrote the credential file), which previously still flipped the row
        // to "connected" — yielding a green dashboard with nothing in storage
        // and an opaque deploy 500 when the credential later fails to resolve.
        let credJson: string | null = null;
        let readBackError: string | null = null;
        try {
          // Worker-aware S3 client — see /credentials/refresh for the
          // rationale.
          const s3 = await createCredentialStoreS3Client({
            userId: auth.userId,
          });
          const store = new CredentialStore({
            bucket: resolveWorkflowStorageBucket(),
            prefix: "credentials",
            encryptionKey: credentialEncryptionKey,
            client: s3,
          });
          credJson = await store.retrieve(auth.userId, result.provider);
        } catch (err) {
          readBackError = err instanceof Error ? err.message : String(err);
        }

        if (!credJson) {
          // Credential did not persist to readable storage — do NOT mark
          // connected. Surface the failure on any existing row and tell the
          // CLI it did not actually store so the user can retry.
          const detail = readBackError
            ? `credential store read-back failed: ${readBackError}`
            : "credential was not persisted to storage (the sandbox login may not have produced a credential file)";
          console.error(
            `[cli-auth-complete] credential not stored for ${provider}: ${detail}`,
          );
          try {
            await db
              .update(providerCredentials)
              .set({ status: "error", lastError: detail, updatedAt: now })
              .where(
                and(
                  eq(providerCredentials.userId, auth.userId),
                  eq(providerCredentials.workspaceId, auth.workspaceId),
                  eq(providerCredentials.modelProvider, provider),
                  eq(providerCredentials.authType, "provider_oauth"),
                ),
              );
          } catch (statusErr) {
            console.warn(
              "Failed to record credential store failure status:",
              statusErr instanceof Error ? statusErr.message : String(statusErr),
            );
          }
          return NextResponse.json(
            {
              success: false,
              provider: result.provider,
              error:
                "Authentication completed but the credential was not stored. Please try connecting again.",
            },
            { status: 502 },
          );
        }

        try {
          credentialExpiresAt = parseCredentialExpiry(credJson);
          accountEmail = parseCredentialEmail(credJson);
        } catch {
          // best-effort — don't fail auth completion if expiry parse fails
        }

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
          // Update existing agent
          await db
            .update(providerCredentials)
            .set({
              status: "connected",
              credentialStoredAt: now,
              credentialExpiresAt,
              ...(accountEmail ? { accountEmail } : {}),
              lastAuthenticatedAt: now,
              refreshAttempts: 0,
              refreshExhausted: false,
              lastRefreshAttemptAt: null,
              lastError: null,
              updatedAt: now,
            })
            .where(eq(providerCredentials.id, existing[0].id));
        } else {
          // Insert new agent
          await db.insert(providerCredentials).values({
            id: crypto.randomUUID(),
            organizationId: auth.organizationId,
            workspaceId: auth.workspaceId,
            userId: auth.userId,
            harness: harnessForModelProvider(provider),
            modelProvider: provider,
            authType: "provider_oauth",
            displayName: displayNameForModelProvider(provider),
            accountEmail: accountEmail ?? undefined,
            status: "connected",
            credentialStoredAt: now,
            credentialExpiresAt: credentialExpiresAt ?? undefined,
            lastAuthenticatedAt: now,
            createdAt: now,
            updatedAt: now,
          });
        }

        await ensureActiveProviderCredential({
          userId: auth.userId,
          workspaceId: auth.workspaceId,
          modelProvider: provider,
          db,
        });
      } catch (err) {
        // Best-effort: don't fail the auth completion if agent upsert fails
        console.warn(
          "Failed to upsert provider_credentials record:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("CLI auth session completion failed:", message);

    const isNotFound = message.includes("Session not found") || message.includes("Session expired");
    return NextResponse.json(
      { error: isNotFound ? "Session not found or expired" : "Failed to complete auth session. Please try again." },
      { status: isNotFound ? 404 : 500 }
    );
  }
}
