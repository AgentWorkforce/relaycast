import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import {
  githubInstallations,
  repoGithubInstallationIndex,
  workspaceGithubInstallationLinks,
} from "../db/schema";
import {
  normalizeGithubRepositoryCoord,
  type GithubInstallationAccountType,
} from "./github-installation-index";
import { isGithubInstallationCentricEnabled } from "./github-installation-centric-flag";
import { resolveGithubConnectionForWorkspace } from "./github-installation-connection";

export type GithubAuthPurpose =
  | "repo_read"
  | "repo_write"
  | "clone"
  | "workflow_write"
  | "pull_request"
  | "identity"
  | "act_as_user"
  | "list_my_repos";

export type GithubAuthMatchedBy =
  | "explicit_installation"
  | "repository_index"
  | "owner_exact";

export type GithubAuthResolution =
  | {
      ok: true;
      tokenType: "installation";
      authKind: "app_installation";
      installationId: string;
      accountLogin: string | null;
      accountType: GithubInstallationAccountType;
      matchedBy: GithubAuthMatchedBy;
      connectionId: string | null;
      providerConfigKey: string | null;
    }
  | {
      ok: false;
      reason:
        | "user_oauth_required"
        | "missing_installation"
        | "ambiguous_installation"
        | "repository_access_removed";
      tokenType: "user_oauth" | "installation";
      authKind: "user_oauth" | "app_installation";
      candidates?: Array<{
        installationId: string;
        accountLogin: string | null;
        accountType: GithubInstallationAccountType;
        matchedBy: GithubAuthMatchedBy;
      }>;
    };

export type ResolveGithubAuthShadowInput = {
  workspaceId: string;
  owner?: string | null;
  repo?: string | null;
  purpose: GithubAuthPurpose;
  installationId?: string | null;
};

type LinkedInstallation = {
  installationId: string;
  accountLogin: string | null;
  accountId: string | null;
  accountType: GithubInstallationAccountType;
  connectionId: string | null;
  providerConfigKey: string | null;
};

export type GithubAuthShadowLinkedInstallation = LinkedInstallation;

export type GithubAuthShadowRepositoryIndexHit = {
  installationId: string;
  accessState: string;
};

const REPO_PURPOSES = new Set<GithubAuthPurpose>([
  "repo_read",
  "repo_write",
  "clone",
  "workflow_write",
  "pull_request",
]);

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

function toSuccess(candidate: LinkedInstallation, matchedBy: GithubAuthMatchedBy): GithubAuthResolution {
  return {
    ok: true,
    tokenType: "installation",
    authKind: "app_installation",
    installationId: candidate.installationId,
    accountLogin: candidate.accountLogin,
    accountType: candidate.accountType,
    matchedBy,
    connectionId: candidate.connectionId,
    providerConfigKey: candidate.providerConfigKey,
  };
}

function toCandidate(candidate: LinkedInstallation, matchedBy: GithubAuthMatchedBy) {
  return {
    installationId: candidate.installationId,
    accountLogin: candidate.accountLogin,
    accountType: candidate.accountType,
    matchedBy,
  };
}

async function listLinkedInstallations(workspaceId: string): Promise<LinkedInstallation[]> {
  if (isGithubInstallationCentricEnabled()) {
    const connection = await resolveGithubConnectionForWorkspace(workspaceId);
    if (!connection) return [];
    return [{
      installationId: connection.installationId,
      accountLogin: connection.accountLogin,
      accountId: null,
      accountType: connection.accountType,
      connectionId: connection.connectionId,
      providerConfigKey: connection.providerConfigKey,
    }];
  }

  const db = getDb();
  const links = await db
    .select({
      installationId: workspaceGithubInstallationLinks.installationId,
      connectionId: workspaceGithubInstallationLinks.connectionId,
      providerConfigKey: workspaceGithubInstallationLinks.providerConfigKey,
    })
    .from(workspaceGithubInstallationLinks)
    .where(eq(workspaceGithubInstallationLinks.workspaceId, workspaceId));
  if (links.length === 0) return [];

  const installationIds = [...new Set(links.map((link) => link.installationId))];
  const installs = await db
    .select({
      installationId: githubInstallations.installationId,
      accountLogin: githubInstallations.accountLogin,
      accountId: githubInstallations.accountId,
      accountType: githubInstallations.accountType,
    })
    .from(githubInstallations)
    .where(inArray(githubInstallations.installationId, installationIds));
  const installsById = new Map(installs.map((install) => [install.installationId, install]));

  return links.flatMap((link) => {
    const install = installsById.get(link.installationId);
    if (!install) return [];
    return [{
      installationId: link.installationId,
      accountLogin: install.accountLogin ?? null,
      accountId: install.accountId ?? null,
      accountType: install.accountType as GithubInstallationAccountType,
      connectionId: link.connectionId ?? null,
      providerConfigKey: link.providerConfigKey ?? null,
    }];
  });
}

