import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";

import { getDb } from "@/lib/db";
import {
  githubInstallations,
  organizationGithubInstallations,
  workspaceGithubInstallationLinks,
  workspaceIntegrations,
} from "@/lib/db/schema";
import { getProviderConfigKey } from "@/lib/integrations/providers";
import {
  isAppWorkspaceId,
  isRelayWorkspaceId,
  readAppWorkspaceRelayBinding,
  resolveAppWorkspaceByRelayWorkspaceId,
} from "@/lib/workspaces/relay-workspace-binding";

export type GithubInstallationConnection = {
  installationId: string;
  connectionId: string;
  providerConfigKey: string;
  accountLogin: string | null;
  accountType: "Organization" | "User" | "unknown";
  repositorySelection: "all" | "selected" | "unknown";
  suspended: boolean;
  source: "org-installation" | "workspace-link" | "legacy-workspace-integration";
};

type InstallationConnectionRow = {
  installationId: string;
  connectionId: string | null;
  providerConfigKey: string | null;
  accountLogin: string | null;
  accountType: string | null;
  repositorySelection: string | null;
  suspended: boolean | null;
};

const DEFAULT_GITHUB_PROVIDER_CONFIG_KEY = getProviderConfigKey("github");

function uniqueIds(values: Array<string | null | undefined>): string[] {
  const ids: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed && !ids.includes(trimmed)) {
      ids.push(trimmed);
    }
  }
  return ids;
}

export async function resolveGithubConnectionWorkspaceIdentity(
  workspaceId: string,
): Promise<{
  organizationId: string | null;
  candidateWorkspaceIds: readonly string[];
}> {
  const requestedWorkspaceId = workspaceId.trim();
  if (isAppWorkspaceId(requestedWorkspaceId)) {
    const binding = await readAppWorkspaceRelayBinding(requestedWorkspaceId);
    return {
      organizationId: binding?.organizationId ?? null,
      candidateWorkspaceIds: uniqueIds([
        requestedWorkspaceId,
        binding?.relayWorkspaceId,
      ]),
    };
  }

  if (isRelayWorkspaceId(requestedWorkspaceId)) {
    const binding = await resolveAppWorkspaceByRelayWorkspaceId(requestedWorkspaceId);
    return {
      organizationId: binding.organizationId,
      candidateWorkspaceIds: uniqueIds([
        requestedWorkspaceId,
        binding.appWorkspaceId,
      ]),
    };
  }

  return {
    organizationId: null,
    candidateWorkspaceIds: uniqueIds([requestedWorkspaceId]),
  };
}

function normalizeAccountType(
  value: string | null | undefined,
): GithubInstallationConnection["accountType"] {
  return value === "Organization" || value === "User" ? value : "unknown";
}

function normalizeRepositorySelection(
  value: string | null | undefined,
): GithubInstallationConnection["repositorySelection"] {
  return value === "all" || value === "selected" ? value : "unknown";
}

function mapInstallationConnection(
  row: InstallationConnectionRow | undefined,
  source: GithubInstallationConnection["source"],
): GithubInstallationConnection | null {
  const connectionId = row?.connectionId?.trim();
  if (!row || !connectionId) return null;

  return {
    installationId: row.installationId,
    connectionId,
    providerConfigKey:
      row.providerConfigKey?.trim() || DEFAULT_GITHUB_PROVIDER_CONFIG_KEY,
    accountLogin: row.accountLogin ?? null,
    accountType: normalizeAccountType(row.accountType),
    repositorySelection: normalizeRepositorySelection(row.repositorySelection),
    suspended: row.suspended ?? false,
    source,
  };
}

export async function resolveGithubConnectionForOrganization(
  organizationId: string,
): Promise<GithubInstallationConnection | null> {
  const normalizedOrganizationId = organizationId.trim();
  if (!normalizedOrganizationId) return null;

  const [row] = await getDb()
    .select({
      installationId: githubInstallations.installationId,
      connectionId: githubInstallations.connectionId,
      providerConfigKey: githubInstallations.providerConfigKey,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      repositorySelection: githubInstallations.repositorySelection,
      suspended: githubInstallations.suspended,
    })
    .from(organizationGithubInstallations)
    .innerJoin(
      githubInstallations,
      eq(
        organizationGithubInstallations.installationId,
        githubInstallations.installationId,
      ),
    )
    .where(eq(organizationGithubInstallations.organizationId, normalizedOrganizationId))
    .orderBy(
      desc(organizationGithubInstallations.isPrimary),
      desc(organizationGithubInstallations.updatedAt),
    )
    .limit(1);

  return mapInstallationConnection(row, "org-installation");
}

