import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import {
  isAppWorkspaceId,
  isRelayWorkspaceId,
  readBoundRelayWorkspaceId,
} from "@/lib/workspaces/relay-workspace-binding";

type RawRows<T> = { rows?: T[] };

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray((result as RawRows<T>)?.rows) ? (result as RawRows<T>).rows! : [];
}

type WorkspaceIntegrationAuditRow = {
  id: string;
  workspace_id: string;
  provider: string;
  adapter: string;
  connection_id: string;
  provider_config_key: string | null;
  created_at: string | Date;
};

export type RowIdShape = "relay" | "app_uuid" | "other";

export type WorkspaceIntegrationRowAuditEntry = {
  id: string;
  provider: string;
  adapter: string;
  connectionId: string;
  providerConfigKey: string | null;
  workspaceId: string;
  idShape: RowIdShape;
  // The relay workspace the #1910 enqueue translation resolves for this row
  // (identity for relay-shaped ids, bound workspace for app UUIDs, null when
  // an app UUID has no binding). This is the workspace sync records actually
  // land in post-#1910 — including it turns the audit into post-deploy
  // verification evidence.
  boundRelayWorkspaceId: string | null;
  // Pre-#1910, syncs wrote into a workspace named by the RAW id; rows where
  // the raw id differs from the bound relay workspace had their sync data
  // landing somewhere nobody mounts.
  syncTargetMismatch: boolean;
  createdAt: string;
};

export type WorkspaceIntegrationRowAuditOptions = {
  workspaceId?: string;
  provider?: string;
  limit?: number;
};

export type WorkspaceIntegrationRowAuditSummary = {
  scanned: number;
  relayShaped: number;
  appUuidShaped: number;
  otherShaped: number;
  mismatched: number;
  unbound: number;
  entries: WorkspaceIntegrationRowAuditEntry[];
};

export type WorkspaceIntegrationRowAuditDeps = {
  listRows?: (
    options: WorkspaceIntegrationRowAuditOptions,
  ) => Promise<WorkspaceIntegrationAuditRow[]>;
  readBoundRelayWorkspace?: (appWorkspaceId: string) => Promise<string | null>;
};

async function listRowsFromDb(
  options: WorkspaceIntegrationRowAuditOptions,
): Promise<WorkspaceIntegrationAuditRow[]> {
  const filters = [sql`1 = 1`];
  if (options.workspaceId) {
    filters.push(sql`workspace_id = ${options.workspaceId}`);
  }
  if (options.provider) {
    filters.push(sql`provider = ${options.provider}`);
  }
  const where = sql.join(filters, sql` AND `);
  const limit = options.limit && options.limit > 0 ? options.limit : null;
  const result = await getDb().execute(sql`
    SELECT id, workspace_id, provider, adapter, connection_id, provider_config_key, created_at
    FROM workspace_integrations
    WHERE ${where}
    ORDER BY workspace_id ASC, provider ASC, created_at ASC
    ${limit ? sql`LIMIT ${limit}` : sql``}
  `);
  return rowsOf<WorkspaceIntegrationAuditRow>(result);
}

function classify(workspaceId: string): RowIdShape {
  if (isRelayWorkspaceId(workspaceId)) return "relay";
  if (isAppWorkspaceId(workspaceId)) return "app_uuid";
  return "other";
}

/**
 * Read-only audit of `workspace_integrations.workspace_id` shapes.
 *
 * Context (#1910): legacy rows store the cloud workspace UUID while
 * relayfile mounts are keyed by the bound `rw_` id; pre-#1910 every sync for
 * such a row wrote records into a UUID-named workspace nobody mounts. This
 * audit reports, per row: the id shape, the relay workspace the enqueue
 * translation now resolves, and whether the pre-#1910 sync target differed
 * (= historical data stranded in the raw-id workspace). It also surfaces
 * app-UUID rows with NO binding (translation falls through to the raw id —
 * still unmounted, needs a binding or row repair).
 *
 * Strictly read-only: two SELECT shapes (rows + per-UUID binding lookups),
 * no writes; repair is a separate decision once this report exists.
 */
export async function auditWorkspaceIntegrationRows(
  options: WorkspaceIntegrationRowAuditOptions = {},
  deps: WorkspaceIntegrationRowAuditDeps = {},
): Promise<WorkspaceIntegrationRowAuditSummary> {
  const listRows = deps.listRows ?? listRowsFromDb;
  const readBinding = deps.readBoundRelayWorkspace ?? readBoundRelayWorkspaceId;

  const rows = await listRows(options);
  const bindingCache = new Map<string, string | null>();
  const entries: WorkspaceIntegrationRowAuditEntry[] = [];

  for (const row of rows) {
    const workspaceId = row.workspace_id.trim();
    const idShape = classify(workspaceId);

    let boundRelayWorkspaceId: string | null = null;
    if (idShape === "relay") {
      boundRelayWorkspaceId = workspaceId;
    } else if (idShape === "app_uuid") {
      if (!bindingCache.has(workspaceId)) {
        try {
          bindingCache.set(workspaceId, await readBinding(workspaceId));
        } catch {
          // Read-only audit: a binding lookup failure reads as unbound
          // rather than aborting the report.
          bindingCache.set(workspaceId, null);
        }
      }
      boundRelayWorkspaceId = bindingCache.get(workspaceId) ?? null;
    }

    entries.push({
      id: row.id,
      provider: row.provider,
      adapter: row.adapter,
      connectionId: row.connection_id,
      providerConfigKey: row.provider_config_key,
      workspaceId,
      idShape,
      boundRelayWorkspaceId,
      syncTargetMismatch:
        boundRelayWorkspaceId !== null && boundRelayWorkspaceId !== workspaceId,
      createdAt:
        row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
    });
  }

  return {
    scanned: entries.length,
    relayShaped: entries.filter((entry) => entry.idShape === "relay").length,
    appUuidShaped: entries.filter((entry) => entry.idShape === "app_uuid").length,
    otherShaped: entries.filter((entry) => entry.idShape === "other").length,
    mismatched: entries.filter((entry) => entry.syncTargetMismatch).length,
    unbound: entries.filter(
      (entry) => entry.idShape === "app_uuid" && entry.boundRelayWorkspaceId === null,
    ).length,
    entries,
  };
}
