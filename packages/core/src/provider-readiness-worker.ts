// pg-free, CF Worker-only implementation of the three initial-sync mark
// functions.  Import graph deliberately avoids ./db/client.ts (which carries
// a static `import { Pool } from "pg"`) by using the Neon HTTP driver instead.
//
// Callers: packages/core/src/sync/nango-sync-workflow.ts (CF Workflow step).

import { and, eq } from "drizzle-orm";
import { getNeonHttpDb } from "./db/worker-neon-http.js";
import { requireNeonDatabaseUrl } from "./db/connection.js";
import { workspaceIntegrations } from "./db/schema.js";
import {
  parseIntegrationMetadata,
  writeProviderReadiness,
  buildInitialSyncRunningPatch,
  buildInitialSyncCompletePatch,
  buildInitialSyncFailedPatch,
} from "./provider-readiness-core.js";

function getWorkerDb() {
  return getNeonHttpDb(requireNeonDatabaseUrl());
}

async function loadIntegration(
  workspaceId: string,
  provider: string,
): Promise<{ workspaceId: string; provider: string; metadataJson: string } | null> {
  const db = getWorkerDb();
  const [record] = await db
    .select({
      workspaceId: workspaceIntegrations.workspaceId,
      provider: workspaceIntegrations.provider,
      metadataJson: workspaceIntegrations.metadataJson,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, provider),
      ),
    )
    .limit(1);
  return record ?? null;
}

async function saveIntegrationMetadata(
  workspaceId: string,
  provider: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const db = getWorkerDb();
  await db
    .update(workspaceIntegrations)
    .set({
      metadataJson: JSON.stringify(metadata),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, provider),
      ),
    );
}

async function mutateReadiness(
  workspaceId: string,
  provider: string,
  patch: Parameters<typeof writeProviderReadiness>[1],
): Promise<void> {
  const record = await loadIntegration(workspaceId, provider);
  if (!record) return;
  const metadata = parseIntegrationMetadata(record.metadataJson);
  const updated = writeProviderReadiness(metadata, patch);
  await saveIntegrationMetadata(workspaceId, provider, updated);
}

export async function markProviderInitialSyncRunning(input: {
  workspaceId: string;
  provider: string;
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at?: string;
}): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await mutateReadiness(
    input.workspaceId,
    input.provider,
    buildInitialSyncRunningPatch({
      providerConfigKey: input.providerConfigKey,
      syncName: input.syncName,
      model: input.model,
      modifiedAfter: input.modifiedAfter,
      at,
    }),
  );
}

export async function markProviderInitialSyncComplete(input: {
  workspaceId: string;
  provider: string;
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at?: string;
}): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await mutateReadiness(
    input.workspaceId,
    input.provider,
    buildInitialSyncCompletePatch({
      providerConfigKey: input.providerConfigKey,
      syncName: input.syncName,
      model: input.model,
      modifiedAfter: input.modifiedAfter,
      at,
    }),
  );
}

export async function markProviderInitialSyncFailed(input: {
  workspaceId: string;
  provider: string;
  error: string;
  providerConfigKey?: string | null;
  syncName?: string | null;
  model?: string | null;
  modifiedAfter?: string | null;
  at?: string;
}): Promise<void> {
  const at = input.at ?? new Date().toISOString();
  await mutateReadiness(
    input.workspaceId,
    input.provider,
    buildInitialSyncFailedPatch({
      error: input.error,
      providerConfigKey: input.providerConfigKey,
      syncName: input.syncName,
      model: input.model,
      modifiedAfter: input.modifiedAfter,
      at,
    }),
  );
}
