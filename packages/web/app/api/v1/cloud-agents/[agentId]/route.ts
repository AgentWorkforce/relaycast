import { and, desc, eq, inArray } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { Resource } from "sst";
import { CredentialStore } from "@cloud/core/auth/credential-store.js";
import { createCredentialStoreS3Client } from "@/lib/storage";
import {
  requireAuthScope,
  requireSessionAuth,
  resolveRequestAuth,
} from "@/lib/auth/request-auth";
import { normalizeModelProvider } from "@/lib/billing/house-keys";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";
import { optionalEnv, tryResourceValue } from "@/lib/env";
import {
  ACTIVE_CREDENTIAL_CONSTRAINT,
  isActiveCredentialConflict,
} from "@/lib/integrations/provider-credential-errors";

type RouteContext = {
  params: Promise<{ agentId: string }>;
};

const cloudAgentProjection = {
  id: providerCredentials.id,
  displayName: providerCredentials.displayName,
  harness: providerCredentials.harness,
  defaultModel: providerCredentials.defaultModel,
  status: providerCredentials.status,
  credentialStoredAt: providerCredentials.credentialStoredAt,
  lastAuthenticatedAt: providerCredentials.lastAuthenticatedAt,
  lastUsedAt: providerCredentials.lastUsedAt,
  lastError: providerCredentials.lastError,
  createdAt: providerCredentials.createdAt,
  updatedAt: providerCredentials.updatedAt,
};

export type CloudAgentDetailRouteDeps = {
  resolveRequestAuth: typeof resolveRequestAuth;
  requireSessionAuth: typeof requireSessionAuth;
  requireAuthScope: typeof requireAuthScope;
  getDb: typeof getDb;
  createCredentialStoreForUser: typeof createCredentialStoreForUser;
};

const defaultDeps: CloudAgentDetailRouteDeps = {
  resolveRequestAuth,
  requireSessionAuth,
  requireAuthScope,
  getDb,
  createCredentialStoreForUser,
};

type CredentialStoreForDelete = {
  delete(userId: string, provider: string): Promise<void>;
};

type DeletedCredentialRow = {
  id: string;
  displayName: string;
  harness: string;
  defaultModel: string | null;
  status: string;
  credentialStoredAt: Date | null;
  lastAuthenticatedAt: Date | null;
  lastUsedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  authType: string;
  isActive: boolean;
  modelProvider: string;
};

type ProviderNameKeyedRow = {
  authType: string;
  id: string;
  modelProvider: string;
};

type CredentialStoreDeletePlan =
  | {
      key: string;
      mode: "byok-row" | "provider-name";
    }
  | {
      reason:
        | "provider-name-key-still-referenced"
        | "relay-managed-has-no-blob"
        | "unsupported-auth-type"
        | "unsupported-provider";
    };

const PROVIDER_NAME_KEYED_AUTH_TYPES = ["provider_oauth", "oauth_token"];

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
): Promise<CredentialStoreForDelete> {
  const s3 = await createCredentialStoreS3Client({ userId });
  return new CredentialStore({
    bucket: resolveWorkflowStorageBucket(),
    prefix: "credentials",
    encryptionKey: resolveCredentialEncryptionKey(),
    client: s3,
  }) as unknown as CredentialStoreForDelete;
}

export function planCredentialStoreDelete(input: {
  deleted: Pick<DeletedCredentialRow, "authType" | "id" | "modelProvider">;
  remainingProviderNameKeyedRows: ProviderNameKeyedRow[];
}): CredentialStoreDeletePlan {
  if (input.deleted.authType === "byo_api_key") {
    return { key: input.deleted.id, mode: "byok-row" };
  }

  if (input.deleted.authType === "relay_managed") {
    return { reason: "relay-managed-has-no-blob" };
  }

  if (!PROVIDER_NAME_KEYED_AUTH_TYPES.includes(input.deleted.authType)) {
    return { reason: "unsupported-auth-type" };
  }

  const provider = normalizeModelProvider(input.deleted.modelProvider);
  if (!provider) {
    return { reason: "unsupported-provider" };
  }

  const stillReferenced = input.remainingProviderNameKeyedRows.some((row) => (
    PROVIDER_NAME_KEYED_AUTH_TYPES.includes(row.authType) &&
    normalizeModelProvider(row.modelProvider) === provider
  ));
  if (stillReferenced) {
    return { reason: "provider-name-key-still-referenced" };
  }

  return { key: provider, mode: "provider-name" };
}

