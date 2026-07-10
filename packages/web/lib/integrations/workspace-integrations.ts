import { and, asc, desc, eq, gt, inArray, isNull, like, or, sql } from "drizzle-orm";
import {
  parseIntegrationMetadata,
  preserveProviderReadiness,
} from "@cloud/core/provider-readiness.js";
import { getDb } from "../db";
import {
  workspaceIntegrationDisconnects,
  workspaceIntegrations,
} from "../db/schema";
import { getProviderAliasNames, type WorkspaceIntegrationProvider } from "./providers";
import { logNangoDbWorkspaceDiagnostic } from "./nango-db-workspace-diagnostic";
import {
  extractSlackConnectionIdentityFromMetadata,
  metadataMatchesSlackTeamId,
} from "./slack-identity";
import { pushRelayfileIntegrationCredential } from "./relayfile-integration-push";
export type { WorkspaceIntegrationProvider } from "./providers";

export type WorkspaceIntegrationRecord = {
  id: string;
  workspaceId: string;
  provider: string;
  name?: string | null;
  connectionId: string;
  providerConfigKey: string | null;
  installationId: string | null;
  metadata: Record<string, unknown>;
  writebackDispatchVia?: "bridge" | "cf";
  createdAt: Date;
  updatedAt: Date;
};

export type WorkspaceIntegrationDisconnectRecord = {
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey: string | null;
  disconnectedAt: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type WorkspaceIntegrationProviderAlias =
  | WorkspaceIntegrationProvider
  | "slack";

function parseMetadata(raw: string): Record<string, unknown> {
  return parseIntegrationMetadata(raw);
}

function mapRecord(record: typeof workspaceIntegrations.$inferSelect): WorkspaceIntegrationRecord {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    provider: record.provider,
    name: record.name ?? null,
    connectionId: record.connectionId ?? "",
    providerConfigKey: record.providerConfigKey ?? null,
    installationId: record.installationId ?? null,
    metadata: parseMetadata(record.metadataJson),
    writebackDispatchVia:
      record.writebackDispatchVia === "cf" ? "cf" : "bridge",
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mapDisconnectRecord(
  record: typeof workspaceIntegrationDisconnects.$inferSelect,
): WorkspaceIntegrationDisconnectRecord {
  return {
    workspaceId: record.workspaceId,
    provider: record.provider,
    connectionId: record.connectionId,
    providerConfigKey: record.providerConfigKey ?? null,
    disconnectedAt: record.disconnectedAt,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function getWorkspaceIntegration(
  workspaceId: string,
  provider: string,
): Promise<WorkspaceIntegrationRecord | null> {
  return getWorkspaceIntegrationByName(workspaceId, provider, null);
}

export async function getWorkspaceIntegrationByName(
  workspaceId: string,
  provider: string,
  name: string | null,
): Promise<WorkspaceIntegrationRecord | null> {
  // Resolve canonical-or-alias names so a persona that refers to
  // `github` finds a workspace row stored as `github-app-oauth` (and
  // vice versa). Without this the deploy 400s on a real mismatch
  // between the persona-side semantic name and the cloud-side Nango
  // adapter name. See cloud#1327.
  const providerNames = getProviderAliasNames(provider);
  const db = getDb();
  const providerPredicate =
    providerNames.length <= 1
      ? eq(workspaceIntegrations.provider, providerNames[0] ?? provider)
      : inArray(workspaceIntegrations.provider, providerNames);
  const [record] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        providerPredicate,
        name === null
          ? isNull(workspaceIntegrations.name)
          : eq(workspaceIntegrations.name, name),
      ),
    )
    .limit(1);

  return record ? mapRecord(record) : null;
}

export async function listWorkspaceIntegrations(
  workspaceId: string,
): Promise<WorkspaceIntegrationRecord[]> {
  const db = getDb();
  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(eq(workspaceIntegrations.workspaceId, workspaceId))
    .orderBy(asc(workspaceIntegrations.provider));
  return records.map(mapRecord);
}

export async function listWorkspaceIntegrationWorkspaceIds(
  provider: WorkspaceIntegrationProvider,
): Promise<string[]> {
  // PK is (workspace_id, provider), so this query can't return duplicates.
  const db = getDb();
  const records = await db
    .select({ workspaceId: workspaceIntegrations.workspaceId })
    .from(workspaceIntegrations)
    .where(eq(workspaceIntegrations.provider, provider))
    .orderBy(asc(workspaceIntegrations.workspaceId));
  return records.map((record) => record.workspaceId);
}

export async function getWorkspaceIntegrationByProviderAlias(
  workspaceId: string,
  provider: WorkspaceIntegrationProviderAlias,
): Promise<WorkspaceIntegrationRecord | null> {
  // The "slack" and "github" aliases match any provider row whose
  // value starts with that prefix. Slack already has a fan-out across
  // workspace-suffixed providers (`slack`, `slack-my-senior-dev`,
  // `slack-ricky`, …); GitHub will eventually grow the same shape
  // (`github-ricky`, …) once a workspace can have more than one
  // GitHub App connection. Today the literal `"github"` and `"slack"`
  // rows also match because `github%` / `slack%` includes those.
  if (provider === "slack" || provider === "github") {
    const records = await listWorkspaceIntegrationsByProviderAlias(workspaceId, provider);
    return records[0] ?? null;
  }

  return getWorkspaceIntegration(workspaceId, provider);
}

// Return every workspace integration row matching a provider alias,
// ordered most-recently-updated first. Callers that need to fan out
// across multiple connections (e.g. probe each github-* App install
// to see which one can reach a given repo) consume this directly;
// `getWorkspaceIntegrationByProviderAlias` is the convenience wrapper
// that just picks the first.
export async function listWorkspaceIntegrationsByProviderAlias(
  workspaceId: string,
  provider: WorkspaceIntegrationProviderAlias,
): Promise<WorkspaceIntegrationRecord[]> {
  if (provider !== "slack" && provider !== "github") {
    const single = await getWorkspaceIntegration(workspaceId, provider);
    return single ? [single] : [];
  }

  const db = getDb();
  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        like(workspaceIntegrations.provider, `${provider}%`),
      ),
    )
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(10);

  return records.map(mapRecord);
}

