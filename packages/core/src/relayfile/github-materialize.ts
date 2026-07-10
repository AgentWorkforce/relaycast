import { normalizeRelayfilePath } from "./path-scopes.js";

export type GithubRepoIdentity = {
  owner: string;
  repo: string;
};

export type GithubRepoMaterializeCandidate = GithubRepoIdentity & {
  updatedMs: number;
};

type GithubRepoCatalogRow = Record<string, unknown>;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stripTrailingGlob(path: string): string {
  return path.endsWith("/**")
    ? path.slice(0, -3)
    : path.endsWith("/")
      ? path.slice(0, -1)
      : path;
}

function firstRepoString(row: GithubRepoCatalogRow): string | null {
  return nonEmptyString(row.repo)
    ?? nonEmptyString(row.name)
    ?? nonEmptyString(row.title)
    ?? nonEmptyString(row.id);
}

export function githubMaterializeOwnerRootsForMountPaths(paths: readonly string[]): string[] {
  const owners = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeRelayfilePath(path);
    if (!normalized) {
      continue;
    }
    const withoutGlob = stripTrailingGlob(normalized);
    const segments = withoutGlob.split("/").filter(Boolean);
    if (segments[0] !== "github" || segments[1] !== "repos") {
      continue;
    }
    const owner = segments[2];
    if (!owner || owner.includes("*")) {
      continue;
    }
    const repo = segments[3];
    if (segments.length === 3 || repo === "*" || repo === "**") {
      owners.add(owner);
    }
  }
  return [...owners].sort((left, right) => left.localeCompare(right));
}

export function githubRepoIdentityFromCatalogRow(
  row: unknown,
  defaultOwner?: string,
): GithubRepoIdentity | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const record = row as GithubRepoCatalogRow;
  const id = nonEmptyString(record.id);
  const fullName = nonEmptyString(record.full_name);
  const combined = id?.includes("/") ? id : fullName;
  if (combined?.includes("/")) {
    const [owner, repo] = combined.split("/");
    return owner && repo ? { owner, repo } : null;
  }

  const owner = nonEmptyString(record.owner) ?? defaultOwner ?? null;
  const repo = firstRepoString(record);
  if (!owner || !repo || repo.includes("/")) {
    return null;
  }
  return { owner, repo };
}

export function githubRepoUpdatedMsFromCatalogRow(row: unknown): number | null {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const record = row as GithubRepoCatalogRow;
  const value = nonEmptyString(record.updated)
    ?? nonEmptyString(record.updated_at)
    ?? nonEmptyString(record.pushed_at);
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function selectGithubReposToMaterialize(input: {
  owners: readonly string[];
  rowsByOwner: ReadonlyMap<string, readonly unknown[]> | Record<string, readonly unknown[]>;
  topLevelRows?: readonly unknown[];
  sinceMs: number;
}): {
  repos: GithubRepoMaterializeCandidate[];
  skippedMissingIdentity: number;
  skippedMissingUpdated: number;
} {
  const ownerSet = new Set(input.owners);
  const reposByKey = new Map<string, GithubRepoMaterializeCandidate>();
  let skippedMissingIdentity = 0;
  let skippedMissingUpdated = 0;

  const ownerEntries = input.rowsByOwner instanceof Map
    ? [...input.rowsByOwner.entries()]
    : Object.entries(input.rowsByOwner);

  function addRows(rows: readonly unknown[], defaultOwner?: string): void {
    for (const row of rows) {
      const identity = githubRepoIdentityFromCatalogRow(row, defaultOwner);
      if (!identity) {
        skippedMissingIdentity += 1;
        continue;
      }
      if (!ownerSet.has(identity.owner)) {
        continue;
      }
      const updatedMs = githubRepoUpdatedMsFromCatalogRow(row);
      if (updatedMs === null) {
        skippedMissingUpdated += 1;
        continue;
      }
      if (updatedMs < input.sinceMs) {
        continue;
      }
      reposByKey.set(identity.owner + "/" + identity.repo, {
        ...identity,
        updatedMs,
      });
    }
  }

  for (const [owner, rows] of ownerEntries) {
    addRows(rows, owner);
  }
  addRows(input.topLevelRows ?? []);

  return {
    repos: [...reposByKey.values()].sort((left, right) =>
      right.updatedMs - left.updatedMs
        || (left.owner + "/" + left.repo).localeCompare(right.owner + "/" + right.repo)
    ),
    skippedMissingIdentity,
    skippedMissingUpdated,
  };
}
