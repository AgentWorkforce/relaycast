import { and, desc, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import {
  fetchAccountUsageSnapshot,
  type AccountUsageSnapshot,
} from "@cloud/core/auth/account-usage.js";
import { createCredentialStoreS3Client } from "@/lib/storage";
import { refreshHarnessCliCredentialIfStale } from "@/lib/proactive-runtime/harness-credential-refresh";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { optionalEnv, tryResourceValue } from "@/lib/env";

type CloudAgentRow = {
  id: string;
  displayName: string;
  harness: string;
  modelProvider: string;
  authType: string;
  label: string | null;
  accountEmail: string | null;
  isActive: boolean;
  defaultModel: string | null;
  status: string;
  credentialStoredAt: Date | null;
  lastAuthenticatedAt: Date | null;
  lastUsedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type CredentialStoreForUsage = {
  retrieve(userId: string, provider: string): Promise<string | null>;
  store(userId: string, provider: string, credentialJson: string): Promise<void>;
};

type UsageCacheEntry = {
  expiresAtMs: number;
  fingerprint: string;
  snapshot: AccountUsageSnapshot;
};

const USAGE_CACHE_TTL_MS = 60_000;
const USAGE_CACHE_PRUNE_THRESHOLD = 1_000;
const usageCache = new Map<string, UsageCacheEntry>();

type ActiveUsageCredentialFetches = Map<string, Promise<string | null>>;

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

async function createCredentialStoreForUser(
  userId: string,
): Promise<CredentialStoreForUsage> {
  const s3 = await createCredentialStoreS3Client({ userId });
  return new CredentialStore({
    bucket: resolveWorkflowStorageBucket(),
    prefix: "credentials",
    encryptionKey: resolveCredentialEncryptionKey(),
    client: s3,
  }) as unknown as CredentialStoreForUsage;
}

function credentialStoreKeyForUsage(row: CloudAgentRow): string | null {
  if (row.authType === "provider_oauth" || row.authType === "oauth_token") {
    return row.modelProvider;
  }
  return null;
}

function unsupportedUsageSnapshot(row: CloudAgentRow): AccountUsageSnapshot {
  return {
    provider: row.modelProvider,
    status: "unsupported",
    source: "none",
    fetchedAt: new Date().toISOString(),
    windows: [],
    error: "Usage snapshots require stored OAuth credentials.",
  };
}

function usageFingerprint(row: CloudAgentRow): string {
  return [
    row.id,
    row.modelProvider,
    row.authType,
    row.credentialStoredAt?.toISOString() ?? "",
    row.updatedAt.toISOString(),
  ].join(":");
}

function pruneExpiredUsageCache(nowMs = Date.now()): void {
  if (usageCache.size <= USAGE_CACHE_PRUNE_THRESHOLD) {
    return;
  }
  for (const [cacheKey, entry] of usageCache.entries()) {
    if (entry.expiresAtMs <= nowMs) {
      usageCache.delete(cacheKey);
    }
  }
}

async function getFreshCredentialForUsage(input: {
  row: CloudAgentRow;
  userId: string;
  key: string;
  store: CredentialStoreForUsage;
  activeCredentialFetches: ActiveUsageCredentialFetches;
}): Promise<string | null> {
  const refreshKey = `${input.userId}:${input.key}:${input.row.authType}`;
  let promise = input.activeCredentialFetches.get(refreshKey);
  if (!promise) {
    promise = (async () => {
      const credentialJson = await input.store.retrieve(input.userId, input.key);
      if (credentialJson && input.row.authType === "provider_oauth") {
        return refreshHarnessCliCredentialIfStale({
          store: input.store,
          userId: input.userId,
          provider: input.row.modelProvider,
          credentialJson,
        });
      }
      return credentialJson;
    })();
    input.activeCredentialFetches.set(refreshKey, promise);
  }
  return promise;
}

async function usageSnapshotForAgent(input: {
  row: CloudAgentRow;
  userId: string;
  store: CredentialStoreForUsage;
  activeCredentialFetches: ActiveUsageCredentialFetches;
}): Promise<AccountUsageSnapshot> {
  const key = credentialStoreKeyForUsage(input.row);
  if (!key) {
    return unsupportedUsageSnapshot(input.row);
  }

  const fingerprint = usageFingerprint(input.row);
  const cached = usageCache.get(input.row.id);
  if (cached && cached.fingerprint === fingerprint && cached.expiresAtMs > Date.now()) {
    return cached.snapshot;
  }

  const freshCredentialJson = await getFreshCredentialForUsage({
    row: input.row,
    userId: input.userId,
    key,
    store: input.store,
    activeCredentialFetches: input.activeCredentialFetches,
  });
  const snapshot = await fetchAccountUsageSnapshot({
    provider: input.row.modelProvider,
    credentialJson: freshCredentialJson,
  });
  usageCache.set(input.row.id, {
    fingerprint,
    snapshot,
    expiresAtMs: Date.now() + USAGE_CACHE_TTL_MS,
  });
  pruneExpiredUsageCache();
  return snapshot;
}

async function attachUsageSnapshots(input: {
  agents: CloudAgentRow[];
  userId: string;
}): Promise<Array<CloudAgentRow & { usage: AccountUsageSnapshot | null }>> {
  if (input.agents.length === 0) {
    return [];
  }

  let store: CredentialStoreForUsage | null = null;
  try {
    store = await createCredentialStoreForUser(input.userId);
  } catch (error) {
    console.warn("[cloud-agents] Failed to initialize credential store for usage snapshots", {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const activeCredentialFetches: ActiveUsageCredentialFetches = new Map();

  return Promise.all(
    input.agents.map(async (row) => {
      if (!store) {
        return { ...row, usage: null };
      }
      try {
        return {
          ...row,
          usage: await usageSnapshotForAgent({
            row,
            userId: input.userId,
            store,
            activeCredentialFetches,
          }),
        };
      } catch (error) {
        return {
          ...row,
          usage: {
            provider: row.modelProvider,
            status: "error",
            source: "none",
            fetchedAt: new Date().toISOString(),
            windows: [],
            error: error instanceof Error ? error.message : String(error),
          } satisfies AccountUsageSnapshot,
        };
      }
    }),
  );
}

export async function GET(request: NextRequest) {
  const auth = await resolveRequestAuth(request);
  if (!auth) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!requireSessionAuth(auth) && !requireAuthScope(auth, "cli:auth")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const includeUsage = request.nextUrl.searchParams.get("usage") === "1";
    const agents = await getDb()
      .select({
        id: providerCredentials.id,
        displayName: providerCredentials.displayName,
        harness: providerCredentials.harness,
        modelProvider: providerCredentials.modelProvider,
        authType: providerCredentials.authType,
        label: providerCredentials.label,
        accountEmail: providerCredentials.accountEmail,
        isActive: providerCredentials.isActive,
        defaultModel: providerCredentials.defaultModel,
        status: providerCredentials.status,
        credentialStoredAt: providerCredentials.credentialStoredAt,
        lastAuthenticatedAt: providerCredentials.lastAuthenticatedAt,
        lastUsedAt: providerCredentials.lastUsedAt,
        lastError: providerCredentials.lastError,
        createdAt: providerCredentials.createdAt,
        updatedAt: providerCredentials.updatedAt,
      })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.userId, auth.userId),
          eq(providerCredentials.workspaceId, auth.workspaceId),
        ),
      )
      .orderBy(desc(providerCredentials.updatedAt), desc(providerCredentials.createdAt));

    if (!includeUsage) {
      return NextResponse.json({ agents });
    }

    return NextResponse.json({
      agents: await attachUsageSnapshots({
        agents: agents as CloudAgentRow[],
        userId: auth.userId,
      }),
    });
  } catch (error) {
    console.error("Cloud agent listing failed:", error);

    if (
      error instanceof Error &&
      error.message.includes('relation "provider_credentials" does not exist')
    ) {
      return NextResponse.json({ agents: [] });
    }

    return NextResponse.json({ error: "Failed to load cloud agents" }, { status: 500 });
  }
}
