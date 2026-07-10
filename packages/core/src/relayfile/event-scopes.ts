import { githubIssuePath, githubPullRequestPath } from "@relayfile/adapter-github/path-mapper";
import { linearIssuePath } from "@relayfile/adapter-linear/path-mapper";
import { notionDatabasePagePath, notionStandalonePagePath } from "@relayfile/adapter-notion";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberLikeValue(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return stringValue(value);
}

function readRecord(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return isRecord(record?.[key]) ? record[key] as Record<string, unknown> : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  return stringValue(record?.[key]);
}

function readNumberLike(record: Record<string, unknown> | null, key: string): string | null {
  return numberLikeValue(record?.[key]);
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function normalizePath(path: string): string | null {
  const trimmed = path.trim().replace(/\\/gu, "/");
  if (!trimmed) {
    return null;
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+/gu, "/");
}

function subtreeForEventPath(path: string): string | null {
  const normalized = normalizePath(path);
  if (!normalized) {
    return null;
  }
  if (normalized.includes("*")) {
    return null;
  }
  if (normalized.endsWith("/meta.json") || normalized.endsWith("/metadata.json")) {
    return `${normalized.slice(0, normalized.lastIndexOf("/"))}/**`;
  }
  return normalized;
}

function uniqueSorted(paths: Iterable<string | null>): string[] {
  return [...new Set([...paths].filter((path): path is string => Boolean(path)))]
    .sort((left, right) => left.localeCompare(right));
}

function splitType(type: string | null): { provider: string | null; eventType: string | null } {
  if (!type) {
    return { provider: null, eventType: null };
  }
  const dot = type.indexOf(".");
  if (dot <= 0 || dot === type.length - 1) {
    return { provider: null, eventType: type };
  }
  return {
    provider: type.slice(0, dot),
    eventType: type.slice(dot + 1),
  };
}

function githubRepo(payload: Record<string, unknown>): { owner: string; repo: string } | null {
  const pullRequest = githubPullRequestResource(payload);
  const repository =
    readRecord(payload, "repository") ??
    readRecord(readRecord(pullRequest, "base"), "repo");
  const fullName = readString(repository, "full_name");
  const [ownerFromFullName, repoFromFullName] = fullName?.split("/", 2) ?? [];
  const owner =
    readString(readRecord(repository, "owner"), "login") ??
    readString(readRecord(repository, "owner"), "name") ??
    ownerFromFullName;
  const repo = readString(repository, "name") ?? repoFromFullName;
  return owner && repo ? { owner, repo } : null;
}

function githubPullRequestResource(resource: Record<string, unknown>): Record<string, unknown> | null {
  const nested = readRecord(resource, "pull_request");
  if (nested) {
    return nested;
  }
  return readRecord(resource, "head") && readRecord(resource, "base") ? resource : null;
}

function githubScopedPath(eventType: string, resource: Record<string, unknown>): string[] {
  const repo = githubRepo(resource);
  if (!repo) {
    return [];
  }
  if (eventType.startsWith("issues.")) {
    const issue = readRecord(resource, "issue");
    const number = readNumberLike(issue, "number");
    if (!number) {
      return [];
    }
    return [`${githubIssuePath(repo.owner, repo.repo, number, readString(issue, "title") ?? undefined).replace(/\/meta\.json$/u, "")}/**`];
  }
  if (eventType.startsWith("pull_request.")) {
    const pullRequest = githubPullRequestResource(resource);
    const number = readNumberLike(pullRequest, "number") ?? readNumberLike(resource, "number");
    if (!number) {
      return [];
    }
    return [`${githubPullRequestPath(repo.owner, repo.repo, number, readString(pullRequest, "title") ?? undefined).replace(/\/meta\.json$/u, "")}/**`];
  }
  if (eventType.startsWith("pull_request_review.")) {
    const pullRequest = githubPullRequestResource(resource);
    const number = readNumberLike(pullRequest, "number");
    if (!number) {
      return [];
    }
    return [`${githubPullRequestPath(repo.owner, repo.repo, number, readString(pullRequest, "title") ?? undefined).replace(/\/meta\.json$/u, "")}/**`];
  }
  if (eventType.startsWith("pull_request_review_comment.")) {
    const pullRequest = githubPullRequestResource(resource);
    const number = readNumberLike(pullRequest, "number");
    if (!number) {
      return [];
    }
    return [`${githubPullRequestPath(repo.owner, repo.repo, number, readString(pullRequest, "title") ?? undefined).replace(/\/meta\.json$/u, "")}/**`];
  }
  if (eventType.startsWith("check_run.")) {
    const checkRun = readRecord(resource, "check_run") ?? resource;
    const pullRequests = Array.isArray(checkRun?.pull_requests)
      ? checkRun.pull_requests.filter(isRecord)
      : [];
    return pullRequests.flatMap((pullRequest) => {
      const number = readNumberLike(pullRequest, "number");
      if (!number) {
        return [];
      }
      return [
        `${githubPullRequestPath(repo.owner, repo.repo, number).replace(/\/meta\.json$/u, "")}/**`,
      ];
    });
  }
  if (eventType.startsWith("issue_comment.")) {
    const issue = readRecord(resource, "issue");
    const number = readNumberLike(issue, "number");
    if (!number) {
      return [];
    }
    return [`${githubIssuePath(repo.owner, repo.repo, number, readString(issue, "title") ?? undefined).replace(/\/meta\.json$/u, "")}/**`];
  }
  return [];
}

function linearScopedPath(resource: Record<string, unknown>): string[] {
  const issue = readRecord(resource, "issue") ?? resource;
  const id = readString(issue, "id") ?? readString(issue, "identifier");
  if (!id) {
    return [];
  }
  return [
    linearIssuePath(
      id,
      readString(issue, "identifier") ?? undefined,
      readString(issue, "title") ?? undefined,
    ),
  ];
}

function notionScopedPath(resource: Record<string, unknown>): string[] {
  const page = readRecord(resource, "page") ?? resource;
  const pageId = readString(page, "id") ?? readString(resource, "pageId") ?? readString(resource, "page_id");
  if (!pageId) {
    return [];
  }
  const database = readRecord(page, "database") ?? readRecord(resource, "database");
  const databaseId = readString(database, "id") ?? readString(resource, "databaseId") ?? readString(resource, "database_id");
  const title = readString(page, "title") ?? readString(page, "name") ?? undefined;
  if (databaseId) {
    return [notionDatabasePagePath(databaseId, pageId, title)];
  }
  return [notionStandalonePagePath(pageId, title)];
}

/**
 * Derive bounded relayfile-mount initial-sync subtrees from a proactive event
 * envelope. Explicit Relayfile paths from dispatch are preferred because they
 * already reflect adapter-canonical filenames; provider payload heuristics are
 * a fallback for direct tests or future dispatchers that omit paths.
 */
export function eventScopedSyncPaths(envelope: Record<string, unknown>): string[] {
  const resource = isRecord(envelope.resource) ? envelope.resource : {};
  const explicit = [
    ...readStringArray(envelope.paths),
    ...readStringArray(resource.paths),
  ].map(subtreeForEventPath);
  if (explicit.some(Boolean)) {
    return uniqueSorted(explicit);
  }

  const split = splitType(stringValue(envelope.type));
  const provider = stringValue(envelope.provider) ?? split.provider;
  const eventType = stringValue(envelope.eventType) ?? split.eventType ?? "";
  if (!provider || !eventType) {
    return [];
  }

  switch (provider) {
    case "github":
      return uniqueSorted(githubScopedPath(eventType, resource));
    case "linear":
      return uniqueSorted(linearScopedPath(resource));
    case "notion":
      return uniqueSorted(notionScopedPath(resource));
    default:
      return [];
  }
}