export async function findWorkspaceIntegrationByInstallation(
  provider: WorkspaceIntegrationProvider,
  installationId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const db = getDb();
  const [record] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.provider, provider),
        eq(workspaceIntegrations.installationId, installationId),
      ),
    )
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(1);

  return record ? mapRecord(record) : null;
}

export async function findAllWorkspaceIntegrationsByInstallation(
  provider: WorkspaceIntegrationProvider,
  installationId: string,
): Promise<WorkspaceIntegrationRecord[]> {
  const db = getDb();
  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.provider, provider),
        eq(workspaceIntegrations.installationId, installationId),
      ),
    )
    .orderBy(desc(workspaceIntegrations.updatedAt));

  return records.map(mapRecord);
}

// Find the github-family integration row that owns a specific
// installationId. Used by mintInstallationToken so we route Nango
// proxy calls through the correct connection when a workspace has
// multiple GitHub Apps (`github`, `github-ricky`, …) connected.
//
// `(workspaceId, installationId, provider LIKE 'github%')` is not a
// unique tuple — two github-family rows could in principle share an
// installationId (same App reinstalled under a different alias, or
// hand-edited rows). Order by `updatedAt DESC` so the most-recently
// refreshed connection wins deterministically; falling back on
// insertion order would route through whichever row Postgres surfaces
// first, which can be a stale connectionId.
export async function findWorkspaceGithubIntegrationByInstallation(
  workspaceId: string,
  installationId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const db = getDb();
  const [record] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.installationId, installationId),
        like(workspaceIntegrations.provider, "github%"),
      ),
    )
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(1);

  return record ? mapRecord(record) : null;
}

const SLACK_TEAM_ID_PATTERN = /^[TE][A-Z0-9]{6,}$/;

export function looksLikeSlackTeamId(value: string): boolean {
  return SLACK_TEAM_ID_PATTERN.test(value.trim());
}

/**
 * Find a Slack workspace integration by the Slack team id stored in its
 * metadata. Sage identifies workspaces by the Slack `team.id` from incoming
 * events and has no knowledge of cloud workspace UUIDs, so cloud has to do
 * the translation on its behalf.
 *
 * Slack team ids are unique and have a fixed shape (`T...` or `E...` for
 * Enterprise Grid), so a substring search on the serialized metadata json
 * is safe in practice. We still scope the query to slack-* providers so a
 * stray match in an unrelated integration can't win.
 */
