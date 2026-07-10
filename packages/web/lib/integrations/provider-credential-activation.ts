import { and, desc, eq } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { providerCredentials } from "@/lib/db/schema";

/**
 * Ensure the (user, workspace, model_provider) credential group has exactly
 * one active credential. If none is active (fresh group, or the active row
 * was deleted), promote the most recently authenticated row. Safe to call
 * after every credential insert/upsert — guarded by the
 * provider_credentials_one_active_per_provider partial unique index.
 */
export async function ensureActiveProviderCredential(input: {
  userId: string;
  workspaceId: string;
  modelProvider: string;
  db?: ReturnType<typeof getDb>;
}): Promise<void> {
  // Best-effort by construction: the promotion is convergent (any later
  // credential write re-runs it) and the partial unique index preserves the
  // one-active invariant under races — so a lost race must never fail the
  // credential creation that triggered it. Swallow with a warn instead of
  // making three call sites wrap us in try/catch.
  try {
    await ensureActiveProviderCredentialOrThrow(input);
  } catch (error) {
    console.warn(
      "ensureActiveProviderCredential failed; continuing (promotion is convergent)",
      {
        userId: input.userId,
        workspaceId: input.workspaceId,
        modelProvider: input.modelProvider,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

async function ensureActiveProviderCredentialOrThrow(input: {
  userId: string;
  workspaceId: string;
  modelProvider: string;
  db?: ReturnType<typeof getDb>;
}): Promise<void> {
  const db = input.db ?? getDb();
  const groupWhere = and(
    eq(providerCredentials.userId, input.userId),
    eq(providerCredentials.workspaceId, input.workspaceId),
    eq(providerCredentials.modelProvider, input.modelProvider),
  );

  const activeSibling = await db
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(and(groupWhere, eq(providerCredentials.isActive, true)))
    .limit(1);
  if (activeSibling.length > 0) {
    return;
  }

  const newest = await db
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(groupWhere)
    .orderBy(
      desc(providerCredentials.lastAuthenticatedAt),
      desc(providerCredentials.createdAt),
    )
    .limit(1);
  if (newest.length === 0) {
    return;
  }

  await db
    .update(providerCredentials)
    .set({ isActive: true, updatedAt: new Date() })
    .where(eq(providerCredentials.id, newest[0].id));
}
