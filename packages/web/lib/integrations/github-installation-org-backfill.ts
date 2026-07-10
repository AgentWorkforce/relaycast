import { sql } from "drizzle-orm";

import { getDb } from "@/lib/db";
import { resolveWorkspaceIntegrationIdentity } from "@/lib/workspaces/workspace-integration-identity-core";

type RawRows<T> = { rows?: T[] };

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray((result as RawRows<T>)?.rows) ? (result as RawRows<T>).rows! : [];
}

type CandidateSource = "workspace_integration" | "workspace_link";

type CandidateRow = {
  source: CandidateSource;
  source_id: string;
  workspace_id: string;
  installation_id: string | null;
  connection_id: string | null;
  provider_config_key: string | null;
  updated_at: Date | string | null;
};

type InstallationRow = {
  installation_id: string;
  account_type: string | null;
  connection_id: string | null;
  provider_config_key: string | null;
};

type OrgInstallationRow = {
  organization_id: string;
  installation_id: string;
  is_primary: boolean;
};

export type GithubInstallationOrgBackfillOptions = {
  dryRun?: boolean;
  reportDivergence?: boolean;
  workspaceId?: string;
  limit?: number;
};

export type GithubInstallationOrgBackfillOrphanReason =
  | "missing_installation_id"
  | "missing_connection_id"
  | "missing_organization";

export type GithubInstallationOrgBackfillOrphan = {
  source: CandidateSource;
  sourceId: string;
  workspaceId: string;
  installationId: string | null;
  reason: GithubInstallationOrgBackfillOrphanReason;
};

export type GithubInstallationOrgBackfillSkippedPersonal = {
  source: CandidateSource;
  sourceId: string;
  workspaceId: string;
  installationId: string;
};

export type GithubInstallationOrgBackfillResult = {
  organizationId: string;
  installationId: string;
  workspaceIds: string[];
  sources: CandidateSource[];
  connectionId: string;
  providerConfigKey: string | null;
  isPrimary: boolean;
  status:
    | "inserted"
    | "updated"
    | "existing"
    | "would_insert"
    | "would_update"
    | "would_keep";
};

export type GithubInstallationOrgBackfillConnectionCandidate = {
  source: CandidateSource;
  sourceId: string;
  workspaceId: string;
  connectionId: string;
};

export type GithubInstallationOrgBackfillConnectionDivergence = {
  organizationId: string;
  installationId: string;
  workspaceIds: string[];
  sources: CandidateSource[];
  chosenConnectionId: string;
  connectionIds: string[];
  alternatives: string[];
  candidates: GithubInstallationOrgBackfillConnectionCandidate[];
};

export type GithubInstallationOrgBackfillSummary = {
  dryRun: boolean;
  scanned: number;
  eligible: number;
  inserted: number;
  updated: number;
  existing: number;
  wouldInsert: number;
  wouldUpdate: number;
  wouldKeep: number;
  skippedPersonalInstallations: number;
  orphans: GithubInstallationOrgBackfillOrphan[];
  skippedPersonal: GithubInstallationOrgBackfillSkippedPersonal[];
  connectionDivergences: GithubInstallationOrgBackfillConnectionDivergence[];
  results: GithubInstallationOrgBackfillResult[];
};

type EligibleCandidate = {
  source: CandidateSource;
  sourceId: string;
  workspaceId: string;
  organizationId: string;
  installationId: string;
  connectionId: string;
  providerConfigKey: string | null;
};

type PlannedOrgInstallation = {
  organizationId: string;
  installationId: string;
  workspaceIds: Set<string>;
  sources: Set<CandidateSource>;
  connectionId: string;
  connectionIds: Set<string>;
  connectionCandidates: GithubInstallationOrgBackfillConnectionCandidate[];
  providerConfigKey: string | null;
  isPrimary: boolean;
};

