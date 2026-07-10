import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  getEnabledNangoSyncNamesForProviderConfigKey,
  getNangoSyncScheduleStatuses,
  startNangoSyncSchedules,
} from "./nango-service";

type RawRows<T> = { rows?: T[] };

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray((result as RawRows<T>)?.rows) ? (result as RawRows<T>).rows! : [];
}

type WorkspaceIntegrationScheduleRow = {
  id: string;
  workspace_id: string;
  provider: string;
  connection_id: string;
  provider_config_key: string | null;
};

export type NangoSyncScheduleBackfillCandidate = {
  id: string;
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string | null;
};

export type NangoSyncScheduleBackfillOptions = {
  dryRun?: boolean;
  workspaceId?: string;
  provider?: string;
  limit?: number;
};

export type NangoSyncScheduleBackfillStatus =
  | "started"
  | "would_start"
  | "skipped_no_syncs"
  | "skipped_no_config_key"
  | "failed";

export type NangoSyncScheduleBackfillResult = {
  id: string;
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string | null;
  syncs: string[];
  scheduleStatuses: Array<{ name: string; status: string | null }>;
  status: NangoSyncScheduleBackfillStatus;
  error?: string;
};

export type NangoSyncScheduleBackfillSummary = {
  dryRun: boolean;
  scanned: number;
  started: number;
  skipped: number;
  failed: number;
  results: NangoSyncScheduleBackfillResult[];
};

export type NangoSyncScheduleBackfillDeps = {
  listCandidates?: (
    options: NangoSyncScheduleBackfillOptions,
  ) => Promise<NangoSyncScheduleBackfillCandidate[]>;
  enabledSyncNames?: (providerConfigKey: string) => string[];
  getScheduleStatuses?: typeof getNangoSyncScheduleStatuses;
  startSchedules?: typeof startNangoSyncSchedules;
};

async function listCandidatesFromDb(
  options: NangoSyncScheduleBackfillOptions,
): Promise<NangoSyncScheduleBackfillCandidate[]> {
  const filters = [sql`adapter = 'nango'`, sql`connection_id <> ''`];
  if (options.workspaceId) {
    filters.push(sql`workspace_id = ${options.workspaceId}`);
  }
  if (options.provider) {
    filters.push(sql`provider = ${options.provider}`);
  }
  const where = sql.join(filters, sql` AND `);
  const limit = options.limit && options.limit > 0 ? options.limit : null;
  const result = await getDb().execute(sql`
    SELECT id, workspace_id, provider, connection_id, provider_config_key
    FROM workspace_integrations
    WHERE ${where}
    ORDER BY workspace_id ASC, provider ASC, created_at ASC
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `);
  return rowsOf<WorkspaceIntegrationScheduleRow>(result).map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    provider: row.provider,
    connectionId: row.connection_id,
    providerConfigKey: row.provider_config_key,
  }));
}

/**
 * Start Nango sync schedules for EXISTING workspace integrations.
 *
 * #1857 starts schedules from the OAuth auth webhook, which only covers
 * connections made after it shipped — every earlier connection has no
 * schedule, so Nango never runs its syncs, no sync webhooks arrive, and the
 * provider never materializes in the relayfile workspace even though the
 * dashboard shows it connected (the /github-only symptom; github masks the
 * gap via its app-forward path).
 *
 * Dry-run (the default) is strictly read-only: it lists candidates and
 * fetches current schedule statuses from Nango's /sync/status, but never
 * calls /sync/start. Apply mode calls the same `startNangoSyncSchedules`
 * the auth-webhook path uses; Nango treats starting an already-started
 * sync as a no-op, so re-running is safe.
 */
export async function backfillNangoSyncSchedules(
  options: NangoSyncScheduleBackfillOptions = {},
  deps: NangoSyncScheduleBackfillDeps = {},
): Promise<NangoSyncScheduleBackfillSummary> {
  const dryRun = options.dryRun !== false;
  const listCandidates = deps.listCandidates ?? listCandidatesFromDb;
  const enabledSyncNames =
    deps.enabledSyncNames ?? getEnabledNangoSyncNamesForProviderConfigKey;
  const getScheduleStatuses = deps.getScheduleStatuses ?? getNangoSyncScheduleStatuses;
  const startSchedules = deps.startSchedules ?? startNangoSyncSchedules;

  const candidates = await listCandidates(options);
  const results: NangoSyncScheduleBackfillResult[] = [];

  for (const candidate of candidates) {
    const providerConfigKey = candidate.providerConfigKey?.trim() || null;
    const base = {
      id: candidate.id,
      workspaceId: candidate.workspaceId,
      provider: candidate.provider,
      connectionId: candidate.connectionId,
      providerConfigKey,
    };

    if (!providerConfigKey) {
      results.push({
        ...base,
        syncs: [],
        scheduleStatuses: [],
        status: "skipped_no_config_key",
      });
      continue;
    }

    const syncs = enabledSyncNames(providerConfigKey);
    if (syncs.length === 0) {
      // Providers without generated Nango syncs (e.g. webhook-only) have
      // nothing to schedule — not a failure.
      results.push({
        ...base,
        syncs,
        scheduleStatuses: [],
        status: "skipped_no_syncs",
      });
      continue;
    }

    // Read-only status snapshot for observability in BOTH modes; failures
    // here are recorded but do not block the start attempt (the start is
    // the thing that matters and is independently idempotent).
    let scheduleStatuses: Array<{ name: string; status: string | null }> = [];
    try {
      const statusResult = await getScheduleStatuses({
        providerConfigKey,
        connectionId: candidate.connectionId,
        syncs,
      });
      scheduleStatuses = statusResult.syncs.map((entry) => ({
        name: entry.name,
        status: entry.status,
      }));
    } catch {
      // status snapshot is best-effort
    }

    if (dryRun) {
      results.push({ ...base, syncs, scheduleStatuses, status: "would_start" });
      continue;
    }

    try {
      const startResult = await startSchedules({
        providerConfigKey,
        connectionId: candidate.connectionId,
        syncs,
      });
      if (startResult.ok) {
        results.push({ ...base, syncs, scheduleStatuses, status: "started" });
      } else {
        results.push({
          ...base,
          syncs,
          scheduleStatuses,
          status: "failed",
          error: `Nango /sync/start returned ${startResult.status ?? "unknown"}`,
        });
      }
    } catch (error) {
      results.push({
        ...base,
        syncs,
        scheduleStatuses,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const started = results.filter(
    (entry) => entry.status === "started" || entry.status === "would_start",
  ).length;
  const failed = results.filter((entry) => entry.status === "failed").length;
  return {
    dryRun,
    scanned: results.length,
    started,
    skipped: results.length - started - failed,
    failed,
    results,
  };
}