async function deleteCredentialStoreBlob(input: {
  createCredentialStoreForUser: typeof createCredentialStoreForUser;
  plan: CredentialStoreDeletePlan;
  userId: string;
}): Promise<
  | undefined
  | {
      attempted: true;
      key: string;
      mode: "byok-row" | "provider-name";
      success: boolean;
      error?: string;
    }
> {
  if (!("key" in input.plan)) {
    return undefined;
  }

  try {
    const store = await input.createCredentialStoreForUser(input.userId);
    await store.delete(input.userId, input.plan.key);
    return {
      attempted: true,
      key: input.plan.key,
      mode: input.plan.mode,
      success: true,
    };
  } catch (error) {
    return {
      attempted: true,
      key: input.plan.key,
      mode: input.plan.mode,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

class CredentialStoreDeleteFailedError extends Error {
  constructor(
    readonly credentialStoreDelete: {
      attempted: true;
      key: string;
      mode: "byok-row" | "provider-name";
      success: false;
      error?: string;
    },
  ) {
    super(credentialStoreDelete.error ?? "Credential store delete failed");
    this.name = "CredentialStoreDeleteFailedError";
  }
}

function isMissingProviderCredentialsTable(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes('relation "provider_credentials" does not exist')
  );
}

export function createCloudAgentDetailRouteHandlers(
  deps: CloudAgentDetailRouteDeps = defaultDeps,
) {
  async function requireUserAuth(request: NextRequest) {
    const auth = await deps.resolveRequestAuth(request);
    if (!auth) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!deps.requireSessionAuth(auth) && !deps.requireAuthScope(auth, "cli:auth")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return auth;
  }

  async function GET(request: NextRequest, { params }: RouteContext) {
    const auth = await requireUserAuth(request);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const { agentId } = await params;

    try {
      const [record] = await deps
        .getDb()
        .select(cloudAgentProjection)
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.id, agentId),
            eq(providerCredentials.userId, auth.userId),
            eq(providerCredentials.workspaceId, auth.workspaceId),
          ),
        )
        .limit(1);

      if (!record) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }
      return NextResponse.json(record);
    } catch (error) {
      console.error("Cloud agent detail failed:", error);

      if (isMissingProviderCredentialsTable(error)) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }

      return NextResponse.json(
        { error: "Failed to load cloud agent" },
        { status: 500 },
      );
    }
  }

  async function DELETE(request: NextRequest, { params }: RouteContext) {
    const auth = await requireUserAuth(request);
    if (auth instanceof NextResponse) {
      return auth;
    }

    const { agentId } = await params;

    try {
      const db = deps.getDb();
      const result = await db.transaction(async (tx) => {
        const [deleted] = await tx
          .delete(providerCredentials)
          .where(
            and(
              eq(providerCredentials.id, agentId),
              eq(providerCredentials.userId, auth.userId),
              eq(providerCredentials.workspaceId, auth.workspaceId),
            ),
          )
          .returning({
            ...cloudAgentProjection,
            authType: providerCredentials.authType,
            modelProvider: providerCredentials.modelProvider,
            isActive: providerCredentials.isActive,
          });

        if (!deleted) {
          return null;
        }

        const [activeSibling] = await tx
          .select({ id: providerCredentials.id })
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.userId, auth.userId),
              eq(providerCredentials.workspaceId, auth.workspaceId),
              eq(providerCredentials.modelProvider, deleted.modelProvider),
              eq(providerCredentials.isActive, true),
            ),
          )
          .limit(1);

        if (!activeSibling) {
          const [nextActive] = await tx
            .select({ id: providerCredentials.id })
            .from(providerCredentials)
            .where(
              and(
                eq(providerCredentials.userId, auth.userId),
                eq(providerCredentials.workspaceId, auth.workspaceId),
                eq(providerCredentials.modelProvider, deleted.modelProvider),
              ),
            )
            .orderBy(
              desc(providerCredentials.lastAuthenticatedAt),
              desc(providerCredentials.createdAt),
            )
            .limit(1);

          if (nextActive) {
            await tx
              .update(providerCredentials)
              .set({ isActive: true, updatedAt: new Date() })
              .where(eq(providerCredentials.id, nextActive.id));
          }
        }

        const remainingProviderNameKeyedRows = await tx
          .select({
            id: providerCredentials.id,
            authType: providerCredentials.authType,
            modelProvider: providerCredentials.modelProvider,
          })
          .from(providerCredentials)
          .where(
            and(
              eq(providerCredentials.userId, auth.userId),
              inArray(providerCredentials.authType, PROVIDER_NAME_KEYED_AUTH_TYPES),
            ),
          );

        const credentialStoreDeletePlan = planCredentialStoreDelete({
          deleted,
          remainingProviderNameKeyedRows,
        });
        const credentialStoreDelete =
          "key" in credentialStoreDeletePlan &&
          credentialStoreDeletePlan.mode === "provider-name"
            ? await deleteCredentialStoreBlob({
                createCredentialStoreForUser: deps.createCredentialStoreForUser,
                plan: credentialStoreDeletePlan,
                userId: auth.userId,
              })
            : undefined;
        if (credentialStoreDelete?.success === false) {
          throw new CredentialStoreDeleteFailedError({
            ...credentialStoreDelete,
            success: false,
          });
        }

        return {
          deleted: deleted as DeletedCredentialRow,
          credentialStoreDeletePlan,
          credentialStoreDelete,
        };
      });

      if (!result) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }

      const credentialStoreDelete = result.credentialStoreDelete
        ?? await deleteCredentialStoreBlob({
          createCredentialStoreForUser: deps.createCredentialStoreForUser,
          plan: result.credentialStoreDeletePlan,
          userId: auth.userId,
        });
      if (credentialStoreDelete && !credentialStoreDelete.success) {
        console.warn("[cloud-agents] Deleted credential row but failed to delete credential store blob", {
          agentId,
          userId: auth.userId,
          workspaceId: auth.workspaceId,
          key: credentialStoreDelete.key,
          mode: credentialStoreDelete.mode,
          error: credentialStoreDelete.error,
        });
      }

      return NextResponse.json({
        ...result.deleted,
        ...(credentialStoreDelete ? { credentialStoreDelete } : {}),
      });
    } catch (error) {
      if (isMissingProviderCredentialsTable(error)) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      }

      if (error instanceof CredentialStoreDeleteFailedError) {
        console.warn("[cloud-agents] Failed to delete final provider-name credential store blob before deleting row", {
          agentId,
          userId: auth.userId,
          workspaceId: auth.workspaceId,
          key: error.credentialStoreDelete.key,
          mode: error.credentialStoreDelete.mode,
          error: error.credentialStoreDelete.error,
        });
        return NextResponse.json(
          {
            error: "Failed to delete credential store blob",
            code: "credential_store_delete_failed",
            credentialStoreDelete: error.credentialStoreDelete,
          },
          { status: 502 },
        );
      }

      if (isActiveCredentialConflict(error)) {
        console.warn("Cloud agent delete promotion conflict:", {
          agentId,
          userId: auth.userId,
          workspaceId: auth.workspaceId,
          constraint: ACTIVE_CREDENTIAL_CONSTRAINT,
        });
        return NextResponse.json(
          {
            error:
              "Another credential activation completed first. Refresh and try again.",
            code: "active_credential_conflict",
          },
          { status: 409 },
        );
      }

      console.error("Cloud agent detail failed:", error);

      return NextResponse.json(
        { error: "Failed to delete cloud agent" },
        { status: 500 },
      );
    }
  }

  return { GET, DELETE };
}

export const { GET, DELETE } = createCloudAgentDetailRouteHandlers();