async function listCandidates(
  options: GithubInstallationOrgBackfillOptions,
): Promise<CandidateRow[]> {
  const workspaceFilter = options.workspaceId
    ? sql`AND source_rows.workspace_id = ${options.workspaceId}`
    : sql``;
  const limit = options.limit && options.limit > 0 ? sql`LIMIT ${options.limit}` : sql``;
  const result = await getDb().execute(sql`
    SELECT *
    FROM (
      SELECT
        'workspace_integration'::text AS source,
        id::text AS source_id,
        workspace_id,
        installation_id,
        connection_id,
        provider_config_key,
        updated_at
      FROM workspace_integrations
      WHERE provider = 'github'
      UNION ALL
      SELECT
        'workspace_link'::text AS source,
        id::text AS source_id,
        workspace_id,
        installation_id,
        connection_id,
        provider_config_key,
        updated_at
      FROM workspace_github_installation_links
    ) source_rows
    WHERE true
      ${workspaceFilter}
    ORDER BY source_rows.workspace_id ASC,
      source_rows.installation_id ASC NULLS LAST,
      source_rows.source ASC,
      source_rows.updated_at ASC
    ${limit}
  `);
  return rowsOf<CandidateRow>(result);
}

async function readInstallation(
  installationId: string,
): Promise<InstallationRow | null> {
  const result = await getDb().execute(sql`
    SELECT installation_id, account_type, connection_id, provider_config_key
    FROM github_installations
    WHERE installation_id = ${installationId}
    LIMIT 1
  `);
  return rowsOf<InstallationRow>(result)[0] ?? null;
}