export async function findSlackIntegrationByTeamId(
  teamId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const trimmed = teamId.trim();
  if (!trimmed) {
    return null;
  }

  const db = getDb();
  const pattern = `%"${trimmed}"%`;
  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        // Match the canonical post-rename id `slack` AND any legacy
        // `slack-*` row (slack-ricky, slack-my-senior-dev, etc.). The
        // `like` alone misses the canonical row produced by migration
        // 0034.
        or(
          eq(workspaceIntegrations.provider, "slack"),
          like(workspaceIntegrations.provider, "slack-%"),
        ),
        like(workspaceIntegrations.metadataJson, pattern),
      ),
    )
    .limit(10);

  const mapped = records.map(mapRecord);
  return mapped.find((record) => metadataMatchesSlackTeamId(record.metadata, trimmed)) ?? mapped[0] ?? null;
}

export type SlackWorkspaceSummary = {
  workspaceId: string;
  slackTeamId: string | null;
};

/**
 * List every workspace that has an active slack-* integration, collapsed
 * to one row per workspace. Sage calls this to fan out proactive work
 * across every tenant with Slack connected. A workspace with multiple
 * slack-* rows (e.g. slack-bot + slack-user) is returned once, preferring
 * a row whose metadata yielded a usable team id.
 */
export async function listSlackWorkspaceSummaries(): Promise<SlackWorkspaceSummary[]> {
  const db = getDb();
  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      // Include the canonical post-rename `slack` row plus any legacy
      // `slack-*` variants. Pre-rename this was just `like 'slack-%'`.
      or(
        eq(workspaceIntegrations.provider, "slack"),
        like(workspaceIntegrations.provider, "slack-%"),
      ),
    )
    .orderBy(asc(workspaceIntegrations.workspaceId), desc(workspaceIntegrations.updatedAt));

  const byWorkspace = new Map<string, SlackWorkspaceSummary>();
  for (const record of records) {
    const metadata = parseMetadata(record.metadataJson);
    const { teamId } = extractSlackConnectionIdentityFromMetadata(metadata);
    const existing = byWorkspace.get(record.workspaceId);
    if (!existing || (!existing.slackTeamId && teamId)) {
      byWorkspace.set(record.workspaceId, {
        workspaceId: record.workspaceId,
        slackTeamId: teamId,
      });
    }
  }

  return [...byWorkspace.values()];
}

export async function findSlackIntegrationByConnectionId(
  connectionId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const trimmed = connectionId.trim();
  if (!trimmed) {
    return null;
  }

  const db = getDb();
  const [record] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        // Include the canonical post-rename `slack` row plus any legacy
        // `slack-*` variants.
        or(
          eq(workspaceIntegrations.provider, "slack"),
          like(workspaceIntegrations.provider, "slack-%"),
        ),
        eq(workspaceIntegrations.connectionId, trimmed),
      ),
    )
    .limit(1);

  return record ? mapRecord(record) : null;
}

export async function findWorkspaceIntegrationByConnection(
  provider: WorkspaceIntegrationProvider,
  connectionId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  try {
    const db = getDb();
    const [record] = await db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.provider, provider),
          eq(workspaceIntegrations.connectionId, connectionId),
        ),
      )
      .limit(1);

    return record ? mapRecord(record) : null;
  } catch (error) {
    logNangoDbWorkspaceDiagnostic({
      callsite: "findWorkspaceIntegrationByConnection",
      phase: "query",
      error,
      provider,
      connectionId,
    });
    throw error;
  }
}