async function resolveGithubConnectionForWorkspaceLink(
  candidateWorkspaceIds: readonly string[],
): Promise<GithubInstallationConnection | null> {
  if (candidateWorkspaceIds.length === 0) return null;

  const [row] = await getDb()
    .select({
      installationId: githubInstallations.installationId,
      connectionId: githubInstallations.connectionId,
      providerConfigKey: githubInstallations.providerConfigKey,
      accountLogin: githubInstallations.accountLogin,
      accountType: githubInstallations.accountType,
      repositorySelection: githubInstallations.repositorySelection,
      suspended: githubInstallations.suspended,
    })
    .from(workspaceGithubInstallationLinks)
    .innerJoin(
      githubInstallations,
      eq(
        workspaceGithubInstallationLinks.installationId,
        githubInstallations.installationId,
      ),
    )
    .where(inArray(workspaceGithubInstallationLinks.workspaceId, candidateWorkspaceIds))
    .orderBy(desc(workspaceGithubInstallationLinks.updatedAt))
    .limit(1);

  return mapInstallationConnection(row, "workspace-link");
}

async function resolveLegacyGithubWorkspaceIntegration(
  candidateWorkspaceIds: readonly string[],
): Promise<GithubInstallationConnection | null> {
  if (candidateWorkspaceIds.length === 0) return null;

  const [row] = await getDb()
    .select({
      installationId: workspaceIntegrations.installationId,
      connectionId: workspaceIntegrations.connectionId,
      providerConfigKey: workspaceIntegrations.providerConfigKey,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        inArray(workspaceIntegrations.workspaceId, candidateWorkspaceIds),
        eq(workspaceIntegrations.provider, "github"),
        isNotNull(workspaceIntegrations.connectionId),
      ),
    )
    .orderBy(desc(workspaceIntegrations.updatedAt))
    .limit(1);

  if (!row?.connectionId?.trim()) return null;

  const installationId = row.installationId?.trim() ?? "";
  if (installationId) {
    const [installation] = await getDb()
      .select({
        installationId: githubInstallations.installationId,
        connectionId: githubInstallations.connectionId,
        providerConfigKey: githubInstallations.providerConfigKey,
        accountLogin: githubInstallations.accountLogin,
        accountType: githubInstallations.accountType,
        repositorySelection: githubInstallations.repositorySelection,
        suspended: githubInstallations.suspended,
      })
      .from(githubInstallations)
      .where(eq(githubInstallations.installationId, installationId))
      .limit(1);

    const resolved = mapInstallationConnection(
      {
        installationId,
        connectionId: installation?.connectionId ?? row.connectionId,
        providerConfigKey: installation?.providerConfigKey ?? row.providerConfigKey,
        accountLogin: installation?.accountLogin ?? null,
        accountType: installation?.accountType ?? "unknown",
        repositorySelection: installation?.repositorySelection ?? "unknown",
        suspended: installation?.suspended ?? false,
      },
      "legacy-workspace-integration",
    );
    if (resolved) return resolved;
  }

  return {
    installationId,
    connectionId: row.connectionId.trim(),
    providerConfigKey:
      row.providerConfigKey?.trim() || DEFAULT_GITHUB_PROVIDER_CONFIG_KEY,
    accountLogin: null,
    accountType: "unknown",
    repositorySelection: "unknown",
    suspended: false,
    source: "legacy-workspace-integration",
  };
}

export async function resolveGithubConnectionForWorkspace(
  workspaceId: string,
): Promise<GithubInstallationConnection | null> {
  const identity = await resolveGithubConnectionWorkspaceIdentity(workspaceId);

  if (identity.organizationId) {
    const organizationConnection = await resolveGithubConnectionForOrganization(
      identity.organizationId,
    );
    if (organizationConnection) return organizationConnection;
  }

  const linkConnection = await resolveGithubConnectionForWorkspaceLink(
    identity.candidateWorkspaceIds,
  );
  if (linkConnection) return linkConnection;

  return resolveLegacyGithubWorkspaceIntegration(identity.candidateWorkspaceIds);
}