async function listExistingOrgInstallations(
  organizationIds: string[],
): Promise<OrgInstallationRow[]> {
  if (organizationIds.length === 0) return [];
  const ids = sql.join(organizationIds.map((id) => sql`${id}`), sql`, `);
  const result = await getDb().execute(sql`
    SELECT organization_id, installation_id, is_primary
    FROM organization_github_installations
    WHERE organization_id IN (${ids})
  `);
  return rowsOf<OrgInstallationRow>(result);
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function keyFor(organizationId: string, installationId: string): string {
  return `${organizationId}\0${installationId}`;
}

function addEligible(
  planned: Map<string, PlannedOrgInstallation>,
  candidate: EligibleCandidate,
): void {
  const key = keyFor(candidate.organizationId, candidate.installationId);
  const existing = planned.get(key);
  if (existing) {
    existing.workspaceIds.add(candidate.workspaceId);
    existing.sources.add(candidate.source);
    existing.connectionIds.add(candidate.connectionId);
    existing.connectionCandidates.push({
      source: candidate.source,
      sourceId: candidate.sourceId,
      workspaceId: candidate.workspaceId,
      connectionId: candidate.connectionId,
    });
    if (!existing.providerConfigKey && candidate.providerConfigKey) {
      existing.providerConfigKey = candidate.providerConfigKey;
    }
    return;
  }

  planned.set(key, {
    organizationId: candidate.organizationId,
    installationId: candidate.installationId,
    workspaceIds: new Set([candidate.workspaceId]),
    sources: new Set([candidate.source]),
    connectionId: candidate.connectionId,
    connectionIds: new Set([candidate.connectionId]),
    connectionCandidates: [
      {
        source: candidate.source,
        sourceId: candidate.sourceId,
        workspaceId: candidate.workspaceId,
        connectionId: candidate.connectionId,
      },
    ],
    providerConfigKey: candidate.providerConfigKey,
    isPrimary: false,
  });
}

function listConnectionDivergences(
  planned: Map<string, PlannedOrgInstallation>,
): GithubInstallationOrgBackfillConnectionDivergence[] {
  return [...planned.values()]
    .filter((item) => item.connectionIds.size > 1)
    .map((item) => {
      const connectionIds = [...item.connectionIds].sort();
      return {
        organizationId: item.organizationId,
        installationId: item.installationId,
        workspaceIds: [...item.workspaceIds].sort(),
        sources: [...item.sources].sort(),
        chosenConnectionId: item.connectionId,
        connectionIds,
        alternatives: connectionIds.filter((id) => id !== item.connectionId),
        candidates: item.connectionCandidates.map((candidate) => ({ ...candidate })),
      };
    })
    .sort((left, right) =>
      keyFor(left.organizationId, left.installationId).localeCompare(
        keyFor(right.organizationId, right.installationId),
      ),
    );
}

function assignPrimaryInstallations(
  planned: Map<string, PlannedOrgInstallation>,
  existingRows: OrgInstallationRow[],
): Map<string, OrgInstallationRow> {
  const existingByKey = new Map(
    existingRows.map((row) => [keyFor(row.organization_id, row.installation_id), row]),
  );
  const orgsWithPrimary = new Set(
    existingRows
      .filter((row) => row.is_primary)
      .map((row) => row.organization_id),
  );
  const candidatesByOrg = new Map<string, PlannedOrgInstallation[]>();
  for (const item of planned.values()) {
    const existing = existingByKey.get(keyFor(item.organizationId, item.installationId));
    if (existing) {
      item.isPrimary = existing.is_primary;
      continue;
    }
    if (orgsWithPrimary.has(item.organizationId)) {
      item.isPrimary = false;
      continue;
    }
    const entries = candidatesByOrg.get(item.organizationId) ?? [];
    entries.push(item);
    candidatesByOrg.set(item.organizationId, entries);
  }

  for (const entries of candidatesByOrg.values()) {
    entries.sort((left, right) =>
      left.installationId.localeCompare(right.installationId),
    );
    const primary = entries[0];
    if (primary) primary.isPrimary = true;
  }

  return existingByKey;
}

async function ensureGithubInstallationConnection(
  item: PlannedOrgInstallation,
  dryRun: boolean,
): Promise<"inserted" | "updated" | "existing" | "would_insert" | "would_update" | "would_keep"> {
  const existing = await readInstallation(item.installationId);
  const needsInsert = !existing;
  const needsConnection = !trimToNull(existing?.connection_id);
  const needsProviderConfigKey =
    Boolean(item.providerConfigKey) && !trimToNull(existing?.provider_config_key);

  if (dryRun) {
    if (needsInsert) return "would_insert";
    if (needsConnection || needsProviderConfigKey) return "would_update";
    return "would_keep";
  }

  if (needsInsert) {
    await getDb().execute(sql`
      INSERT INTO github_installations (
        installation_id,
        account_type,
        provider_config_key,
        connection_id,
        metadata_json,
        created_at,
        updated_at
      )
      VALUES (
        ${item.installationId},
        'unknown',
        ${item.providerConfigKey},
        ${item.connectionId},
        '{}'::jsonb,
        now(),
        now()
      )
      ON CONFLICT (installation_id) DO NOTHING
    `);
    return "inserted";
  }

  if (needsConnection || needsProviderConfigKey) {
    await getDb().execute(sql`
      UPDATE github_installations
      SET
        connection_id = COALESCE(connection_id, ${item.connectionId}),
        provider_config_key = COALESCE(provider_config_key, ${item.providerConfigKey}),
        updated_at = now()
      WHERE installation_id = ${item.installationId}
        AND (
          connection_id IS NULL
          OR (${item.providerConfigKey}::text IS NOT NULL AND provider_config_key IS NULL)
        )
    `);
    return "updated";
  }

  return "existing";
}

async function upsertOrgInstallation(
  item: PlannedOrgInstallation,
  existingByKey: Map<string, OrgInstallationRow>,
  dryRun: boolean,
): Promise<GithubInstallationOrgBackfillResult["status"]> {
  const existing = existingByKey.get(keyFor(item.organizationId, item.installationId));
  const needsInsert = !existing;
  const needsPrimaryUpdate = Boolean(existing && item.isPrimary && !existing.is_primary);

  if (dryRun) {
    if (needsInsert) return "would_insert";
    if (needsPrimaryUpdate) return "would_update";
    return "would_keep";
  }

  if (needsInsert) {
    await getDb().execute(sql`
      INSERT INTO organization_github_installations (
        organization_id,
        installation_id,
        is_primary,
        created_at,
        updated_at
      )
      VALUES (
        ${item.organizationId},
        ${item.installationId},
        ${item.isPrimary},
        now(),
        now()
      )
      ON CONFLICT (organization_id, installation_id) DO NOTHING
    `);
    return "inserted";
  }

  if (needsPrimaryUpdate) {
    await getDb().execute(sql`
      UPDATE organization_github_installations
      SET is_primary = true, updated_at = now()
      WHERE organization_id = ${item.organizationId}
        AND installation_id = ${item.installationId}
        AND is_primary = false
    `);
    return "updated";
  }

  return "existing";
}

function incrementStatus(
  summary: GithubInstallationOrgBackfillSummary,
  status: GithubInstallationOrgBackfillResult["status"],
): void {
  if (status === "inserted") summary.inserted += 1;
  if (status === "updated") summary.updated += 1;
  if (status === "existing") summary.existing += 1;
  if (status === "would_insert") summary.wouldInsert += 1;
  if (status === "would_update") summary.wouldUpdate += 1;
  if (status === "would_keep") summary.wouldKeep += 1;
}

export async function backfillGithubInstallationOrgOwnership(
  options: GithubInstallationOrgBackfillOptions = {},
): Promise<GithubInstallationOrgBackfillSummary> {
  const dryRun = options.reportDivergence ? true : options.dryRun !== false;
  const candidates = await listCandidates(options);
  const summary: GithubInstallationOrgBackfillSummary = {
    dryRun,
    scanned: candidates.length,
    eligible: 0,
    inserted: 0,
    updated: 0,
    existing: 0,
    wouldInsert: 0,
    wouldUpdate: 0,
    wouldKeep: 0,
    skippedPersonalInstallations: 0,
    orphans: [],
    skippedPersonal: [],
    connectionDivergences: [],
    results: [],
  };

  const planned = new Map<string, PlannedOrgInstallation>();

  for (const row of candidates) {
    const installationId = trimToNull(row.installation_id);
    if (!installationId) {
      summary.orphans.push({
        source: row.source,
        sourceId: row.source_id,
        workspaceId: row.workspace_id,
        installationId: null,
        reason: "missing_installation_id",
      });
      continue;
    }

    const installation = await readInstallation(installationId);
    if (installation?.account_type === "User") {
      summary.skippedPersonalInstallations += 1;
      summary.skippedPersonal.push({
        source: row.source,
        sourceId: row.source_id,
        workspaceId: row.workspace_id,
        installationId,
      });
      continue;
    }

    const connectionId =
      trimToNull(row.connection_id) ?? trimToNull(installation?.connection_id);
    if (!connectionId) {
      summary.orphans.push({
        source: row.source,
        sourceId: row.source_id,
        workspaceId: row.workspace_id,
        installationId,
        reason: "missing_connection_id",
      });
      continue;
    }

    const identity = await resolveWorkspaceIntegrationIdentity(row.workspace_id);
    if (!identity.organizationId) {
      summary.orphans.push({
        source: row.source,
        sourceId: row.source_id,
        workspaceId: row.workspace_id,
        installationId,
        reason: "missing_organization",
      });
      continue;
    }

    addEligible(planned, {
      source: row.source,
      sourceId: row.source_id,
      workspaceId: row.workspace_id,
      organizationId: identity.organizationId,
      installationId,
      connectionId,
      providerConfigKey:
        trimToNull(row.provider_config_key) ??
        trimToNull(installation?.provider_config_key),
    });
  }

  summary.eligible = planned.size;
  if (options.reportDivergence) {
    summary.connectionDivergences = listConnectionDivergences(planned);
  }
  const organizationIds = [...new Set([...planned.values()].map((item) => item.organizationId))];
  const existingByKey = assignPrimaryInstallations(
    planned,
    await listExistingOrgInstallations(organizationIds),
  );

  for (const item of [...planned.values()].sort((left, right) =>
    keyFor(left.organizationId, left.installationId).localeCompare(
      keyFor(right.organizationId, right.installationId),
    ),
  )) {
    const installStatus = await ensureGithubInstallationConnection(item, dryRun);
    const orgStatus = await upsertOrgInstallation(item, existingByKey, dryRun);
    const status =
      orgStatus === "existing" || orgStatus === "would_keep" ? installStatus : orgStatus;
    incrementStatus(summary, status);
    summary.results.push({
      organizationId: item.organizationId,
      installationId: item.installationId,
      workspaceIds: [...item.workspaceIds].sort(),
      sources: [...item.sources].sort(),
      connectionId: item.connectionId,
      providerConfigKey: item.providerConfigKey,
      isPrimary: item.isPrimary,
      status,
    });
  }

  return summary;
}
