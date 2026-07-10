import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  githubInstallations,
  organizationGithubInstallations,
  repoGithubInstallationIndex,
  workspaceGithubInstallationLinks,
} from "../db/schema";
import { isGithubInstallationCentricEnabled } from "./github-installation-centric-flag";
import { resolveGithubConnectionWorkspaceIdentity } from "./github-installation-connection";

export type GithubInstallationAccountType = "User" | "Organization" | "unknown";
export type GithubRepositorySelection = "all" | "selected" | "unknown";
export type GithubRepoAccessState = "active" | "access_removed" | "unknown";

export type GithubInstallationIndexInput = {
  workspaceId: string;
  installationId: string;
  payload?: Record<string, unknown> | null;
  connectionId?: string | null;
  providerConfigKey?: string | null;
  linkedByUserId?: string | null;
  workspaceIntegrationId?: string | null;
  metadata?: Record<string, unknown>;
};

export type ParsedGithubInstallation = {
  installationId: string;
  accountType: GithubInstallationAccountType;
  accountLogin: string | null;
  accountId: string | null;
  repositorySelection: GithubRepositorySelection;
  permissions: Record<string, string>;
  events: string[];
  suspended: boolean;
  suspendedAt: Date | null;
  suspendedBy: string | null;
};

export type ParsedGithubRepoAccess = {
  installationId: string;
  repoOwner: string;
  repoName: string;
  repoId: string | null;
  accessState: GithubRepoAccessState;
};

type GithubInstallationIndexParseResult = {
  installation: ParsedGithubInstallation;
  repositories: ParsedGithubRepoAccess[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown> | null {
  const entry = value?.[key];
  return isRecord(entry) ? entry : null;
}

function readString(value: Record<string, unknown> | null | undefined, key: string): string | null {
  const entry = value?.[key];
  if (typeof entry === "string" && entry.trim().length > 0) {
    return entry.trim();
  }
  if (typeof entry === "number" && Number.isFinite(entry)) {
    return String(entry);
  }
  return null;
}

function readBoolean(value: Record<string, unknown> | null | undefined, key: string): boolean | null {
  const entry = value?.[key];
  return typeof entry === "boolean" ? entry : null;
}

function readStringArray(value: Record<string, unknown> | null | undefined, key: string): string[] {
  const entry = value?.[key];
  if (!Array.isArray(entry)) return [];
  return entry.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readRecordArray(value: Record<string, unknown> | null | undefined, key: string): Record<string, unknown>[] {
  const entry = value?.[key];
  if (!Array.isArray(entry)) return [];
  return entry.filter(isRecord);
}

function normalizeAccountType(value: string | null): GithubInstallationAccountType {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "user") return "User";
  if (normalized === "organization" || normalized === "org") return "Organization";
  return "unknown";
}

function normalizeRepositorySelection(value: string | null): GithubRepositorySelection {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "all" || normalized === "selected") return normalized;
  return "unknown";
}

function normalizeAccessState(value: GithubRepoAccessState): GithubRepoAccessState {
  return value;
}

export function normalizeGithubRepositoryCoord(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function readInstallationId(payload: Record<string, unknown> | null | undefined): string | null {
  const installation = readRecord(payload, "installation");
  return (
    readString(installation, "id") ??
    readString(payload, "installation_id") ??
    readString(payload, "installationId") ??
    readString(payload, "github_installation_id")
  );
}

function readPermissions(installation: Record<string, unknown> | null): Record<string, string> {
  const raw = readRecord(installation, "permissions");
  if (!raw) return {};
  const permissions: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim().length > 0) {
      permissions[key] = value.trim();
    }
  }
  return permissions;
}