export async function findWorkspaceIntegrationByProviderAliasAndConnection(
  provider: WorkspaceIntegrationProvider,
  connectionId: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const trimmedConnectionId = connectionId.trim();
  if (!trimmedConnectionId) {
    return null;
  }

  try {
    const providerNames = getProviderAliasNames(provider);
    const providerPredicate =
      provider === "slack" || provider === "github"
        ? like(workspaceIntegrations.provider, `${provider}%`)
        : providerNames.length <= 1
          ? eq(workspaceIntegrations.provider, providerNames[0] ?? provider)
          : inArray(workspaceIntegrations.provider, providerNames);
    const db = getDb();
    const [record] = await db
      .select()
      .from(workspaceIntegrations)
      .where(
        and(
          providerPredicate,
          eq(workspaceIntegrations.connectionId, trimmedConnectionId),
        ),
      )
      .orderBy(desc(workspaceIntegrations.updatedAt))
      .limit(1);

    return record ? mapRecord(record) : null;
  } catch (error) {
    logNangoDbWorkspaceDiagnostic({
      callsite: "findWorkspaceIntegrationByProviderAliasAndConnection",
      phase: "query",
      error,
      provider,
      connectionId,
    });
    throw error;
  }
}

export async function listWorkspaceIntegrationsForProvider(
  provider: WorkspaceIntegrationProvider,
): Promise<WorkspaceIntegrationRecord[]> {
  const db = getDb();
  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(eq(workspaceIntegrations.provider, provider))
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(100);

  return records.map(mapRecord);
}

export async function listAllWorkspaceIntegrationsForProvider(
  provider: WorkspaceIntegrationProvider,
): Promise<WorkspaceIntegrationRecord[]> {
  const db = getDb();
  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(eq(workspaceIntegrations.provider, provider))
    .orderBy(desc(workspaceIntegrations.updatedAt));

  return records.map(mapRecord);
}

export async function findWorkspaceIntegrationByProviderMetadataValue(
  provider: WorkspaceIntegrationProvider,
  metadataKeys: readonly string[],
  value: string,
): Promise<WorkspaceIntegrationRecord | null> {
  const trimmed = value.trim();
  if (!trimmed || metadataKeys.length === 0) {
    return null;
  }

  const db = getDb();
  const encodedValue = JSON.stringify(trimmed);
  const predicates = metadataKeys.map((key) =>
    like(workspaceIntegrations.metadataJson, `%\"${key}\":${encodedValue}%`),
  );

  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.provider, provider),
        or(...predicates),
      ),
    )
    .orderBy(desc(workspaceIntegrations.updatedAt));

  for (const record of records.map(mapRecord)) {
    for (const key of metadataKeys) {
      if (typeof record.metadata[key] === "string" && record.metadata[key] === trimmed) {
        return record;
      }
    }
  }

  return null;
}

export async function findGitLabIntegrationByProjectWebhookToken(
  projectId: string,
  token: string,
  compareSecret: (left: string, right: string) => boolean,
): Promise<WorkspaceIntegrationRecord | null> {
  const trimmedProjectId = projectId.trim();
  const trimmedToken = token.trim();
  if (!trimmedProjectId || !trimmedToken) {
    return null;
  }

  const db = getDb();
  const records = await db
    .select()
    .from(workspaceIntegrations)
    .where(eq(workspaceIntegrations.provider, "gitlab"))
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(100);

  for (const record of records.map(mapRecord)) {
    if (
      gitLabIntegrationMetadataMatchesProjectToken(
        record.metadata,
        trimmedProjectId,
        trimmedToken,
        compareSecret,
      )
    ) {
      return record;
    }
  }

  return null;
}

export function gitLabIntegrationMetadataMatchesProjectToken(
  metadata: Record<string, unknown>,
  projectId: string,
  token: string,
  compareSecret: (left: string, right: string) => boolean,
): boolean {
  return (
    gitLabMetadataIncludesProject(metadata, projectId) &&
    gitLabMetadataTokenMatches(metadata, projectId, token, compareSecret)
  );
}

function gitLabMetadataIncludesProject(
  metadata: Record<string, unknown>,
  projectId: string,
): boolean {
  const ids = metadata.projectIds;
  if (Array.isArray(ids) && ids.some((id) => String(id) === projectId)) {
    return true;
  }

  const projects = metadata.projects;
  return Array.isArray(projects) && projects.some((project) => {
    if (!project || typeof project !== "object") {
      return false;
    }
    const id = (project as Record<string, unknown>).id;
    return String(id) === projectId;
  });
}

