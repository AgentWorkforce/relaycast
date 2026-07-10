import { sql } from "drizzle-orm";
import { parseCredentialEmail } from "@cloud/core/auth/credential-email.js";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import { getDb } from "@/lib/db";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import { createCredentialStoreS3Client, readWorkflowStorageBucket } from "@/lib/storage";
import { normalizeModelProvider } from "./house-keys";

type RawRows<T> = { rows?: T[] };

type ProviderCredentialAccountEmailRow = {
  id: string;
  organization_id: string;
  workspace_id: string;
  user_id: string;
  harness: string;
  model_provider: string;
  auth_type: string;
  account_email: string | null;
};

export type ProviderCredentialAccountEmailCandidate = {
  id: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
  harness: string;
  modelProvider: string;
  authType: string;
  accountEmail: string | null;
};

export type ProviderCredentialAccountEmailBackfillOptions = {
  dryRun?: boolean;
  workspaceId?: string;
  userId?: string;
  provider?: string;
  authType?: string;
  limit?: number;
};

export type ProviderCredentialAccountEmailBackfillStatus =
  | "updated"
  | "would_update"
  | "skipped_already_has_email"
  | "skipped_no_store"
  | "skipped_unsupported_auth_type"
  | "skipped_missing_credential"
  | "skipped_no_email"
  | "failed";

export type ProviderCredentialAccountEmailBackfillResult = {
  id: string;
  workspaceId: string;
  userId: string;
  provider: string;
  authType: string;
  credentialStoreKey: string | null;
  accountEmail: string | null;
  status: ProviderCredentialAccountEmailBackfillStatus;
  error?: string;
};

export type ProviderCredentialAccountEmailBackfillSummary = {
  dryRun: boolean;
  scanned: number;
  updated: number;
  skipped: number;
  failed: number;
  results: ProviderCredentialAccountEmailBackfillResult[];
};

export type ProviderCredentialAccountEmailBackfillDeps = {
  listCandidates?: (
    options: ProviderCredentialAccountEmailBackfillOptions,
  ) => Promise<ProviderCredentialAccountEmailCandidate[]>;
  retrieveCredential?: (
    candidate: ProviderCredentialAccountEmailCandidate,
    credentialStoreKey: string,
  ) => Promise<string | null>;
  updateAccountEmail?: (
    candidate: ProviderCredentialAccountEmailCandidate,
    accountEmail: string,
  ) => Promise<boolean>;
};

type RetrieveCredentialFn = NonNullable<
  ProviderCredentialAccountEmailBackfillDeps["retrieveCredential"]
>;

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray((result as RawRows<T>)?.rows)
    ? (result as RawRows<T>).rows!
    : [];
}

function resolveCredentialEncryptionKey(): string {
  const resourceValue = tryResourceValue("CredentialEncryptionKey")?.trim();
  if (resourceValue) {
    return resourceValue;
  }

  const fromEnv = optionalEnv("CREDENTIAL_ENCRYPTION_KEY")?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error("CredentialEncryptionKey is not configured");
}

function resolveCredentialStorePrefix(): string {
  return optionalEnv("CREDENTIAL_S3_PREFIX")?.trim() || "credentials";
}

function resultFor(input: {
  candidate: ProviderCredentialAccountEmailCandidate;
  credentialStoreKey: string | null;
  accountEmail: string | null;
  status: ProviderCredentialAccountEmailBackfillStatus;
  error?: string;
}): ProviderCredentialAccountEmailBackfillResult {
  return {
    id: input.candidate.id,
    workspaceId: input.candidate.workspaceId,
    userId: input.candidate.userId,
    provider: input.candidate.modelProvider,
    authType: input.candidate.authType,
    credentialStoreKey: input.credentialStoreKey,
    accountEmail: input.accountEmail,
    status: input.status,
    ...(input.error ? { error: input.error } : {}),
  };
}

function normalizeCandidate(row: ProviderCredentialAccountEmailRow): ProviderCredentialAccountEmailCandidate {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    harness: row.harness,
    modelProvider: row.model_provider,
    authType: row.auth_type,
    accountEmail: row.account_email,
  };
}

function credentialStoreKeyFor(
  candidate: ProviderCredentialAccountEmailCandidate,
): string | null {
  if (candidate.authType === "relay_managed") {
    return null;
  }
  if (candidate.authType === "byo_api_key") {
    return candidate.id;
  }
  if (candidate.authType === "provider_oauth" || candidate.authType === "oauth_token") {
    const provider = normalizeModelProvider(candidate.modelProvider);
    return provider ?? (candidate.modelProvider.trim() || null);
  }
  return null;
}

function normalizedLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive integer");
  }
  return limit;
}