function parseRepository(
  installationId: string,
  repo: Record<string, unknown>,
  accessState: GithubRepoAccessState,
): ParsedGithubRepoAccess | null {
  const fullName = readString(repo, "full_name");
  const owner =
    readString(readRecord(repo, "owner"), "login") ??
    (fullName?.includes("/") ? fullName.split("/")[0]?.trim() ?? null : null);
  const name =
    readString(repo, "name") ??
    (fullName?.includes("/") ? fullName.split("/")[1]?.trim() ?? null : null);
  const repoOwner = normalizeGithubRepositoryCoord(owner);
  const repoName = normalizeGithubRepositoryCoord(name);
  if (!repoOwner || !repoName) return null;
  return {
    installationId,
    repoOwner,
    repoName,
    repoId: readString(repo, "id"),
    accessState: normalizeAccessState(accessState),
  };
}

export function parseGithubInstallationIndexPayload(input: {
  installationId?: string | null;
  payload?: Record<string, unknown> | null;
}): GithubInstallationIndexParseResult | null {
  const payload = input.payload ?? null;
  const installation = readRecord(payload, "installation") ?? payload;
  const installationId = input.installationId ?? readInstallationId(payload) ?? readString(installation, "id");
  if (!installationId) return null;

  const account = readRecord(installation, "account");
  const action = readString(payload, "action")?.toLowerCase() ?? null;
  const suspendedAt = parseDate(readString(installation, "suspended_at") ?? readString(payload, "suspended_at"));
  const suspended = Boolean(suspendedAt) || action === "suspend" || readBoolean(installation, "suspended") === true;
  const suspendedBy =
    readString(readRecord(installation, "suspended_by"), "login") ??
    readString(payload, "suspended_by") ??
    null;
  const install: ParsedGithubInstallation = {
    installationId,
    accountType: normalizeAccountType(readString(account, "type")),
    accountLogin: readString(account, "login"),
    accountId: readString(account, "id"),
    repositorySelection: normalizeRepositorySelection(readString(installation, "repository_selection")),
    permissions: readPermissions(installation),
    events: readStringArray(installation, "events"),
    suspended,
    suspendedAt,
    suspendedBy,
  };

  const repositories = [
    ...readRecordArray(payload, "repositories").map((repo) =>
      parseRepository(installationId, repo, "active"),
    ),
    ...readRecordArray(payload, "repositories_added").map((repo) =>
      parseRepository(installationId, repo, "active"),
    ),
    ...readRecordArray(payload, "repositories_removed").map((repo) =>
      parseRepository(installationId, repo, "access_removed"),
    ),
  ].filter((repo): repo is ParsedGithubRepoAccess => Boolean(repo));

  return { installation: install, repositories };
}

function mergeInstallation(
  next: ParsedGithubInstallation,
  existing?: typeof githubInstallations.$inferSelect,
): ParsedGithubInstallation {
  if (!existing) return next;
  return {
    installationId: next.installationId,
    accountType: next.accountType === "unknown" ? existing.accountType as GithubInstallationAccountType : next.accountType,
    accountLogin: next.accountLogin ?? existing.accountLogin ?? null,
    accountId: next.accountId ?? existing.accountId ?? null,
    repositorySelection: next.repositorySelection === "unknown"
      ? existing.repositorySelection as GithubRepositorySelection
      : next.repositorySelection,
    permissions: Object.keys(next.permissions).length > 0 ? next.permissions : existing.permissionsJson ?? {},
    events: next.events.length > 0 ? next.events : existing.events ?? [],
    suspended: next.suspended || existing.suspended,
    suspendedAt: next.suspendedAt ?? existing.suspendedAt ?? null,
    suspendedBy: next.suspendedBy ?? existing.suspendedBy ?? null,
  };
}