function gitLabMetadataTokenMatches(
  metadata: Record<string, unknown>,
  projectId: string,
  token: string,
  compareSecret: (left: string, right: string) => boolean,
): boolean {
  const subscriptions = metadata.webhookSubscriptions;
  if (Array.isArray(subscriptions)) {
    for (const subscription of subscriptions) {
      if (!subscription || typeof subscription !== "object") {
        continue;
      }
      const record = subscription as Record<string, unknown>;
      if (
        String(record.project_id) === projectId &&
        typeof record.secret === "string" &&
        compareSecret(record.secret, token)
      ) {
        return true;
      }
    }
  }

  return typeof metadata.webhookSecret === "string" &&
    compareSecret(metadata.webhookSecret, token);
}

export type UpsertWorkspaceIntegrationInput = {
  workspaceId: string;
  provider: string;
  name?: string | null;
  connectionId: string;
  providerConfigKey?: string | null;
  installationId?: string | null;
  metadata?: Record<string, unknown>;
  writebackDispatchVia?: "bridge" | "cf";
};

const WORKSPACE_INTEGRATION_DISCONNECT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function recordWorkspaceIntegrationDisconnect(input: {
  workspaceId: string;
  provider: string;
  connectionId: string;
  providerConfigKey?: string | null;
  disconnectedAt?: Date;
  expiresAt?: Date;
}): Promise<WorkspaceIntegrationDisconnectRecord> {
  const db = getDb();
  const timestamp = input.disconnectedAt ?? new Date();
  const expiresAt =
    input.expiresAt ??
    new Date(timestamp.getTime() + WORKSPACE_INTEGRATION_DISCONNECT_TTL_MS);

  const [record] = await db
    .insert(workspaceIntegrationDisconnects)
    .values({
      workspaceId: input.workspaceId,
      provider: input.provider,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey ?? null,
      disconnectedAt: timestamp,
      expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [
        workspaceIntegrationDisconnects.workspaceId,
        workspaceIntegrationDisconnects.provider,
        workspaceIntegrationDisconnects.connectionId,
      ],
      set: {
        providerConfigKey: input.providerConfigKey ?? null,
        disconnectedAt: timestamp,
        expiresAt,
        updatedAt: timestamp,
      },
    })
    .returning();

  return mapDisconnectRecord(record);
}

export async function getRecentWorkspaceIntegrationDisconnect(input: {
  workspaceId: string;
  provider: string;
  connectionId: string;
  now?: Date;
}): Promise<WorkspaceIntegrationDisconnectRecord | null> {
  const db = getDb();
  const now = input.now ?? new Date();
  const [record] = await db
    .select()
    .from(workspaceIntegrationDisconnects)
    .where(
      and(
        eq(workspaceIntegrationDisconnects.workspaceId, input.workspaceId),
        eq(workspaceIntegrationDisconnects.provider, input.provider),
        eq(workspaceIntegrationDisconnects.connectionId, input.connectionId),
        gt(workspaceIntegrationDisconnects.expiresAt, now),
      ),
    )
    .limit(1);

  return record ? mapDisconnectRecord(record) : null;
}

/**
 * Atomic insert: writes a row for (workspaceId, provider) only if no row
 * already exists. Returns `{ inserted: true }` if the insert happened, or
 * `{ inserted: false, existing }` if a row was already present at the
 * time the INSERT executed.
 *
 * Use this for placeholder rows seeded from the CLI connect-link or
 * self-heal paths — they must not overwrite a real row created
 * concurrently by the auth webhook. A read-then-upsert leaves a window
 * where the auth webhook can write the real `(workspaceId, provider)`
 * row between the existence check and the upsert, after which the
 * upsert's conflict-update path clobbers the live connectionId,
 * installationId, and readiness blob with the placeholder values. This
 * helper closes that window by pushing the insert-if-absent decision
 * down to the database via `INSERT ... ON CONFLICT DO NOTHING`.
 */