function resolveRepositoryIndexCandidate(input: {
  repositoryIndex: GithubAuthShadowRepositoryIndexHit | null;
  linked: LinkedInstallation[];
}): GithubAuthResolution | null {
  if (!input.repositoryIndex) return null;
  if (input.repositoryIndex.accessState === "access_removed") {
    return {
      ok: false,
      reason: "repository_access_removed",
      tokenType: "installation",
      authKind: "app_installation",
      candidates: input.linked
        .filter((candidate) => candidate.installationId === input.repositoryIndex?.installationId)
        .map((candidate) => toCandidate(candidate, "repository_index")),
    };
  }
  const candidate = input.linked.find((entry) => entry.installationId === input.repositoryIndex?.installationId);
  return candidate ? toSuccess(candidate, "repository_index") : null;
}

export function resolveGithubAuthShadowFromRows(
  input: ResolveGithubAuthShadowInput,
  linked: LinkedInstallation[],
  repositoryIndex: GithubAuthShadowRepositoryIndexHit | null = null,
): GithubAuthResolution {
  if (!REPO_PURPOSES.has(input.purpose)) {
    return {
      ok: false,
      reason: "user_oauth_required",
      tokenType: "user_oauth",
      authKind: "user_oauth",
    };
  }

  if (linked.length === 0) {
    return {
      ok: false,
      reason: "missing_installation",
      tokenType: "installation",
      authKind: "app_installation",
    };
  }

  const explicitInstallationId = input.installationId?.trim();
  if (explicitInstallationId) {
    const candidate = linked.find((entry) => entry.installationId === explicitInstallationId);
    return candidate
      ? toSuccess(candidate, "explicit_installation")
      : {
          ok: false,
          reason: "missing_installation",
          tokenType: "installation",
          authKind: "app_installation",
        };
  }

  const owner = input.owner?.trim();
  const repo = input.repo?.trim();
  if (owner && repo) {
    const indexed = resolveRepositoryIndexCandidate({ repositoryIndex, linked });
    if (indexed) return indexed;
  }

  const normalizedOwner = normalize(owner);
  if (!normalizedOwner) {
    return {
      ok: false,
      reason: "missing_installation",
      tokenType: "installation",
      authKind: "app_installation",
    };
  }

  const ownerMatches = linked.filter((candidate) =>
    normalize(candidate.accountLogin) === normalizedOwner ||
    normalize(candidate.accountId) === normalizedOwner
  );
  if (ownerMatches.length === 1) {
    return toSuccess(ownerMatches[0]!, "owner_exact");
  }
  if (ownerMatches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous_installation",
      tokenType: "installation",
      authKind: "app_installation",
      candidates: ownerMatches.map((candidate) => toCandidate(candidate, "owner_exact")),
    };
  }

  return {
    ok: false,
    reason: "missing_installation",
    tokenType: "installation",
    authKind: "app_installation",
  };
}

async function readRepositoryIndexHit(input: ResolveGithubAuthShadowInput): Promise<GithubAuthShadowRepositoryIndexHit | null> {
  const owner = normalizeGithubRepositoryCoord(input.owner);
  const repo = normalizeGithubRepositoryCoord(input.repo);
  if (!owner || !repo) return null;

  const db = getDb();
  const [record] = await db
    .select({
      installationId: repoGithubInstallationIndex.installationId,
      accessState: repoGithubInstallationIndex.accessState,
    })
    .from(repoGithubInstallationIndex)
    .where(
      and(
        eq(repoGithubInstallationIndex.workspaceId, input.workspaceId),
        eq(repoGithubInstallationIndex.repoOwner, owner),
        eq(repoGithubInstallationIndex.repoName, repo),
      ),
    )
    .limit(1);
  return record ?? null;
}

export async function resolveGithubAuthShadow(
  input: ResolveGithubAuthShadowInput,
): Promise<GithubAuthResolution> {
  const linked = await listLinkedInstallations(input.workspaceId);
  const repositoryIndex = await readRepositoryIndexHit(input);
  return resolveGithubAuthShadowFromRows(input, linked, repositoryIndex);
}