export async function upsertGithubInstallationIndex(input: GithubInstallationIndexInput): Promise<{
  installationIndexed: boolean;
  repositoriesIndexed: number;
}> {
  const parsed = parseGithubInstallationIndexPayload({
    installationId: input.installationId,
    payload: input.payload ?? null,
  });
  if (!parsed) {
    return { installationIndexed: false, repositoriesIndexed: 0 };
  }

  const db = getDb();
  const timestamp = new Date();
  const [existing] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.installationId, parsed.installation.installationId))
    .limit(1);
  const installation = mergeInstallation(parsed.installation, existing);
  const metadata = input.metadata ?? input.payload ?? {};

  await db
    .insert(githubInstallations)
    .values({
      installationId: installation.installationId,
      accountType: installation.accountType,
      accountLogin: installation.accountLogin,
      accountId: installation.accountId,
      repositorySelection: installation.repositorySelection,
      permissionsJson: installation.permissions,
      events: installation.events,
      suspended: installation.suspended,
      suspendedAt: installation.suspendedAt,
      suspendedBy: installation.suspendedBy,
      installedByUserId: input.linkedByUserId ?? existing?.installedByUserId ?? null,
      providerConfigKey: input.providerConfigKey ?? existing?.providerConfigKey ?? null,
      connectionId: input.connectionId ?? existing?.connectionId ?? null,
      metadataJson: metadata,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: {
        accountType: installation.accountType,
        accountLogin: installation.accountLogin,
        accountId: installation.accountId,
        repositorySelection: installation.repositorySelection,
        permissionsJson: installation.permissions,
        events: installation.events,
        suspended: installation.suspended,
        suspendedAt: installation.suspendedAt,
        suspendedBy: installation.suspendedBy,
        installedByUserId: input.linkedByUserId ?? existing?.installedByUserId ?? null,
        providerConfigKey: input.providerConfigKey ?? existing?.providerConfigKey ?? null,
        connectionId: input.connectionId ?? existing?.connectionId ?? null,
        metadataJson: metadata,
        updatedAt: timestamp,
      },
    });

  const [existingLink] = await db
    .select()
    .from(workspaceGithubInstallationLinks)
    .where(
      and(
        eq(workspaceGithubInstallationLinks.workspaceId, input.workspaceId),
        eq(workspaceGithubInstallationLinks.installationId, installation.installationId),
      ),
    )
    .limit(1);
  const linkValues = {
    linkedByUserId: input.linkedByUserId ?? existingLink?.linkedByUserId ?? null,
    workspaceIntegrationId: input.workspaceIntegrationId ?? existingLink?.workspaceIntegrationId ?? null,
    connectionId: input.connectionId ?? existingLink?.connectionId ?? null,
    providerConfigKey: input.providerConfigKey ?? existingLink?.providerConfigKey ?? null,
  };

  await db
    .insert(workspaceGithubInstallationLinks)
    .values({
      workspaceId: input.workspaceId,
      installationId: installation.installationId,
      linkedByUserId: linkValues.linkedByUserId,
      workspaceIntegrationId: linkValues.workspaceIntegrationId,
      connectionId: linkValues.connectionId,
      providerConfigKey: linkValues.providerConfigKey,
      metadataJson: metadata,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .onConflictDoUpdate({
      target: [
        workspaceGithubInstallationLinks.workspaceId,
        workspaceGithubInstallationLinks.installationId,
      ],
      set: {
        linkedByUserId: linkValues.linkedByUserId,
        workspaceIntegrationId: linkValues.workspaceIntegrationId,
        connectionId: linkValues.connectionId,
        providerConfigKey: linkValues.providerConfigKey,
        metadataJson: metadata,
        updatedAt: timestamp,
      },
    });

  // Establish org-level ownership (the installation-centric org tier) the first
  // time an Organization installation is indexed for a workspace. This makes a
  // brand-new org's *first* App install fully wired with no second connect
  // (Path 2), and lets the periodic sweep self-heal pre-existing installs whose
  // org tier was never populated. Path 1 (inherit/Join) is handled inline by
  // performGithubJoin. Gated by the existing installation-centric flag.
  if (isGithubInstallationCentricEnabled() && installation.accountType === "Organization") {
    await ensureOrganizationInstallationOwnership(db, {
      workspaceId: input.workspaceId,
      installationId: installation.installationId,
      linkedByUserId: linkValues.linkedByUserId,
      timestamp,
    });
  }

  for (const repository of parsed.repositories) {
    await db
      .insert(repoGithubInstallationIndex)
      .values({
        workspaceId: input.workspaceId,
        installationId: repository.installationId,
        repoOwner: repository.repoOwner,
        repoName: repository.repoName,
        repoId: repository.repoId,
        accessState: repository.accessState,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      .onConflictDoUpdate({
        target: [
          repoGithubInstallationIndex.workspaceId,
          repoGithubInstallationIndex.repoOwner,
          repoGithubInstallationIndex.repoName,
        ],
        set: {
          installationId: repository.installationId,
          repoId: repository.repoId,
          accessState: repository.accessState,
          updatedAt: timestamp,
        },
      });
  }

  return {
    installationIndexed: true,
    repositoriesIndexed: parsed.repositories.length,
  };
}

// Write the installation-centric org-ownership tier (D1) for the workspace's
// cloud org if it isn't already recorded. Mirrors performGithubLink's
// first-wins is_primary semantics so the connect/Join, install-webhook, and
// sweep paths all converge on the same org-tier truth. A workspace that doesn't
// map to a cloud org is left to the workspace-link fallback (D5).
export async function ensureOrganizationInstallationOwnership(
  db: ReturnType<typeof getDb>,
  input: {
    workspaceId: string;
    installationId: string;
    linkedByUserId: string | null;
    timestamp: Date;
  },
): Promise<void> {
  // Resolve the cloud org the SAME way the read resolver does — binding-aware,
  // handling both the app-workspace-id (uuid) and relay-workspace-id (`rw_…`)
  // namespaces. A raw `workspaces.id = workspaceId` lookup throws on the
  // relay-format ids that the install/sweep path actually carries (the dual-id
  // duality), which is why establishment silently failed before. Resolving via
  // the binding keeps establish/read symmetric: we only establish the org tier
  // for workspaces that would resolve through it. Workspaces that don't map to a
  // cloud org keep using the workspace-link fallback (D5).
  const { organizationId } = await resolveGithubConnectionWorkspaceIdentity(input.workspaceId);
  if (!organizationId) return;

  const existing = await db
    .select({ installationId: organizationGithubInstallations.installationId })
    .from(organizationGithubInstallations)
    .where(eq(organizationGithubInstallations.organizationId, organizationId));
  if (existing.some((row) => row.installationId === input.installationId)) {
    return;
  }

  await db
    .insert(organizationGithubInstallations)
    .values({
      organizationId,
      installationId: input.installationId,
      isPrimary: existing.length === 0,
      linkedByUserId: input.linkedByUserId,
      updatedAt: input.timestamp,
    })
    .onConflictDoNothing();
}

export async function backfillGithubInstallationLinksFromWorkspaceIntegrations(): Promise<number> {
  const db = getDb();
  const rows = await db.execute<{
    workspace_id: string;
    connection_id: string;
    provider_config_key: string | null;
    installation_id: string | null;
    metadata_json: string | null;
  }>(sql`
    SELECT workspace_id, connection_id, provider_config_key, installation_id, metadata_json
    FROM workspace_integrations
    WHERE provider LIKE 'github%'
      AND installation_id IS NOT NULL
      AND installation_id <> ''
  `);

  let count = 0;
  for (const row of rows.rows ?? []) {
    const metadata = parseJsonRecord(row.metadata_json);
    await upsertGithubInstallationIndex({
      workspaceId: row.workspace_id,
      installationId: row.installation_id ?? "",
      payload: metadata,
      connectionId: row.connection_id,
      providerConfigKey: row.provider_config_key,
      metadata,
    });
    count += 1;
  }
  return count;
}

function parseJsonRecord(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