async function defaultListCandidates(
  options: ProviderCredentialAccountEmailBackfillOptions,
): Promise<ProviderCredentialAccountEmailCandidate[]> {
  const conditions = [sql`account_email IS NULL`];
  if (options.workspaceId) {
    conditions.push(sql`workspace_id = ${options.workspaceId}`);
  }
  if (options.userId) {
    conditions.push(sql`user_id = ${options.userId}`);
  }
  if (options.provider) {
    const provider = normalizeModelProvider(options.provider) ?? options.provider.trim();
    conditions.push(sql`model_provider = ${provider}`);
  }
  if (options.authType) {
    conditions.push(sql`auth_type = ${options.authType}`);
  }

  const limit = normalizedLimit(options.limit);
  const limitSql = limit ? sql`LIMIT ${limit}` : sql``;
  const result = await getDb().execute(sql`
    SELECT
      id,
      organization_id,
      workspace_id,
      user_id,
      harness,
      model_provider,
      auth_type,
      account_email
    FROM provider_credentials
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY workspace_id ASC, user_id ASC, model_provider ASC, created_at ASC
    ${limitSql}
  `);

  return rowsOf<ProviderCredentialAccountEmailRow>(result).map(normalizeCandidate);
}

function createStoreCache(): Map<string, CredentialStore> {
  return new Map<string, CredentialStore>();
}

function defaultRetrieveCredential(
  storeCache: Map<string, CredentialStore>,
): RetrieveCredentialFn {
  return async (candidate, credentialStoreKey) => {
    let store = storeCache.get(candidate.userId);
    if (!store) {
      const client = await createCredentialStoreS3Client({ userId: candidate.userId });
      const bucket =
        readWorkflowStorageBucket()
        ?? optionalEnv("CREDENTIAL_S3_BUCKET")
        ?? optionalEnv("S3_BUCKET");
      if (!bucket) {
        throw new Error("WorkflowStorage bucket is not configured");
      }
      store = new CredentialStore({
        bucket,
        prefix: resolveCredentialStorePrefix(),
        encryptionKey: resolveCredentialEncryptionKey(),
        client,
      });
      storeCache.set(candidate.userId, store);
    }
    return store.retrieve(candidate.userId, credentialStoreKey);
  };
}

async function defaultUpdateAccountEmail(
  candidate: ProviderCredentialAccountEmailCandidate,
  accountEmail: string,
): Promise<boolean> {
  const result = await getDb().execute(sql`
    UPDATE provider_credentials
    SET account_email = ${accountEmail}, updated_at = ${new Date()}
    WHERE id = ${candidate.id}
      AND account_email IS NULL
    RETURNING id
  `);
  return rowsOf<{ id: string }>(result).length > 0;
}

export async function backfillProviderCredentialAccountEmails(
  options: ProviderCredentialAccountEmailBackfillOptions = {},
  deps: ProviderCredentialAccountEmailBackfillDeps = {},
): Promise<ProviderCredentialAccountEmailBackfillSummary> {
  const dryRun = options.dryRun !== false;
  const normalizedOptions = {
    ...options,
    limit: normalizedLimit(options.limit),
  };
  const listCandidates = deps.listCandidates ?? defaultListCandidates;
  const storeCache = createStoreCache();
  const retrieveCredential = deps.retrieveCredential ?? defaultRetrieveCredential(storeCache);
  const updateAccountEmail = deps.updateAccountEmail ?? defaultUpdateAccountEmail;
  const candidates = await listCandidates(normalizedOptions);
  const results: ProviderCredentialAccountEmailBackfillResult[] = [];

  for (const candidate of candidates) {
    const credentialStoreKey = credentialStoreKeyFor(candidate);
    try {
      if (candidate.accountEmail?.trim()) {
        results.push(resultFor({
          candidate,
          credentialStoreKey,
          accountEmail: candidate.accountEmail,
          status: "skipped_already_has_email",
        }));
        continue;
      }

      if (!credentialStoreKey) {
        results.push(resultFor({
          candidate,
          credentialStoreKey,
          accountEmail: null,
          status: candidate.authType === "relay_managed"
            ? "skipped_no_store"
            : "skipped_unsupported_auth_type",
        }));
        continue;
      }

      const credentialJson = await retrieveCredential(candidate, credentialStoreKey);
      if (!credentialJson) {
        results.push(resultFor({
          candidate,
          credentialStoreKey,
          accountEmail: null,
          status: "skipped_missing_credential",
        }));
        continue;
      }

      const accountEmail = parseCredentialEmail(credentialJson);
      if (!accountEmail) {
        results.push(resultFor({
          candidate,
          credentialStoreKey,
          accountEmail: null,
          status: "skipped_no_email",
        }));
        continue;
      }

      if (dryRun) {
        results.push(resultFor({
          candidate,
          credentialStoreKey,
          accountEmail,
          status: "would_update",
        }));
        continue;
      }

      const updated = await updateAccountEmail(candidate, accountEmail);
      results.push(resultFor({
        candidate,
        credentialStoreKey,
        accountEmail,
        status: updated ? "updated" : "skipped_already_has_email",
      }));
    } catch (error) {
      results.push(resultFor({
        candidate,
        credentialStoreKey,
        accountEmail: null,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  const failed = results.filter((result) => result.status === "failed").length;
  const updated = results.filter((result) => result.status === "updated" || result.status === "would_update").length;
  const skipped = results.length - failed - updated;

  return {
    dryRun,
    scanned: candidates.length,
    updated,
    skipped,
    failed,
    results,
  };
}