export async function insertWorkspaceIntegrationIfAbsent(
  input: UpsertWorkspaceIntegrationInput,
): Promise<{ inserted: boolean; existing?: WorkspaceIntegrationRecord }> {
  const db = getDb();
  const timestamp = new Date();
  // Don't merge readiness here: a true insert is a fresh row (no prior
  // metadata to preserve) and a conflict means we never write at all.
  const metadata = input.metadata ?? {};

  const inserted = await db
    .insert(workspaceIntegrations)
    .values({
      workspaceId: input.workspaceId,
      provider: input.provider,
      name: input.name ?? null,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey ?? null,
      installationId: input.installationId ?? null,
      metadataJson: JSON.stringify(metadata),
      writebackDispatchVia: input.writebackDispatchVia ?? "bridge",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    // No-target ON CONFLICT DO NOTHING. We intentionally do NOT pin a
    // target/predicate here. A targeted partial-index conflict spec
    // (`ON CONFLICT (workspace_id, provider) WHERE name IS NULL`) requires
    // Postgres to match the inference predicate against a partial unique
    // index's stored predicate. Drizzle emits the predicate table-qualified
    // (`"workspace_integrations"."name" IS NULL`) while the index was created
    // with an unqualified predicate (`"name" IS NULL`), and that mismatch can
    // make Postgres reject the spec with 42P10 ("no unique or exclusion
    // constraint matching the ON CONFLICT specification") — a hard 500 even
    // when no conflicting row exists. The bare form swallows ANY constraint
    // violation (workspaceProviderDefaultUnique, workspaceProviderNameUnique,
    // AND providerConnectionUnique), which is exactly the insert-if-absent
    // semantics this helper promises; the conflict path below re-reads the
    // live row regardless of which constraint fired.
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    const record = await getWorkspaceIntegrationByName(
      input.workspaceId,
      input.provider,
      input.name ?? null,
    );
    if (record) {
      // Fire-and-forget: the wrapper already swallows errors, and awaiting
      // here would block the integration write for up to the 5s relayfile
      // timeout. DO state is eventually consistent with this DB row.
      void pushRelayfileIntegrationCredentialBestEffort(record);
    }
    return { inserted: true };
  }

  // Conflict path: another writer already owns this (workspaceId, provider).
  // Fetch the live row so callers can inspect its connectionId for bail-out
  // logic (self-heal still needs to know whether the existing connection
  // matches the one the webhook is replaying).
  const existing = await getWorkspaceIntegrationByName(
    input.workspaceId,
    input.provider,
    input.name ?? null,
  );
  return { inserted: false, existing: existing ?? undefined };
}

export async function upsertWorkspaceIntegration(
  input: UpsertWorkspaceIntegrationInput,
): Promise<WorkspaceIntegrationRecord> {
  const db = getDb();
  const timestamp = new Date();
  const existing = await getWorkspaceIntegrationByName(
    input.workspaceId,
    input.provider,
    input.name ?? null,
  );
  const metadata = preserveProviderReadiness(
    existing?.metadata ?? {},
    input.metadata ?? {},
  );

  const [record] = await db
    .insert(workspaceIntegrations)
    .values({
      workspaceId: input.workspaceId,
      provider: input.provider,
      name: input.name ?? null,
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey ?? null,
      installationId: input.installationId ?? null,
      metadataJson: JSON.stringify(metadata),
      writebackDispatchVia:
        input.writebackDispatchVia ?? existing?.writebackDispatchVia ?? "bridge",
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate(
      input.name
        ? {
          target: [
            workspaceIntegrations.workspaceId,
            workspaceIntegrations.provider,
            workspaceIntegrations.name,
          ],
          targetWhere: sql`${workspaceIntegrations.name} IS NOT NULL`,
          set: {
            connectionId: input.connectionId,
            providerConfigKey: input.providerConfigKey ?? null,
            installationId: input.installationId ?? null,
            metadataJson: JSON.stringify(metadata),
            writebackDispatchVia:
              input.writebackDispatchVia ?? existing?.writebackDispatchVia ?? "bridge",
            updatedAt: timestamp,
          },
        }
        : {
          target: [workspaceIntegrations.workspaceId, workspaceIntegrations.provider],
          targetWhere: sql`${workspaceIntegrations.name} IS NULL`,
          set: {
            connectionId: input.connectionId,
            providerConfigKey: input.providerConfigKey ?? null,
            installationId: input.installationId ?? null,
            metadataJson: JSON.stringify(metadata),
            writebackDispatchVia:
              input.writebackDispatchVia ?? existing?.writebackDispatchVia ?? "bridge",
            updatedAt: timestamp,
          },
        },
    )
    .returning();

  const mapped = mapRecord(record);
  void pushRelayfileIntegrationCredentialBestEffort(mapped);
  return mapped;
}

export async function updateWorkspaceIntegrationMetadata(
  input: {
    workspaceId: string;
    provider: WorkspaceIntegrationProvider;
    connectionId: string;
    update: (metadata: Record<string, unknown>) => Record<string, unknown> | null;
  },
): Promise<WorkspaceIntegrationRecord | null> {
  const db = getDb();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getWorkspaceIntegration(input.workspaceId, input.provider);
    if (!existing || existing.connectionId !== input.connectionId) {
      return null;
    }

    const nextPatch = input.update(existing.metadata);
    if (!nextPatch) {
      return existing;
    }

    const metadata = preserveProviderReadiness(existing.metadata, nextPatch);
    const previousMetadataJson = JSON.stringify(existing.metadata);
    const nextMetadataJson = JSON.stringify(metadata);
    if (previousMetadataJson === nextMetadataJson) {
      return existing;
    }

    const [record] = await db
      .update(workspaceIntegrations)
      .set({
        metadataJson: nextMetadataJson,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, input.workspaceId),
          eq(workspaceIntegrations.provider, input.provider),
          eq(workspaceIntegrations.connectionId, input.connectionId),
          eq(workspaceIntegrations.metadataJson, previousMetadataJson),
          isNull(workspaceIntegrations.name),
        ),
      )
      .returning();

    if (record) {
      return mapRecord(record);
    }
  }

  return null;
}

/**
 * Compare-and-swap variant of upsert: writes a new connection binding for
 * `(workspaceId, provider)` only when the row's current `connectionId`
 * matches `expectedConnectionId`. Returns the updated record on success or
 * `null` if no row matched (either the row is gone or another writer changed
 * the connectionId concurrently).
 *
 * Used by `selfHealMissingWorkspaceIntegration` when it has verified that
 * the row's existing connectionId is dead upstream and wants to atomically
 * replace it with the connectionId from the inbound webhook. The expected-
 * value filter prevents two racing self-heals from clobbering each other.
 */
export async function replaceWorkspaceIntegrationConnectionIfStale(
  input: UpsertWorkspaceIntegrationInput & { expectedConnectionId: string },
): Promise<WorkspaceIntegrationRecord | null> {
  const db = getDb();
  const timestamp = new Date();
  const existing = await getWorkspaceIntegration(input.workspaceId, input.provider);
  if (!existing || existing.connectionId !== input.expectedConnectionId) {
    return null;
  }
  const metadata = preserveProviderReadiness(
    existing.metadata ?? {},
    input.metadata ?? {},
  );

  const [record] = await db
    .update(workspaceIntegrations)
    .set({
      connectionId: input.connectionId,
      providerConfigKey: input.providerConfigKey ?? null,
      installationId: input.installationId ?? null,
      metadataJson: JSON.stringify(metadata),
      writebackDispatchVia: input.writebackDispatchVia ?? existing.writebackDispatchVia,
      updatedAt: timestamp,
    })
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, input.workspaceId),
        eq(workspaceIntegrations.provider, input.provider),
        isNull(workspaceIntegrations.name),
        eq(workspaceIntegrations.connectionId, input.expectedConnectionId),
      ),
    )
    .returning();

  if (!record) {
    return null;
  }
  const mapped = mapRecord(record);
  void pushRelayfileIntegrationCredentialBestEffort(mapped);
  return mapped;
}

export async function deleteWorkspaceIntegration(
  workspaceId: string,
  provider: string,
  name: string | null = null,
): Promise<void> {
  const db = getDb();
  const existing = await getWorkspaceIntegrationByName(workspaceId, provider, name);
  await db
    .delete(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, provider),
        name === null
          ? isNull(workspaceIntegrations.name)
          : eq(workspaceIntegrations.name, name),
      ),
    );
  if (existing) {
    void pushRelayfileIntegrationCredentialBestEffort(existing, {
      revoked: true,
      updatedAt: existing.updatedAt,
    });
  }
}

async function pushRelayfileIntegrationCredentialBestEffort(
  integration: WorkspaceIntegrationRecord,
  options: { revoked?: boolean; updatedAt?: Date } = {},
): Promise<void> {
  try {
    await pushRelayfileIntegrationCredential(integration, options);
  } catch (error) {
    console.error("[relayfile] failed to push integration credential", {
      workspaceId: integration.workspaceId,
      provider: integration.provider,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
