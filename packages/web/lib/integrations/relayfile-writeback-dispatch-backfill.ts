import { parseIntegrationMetadata } from "@cloud/core/provider-readiness.js";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { workspaceIntegrations } from "../db/schema";
import {
  normalizeWritebackProvider,
  pushRelayfileIntegrationCredential,
  type RelayfileIntegrationPushResult,
} from "./relayfile-integration-push";
import type { WorkspaceIntegrationRecord } from "./workspace-integrations";

export type RelayfileWritebackCfBackfillCandidate =
  WorkspaceIntegrationRecord & {
    id: string;
  };

export type RelayfileWritebackCfBackfillResult =
  | {
      status: "activated" | "resynced" | "would_activate" | "would_resync";
      workspaceId: string;
      provider: string;
      connectionId: string;
    }
  | {
      status: "skipped_unsupported_provider";
      workspaceId: string;
      provider: string;
      connectionId: string;
      reason: string;
    }
  | {
      status: "failed";
      workspaceId: string;
      provider: string;
      connectionId: string;
      error: string;
    };

export type RelayfileWritebackCfBackfillSummary = {
  dryRun: boolean;
  scanned: number;
  activated: number;
  resynced: number;
  skipped: number;
  failed: number;
  results: RelayfileWritebackCfBackfillResult[];
};

export type RelayfileWritebackCfBackfillOptions = {
  workspaceId?: string;
  provider?: string;
  limit?: number;
  dryRun?: boolean;
  timeoutMs?: number;
  now?: () => Date;
};

type RelayfileWritebackCfBackfillDeps = {
  listCandidates?: (
    options: RelayfileWritebackCfBackfillOptions,
  ) => Promise<RelayfileWritebackCfBackfillCandidate[]>;
  pushCredential?: (
    integration: WorkspaceIntegrationRecord,
    options: { timeoutMs?: number },
  ) => Promise<RelayfileIntegrationPushResult>;
  activateCandidate?: (
    candidate: RelayfileWritebackCfBackfillCandidate,
    now: Date,
  ) => Promise<boolean>;
};

export async function backfillRelayfileWritebackCf(
  options: RelayfileWritebackCfBackfillOptions = {},
  deps: RelayfileWritebackCfBackfillDeps = {},
): Promise<RelayfileWritebackCfBackfillSummary> {
  const listCandidates = deps.listCandidates ?? listBackfillCandidates;
  const pushCredential = deps.pushCredential ?? pushRelayfileIntegrationCredential;
  const activateCandidate = deps.activateCandidate ?? activateBackfilledCandidate;
  const now = options.now ?? (() => new Date());
  const dryRun = options.dryRun ?? false;
  const candidates = await listCandidates(options);
  const summary: RelayfileWritebackCfBackfillSummary = {
    dryRun,
    scanned: candidates.length,
    activated: 0,
    resynced: 0,
    skipped: 0,
    failed: 0,
    results: [],
  };

  for (const candidate of candidates) {
    const normalizedProvider = normalizeWritebackProvider(candidate.provider);
    if (!normalizedProvider) {
      summary.skipped += 1;
      summary.results.push({
        status: "skipped_unsupported_provider",
        workspaceId: candidate.workspaceId,
        provider: candidate.provider,
        connectionId: candidate.connectionId,
        reason: "provider does not support Cloudflare writeback dispatch",
      });
      continue;
    }

    const alreadyCf = candidate.writebackDispatchVia === "cf";
    if (dryRun) {
      if (alreadyCf) {
        summary.resynced += 1;
      } else {
        summary.activated += 1;
      }
      summary.results.push({
        status: alreadyCf ? "would_resync" : "would_activate",
        workspaceId: candidate.workspaceId,
        provider: candidate.provider,
        connectionId: candidate.connectionId,
      });
      continue;
    }

    const timestamp = now();
    const pushResult = await pushCredential(
      {
        ...candidate,
        provider: normalizedProvider,
        writebackDispatchVia: "cf",
        updatedAt: timestamp,
      },
      { timeoutMs: options.timeoutMs },
    );
    if (!pushResult.ok) {
      summary.failed += 1;
      summary.results.push({
        status: "failed",
        workspaceId: candidate.workspaceId,
        provider: candidate.provider,
        connectionId: candidate.connectionId,
        error: pushResult.responseSnippet
          ? `${pushResult.error}: ${pushResult.responseSnippet}`
          : pushResult.error,
      });
      continue;
    }

    if (alreadyCf) {
      summary.resynced += 1;
      summary.results.push({
        status: "resynced",
        workspaceId: candidate.workspaceId,
        provider: candidate.provider,
        connectionId: candidate.connectionId,
      });
      continue;
    }

    const activated = await activateCandidate(candidate, timestamp);
    if (!activated) {
      summary.failed += 1;
      summary.results.push({
        status: "failed",
        workspaceId: candidate.workspaceId,
        provider: candidate.provider,
        connectionId: candidate.connectionId,
        error: "workspace integration changed before dispatch flag update",
      });
      continue;
    }

    summary.activated += 1;
    summary.results.push({
      status: "activated",
      workspaceId: candidate.workspaceId,
      provider: candidate.provider,
      connectionId: candidate.connectionId,
    });
  }

  return summary;
}

async function listBackfillCandidates(
  options: RelayfileWritebackCfBackfillOptions,
): Promise<RelayfileWritebackCfBackfillCandidate[]> {
  const conditions = [
    isNull(workspaceIntegrations.name),
    isNotNull(workspaceIntegrations.connectionId),
  ];
  if (options.workspaceId) {
    conditions.push(eq(workspaceIntegrations.workspaceId, options.workspaceId));
  }
  if (options.provider) {
    conditions.push(eq(workspaceIntegrations.provider, options.provider));
  }

  const query = getDb()
    .select()
    .from(workspaceIntegrations)
    .where(and(...conditions))
    .orderBy(
      asc(workspaceIntegrations.workspaceId),
      asc(workspaceIntegrations.provider),
    )
    .$dynamic();

  const records =
    options.limit && options.limit > 0 ? await query.limit(options.limit) : await query;

  return records.map((record) => ({
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    connectionId: record.connectionId ?? "",
    providerConfigKey: record.providerConfigKey ?? null,
    installationId: record.installationId ?? null,
    metadata: parseIntegrationMetadata(record.metadataJson),
    writebackDispatchVia:
      record.writebackDispatchVia === "cf" ? "cf" : "bridge",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
}

async function activateBackfilledCandidate(
  candidate: RelayfileWritebackCfBackfillCandidate,
  now: Date,
): Promise<boolean> {
  const [record] = await getDb()
    .update(workspaceIntegrations)
    .set({
      writebackDispatchVia: "cf",
      updatedAt: now,
    })
    .where(
      and(
        eq(workspaceIntegrations.id, candidate.id),
        eq(workspaceIntegrations.connectionId, candidate.connectionId),
        sql`${workspaceIntegrations.providerConfigKey} IS NOT DISTINCT FROM ${candidate.providerConfigKey}`,
        sql`${workspaceIntegrations.writebackDispatchVia} <> 'cf'`,
      ),
    )
    .returning({ id: workspaceIntegrations.id });

  return Boolean(record);
}
