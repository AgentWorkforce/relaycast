/**
 * GitHub REST client for the specialist-worker's API fallback path.
 *
 * When the relayfile VFS does not yet hold cached data for a workspace's
 * repo, the specialist asks cloud web to proxy GitHub REST calls through the
 * workspace's Nango connection. The worker never receives a GitHub token. In
 * parallel, the librarian/investigator fallback fires a fire-and-forget clone
 * request at the cloud web app so a subsequent query can hit VFS with richer
 * content.
 *
 * Wiring:
 *   packages/specialist-worker/src/routes/a2a-rpc.ts
 *     - reads CLOUD_API_URL + SPECIALIST_CLOUD_API_TOKEN
 *     - constructs a CloneRequester + this client
 *     - passes { apiFallback, librarianApiFallback } into
 *       createGitHubAgenticSpecialist so @agent-assistant/specialists can
 *       reach live GitHub.
 *
 * See .claude/rules/workers-fetch.md — every outbound call MUST go through
 * globalThis.fetch(...) and consume response bodies on both happy and error
 * paths (sage#115 learnings — leaking a response body stalls the Worker's
 * in-flight HTTP cap).
 */

import type {
  GitHubApiFallback,
  GitHubApiPullRequest,
  GitHubLibrarianOptions,
} from "@agent-assistant/specialists";

import type {
  CloneRequester,
} from "./clone-requester.js";

type GitHubLibrarianApiFallback = NonNullable<GitHubLibrarianOptions["apiFallback"]>;
import {
  createGitHubInvestigatorApiFallback,
  createGitHubLibrarianApiFallback as buildLibrarianFromIntegration,
  type GitHubIntegration,
} from "./github-api-fallback.js";

const GITHUB_QUERY_PATH = "/api/v1/github/query";
const GITHUB_JSON_ACCEPT = "application/vnd.github+json";
const GITHUB_DIFF_ACCEPT = "application/vnd.github.v3.diff";
const DEFAULT_PER_PAGE = 50;
const MAX_PER_PAGE = 100;

type FetchImpl = typeof globalThis.fetch;

interface GitHubApiClientOptions {
  cloudApiUrl: string;
  cloudApiToken: string;
  workspaceId: string;
  fetchImpl?: FetchImpl;
}

interface ListOptions {
  query?: string;
  state?: string;
  labels?: string[];
  limit?: number;
}

interface ListWrappedResult<T> {
  data: T;
  summary?: string;
  source?: string;
  timestamp?: string;
}

interface GitHubOrgRecord {
  login?: unknown;
}

interface GitHubRepoRecord {
  full_name?: unknown;
}

/**
 * Constructs a GitHubIntegration-compatible object suitable for
 * createGitHubLibrarianApiFallback + createGitHubInvestigatorApiFallback in
 * github-api-fallback.ts.
 *
 * All calls go through globalThis.fetch. Response bodies are consumed as text
 * on both happy and error paths before JSON parsing to avoid leaked Worker
 * response bodies.
 */
export function createGitHubIntegration(
  options: GitHubApiClientOptions,
): GitHubIntegration {
  const cloudApiUrl = options.cloudApiUrl?.trim();
  const cloudApiToken = options.cloudApiToken?.trim();
  const workspaceId = options.workspaceId?.trim();
  if (!cloudApiUrl) {
    throw new Error("createGitHubIntegration requires a non-empty cloudApiUrl");
  }
  if (!cloudApiToken) {
    throw new Error("createGitHubIntegration requires a non-empty cloudApiToken");
  }
  if (!workspaceId) {
    throw new Error("createGitHubIntegration requires a non-empty workspaceId");
  }
  const doFetch: FetchImpl = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const queryUrl = `${trimTrailingSlash(cloudApiUrl)}${GITHUB_QUERY_PATH}`;

  async function queryGitHubText(
    operation: string,
    params: Record<string, unknown>,
    acceptHeader: string,
    context: string,
  ): Promise<string | null> {
    const response = await doFetch(queryUrl, {
      method: "POST",
      headers: {
        Accept: acceptHeader,
        Authorization: `Bearer ${cloudApiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ workspaceId, operation, params }),
    });
    const bodyText = await response.text().catch(() => "");
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(
        `github cloud query ${context} failed: status=${response.status} body=${bodyText.slice(0, 200)}`,
      );
    }
    return bodyText;
  }

  async function queryGitHubJson<T>(
    operation: string,
    params: Record<string, unknown>,
    context: string,
  ): Promise<T | null> {
    const bodyText = await queryGitHubText(operation, params, GITHUB_JSON_ACCEPT, context);
    if (bodyText === null || bodyText.trim().length === 0) {
      return null;
    }
    try {
      return JSON.parse(bodyText) as T;
    } catch {
      throw new Error(
        `github cloud query ${context} returned invalid JSON: ${bodyText.slice(0, 200)}`,
      );
    }
  }

  async function searchIssues(
    query: string,
    repoSlug?: string,
  ): Promise<ListWrappedResult<{ items: unknown[] }>> {
    const body = await queryGitHubJson<{ items?: unknown[] }>(
      "searchIssues",
      { query, ...(repoSlug ? { repoSlug } : {}), per_page: MAX_PER_PAGE },
      `search ${query}`,
    );
    return {
      data: { items: body?.items ?? [] },
      source: "github.cloud.nango",
      timestamp: new Date().toISOString(),
    };
  }

  async function listPulls(
    owner: string,
    repo: string,
    opts?: ListOptions,
  ): Promise<ListWrappedResult<unknown[]>> {
    const state = opts?.state?.trim() || "all";
    const perPage = Math.min(Math.max(opts?.limit ?? DEFAULT_PER_PAGE, 1), MAX_PER_PAGE);
    const body = await queryGitHubJson<unknown[]>(
      "listPulls",
      { owner, repo, state, per_page: perPage },
      `listPulls ${owner}/${repo}`,
    );
    return {
      data: Array.isArray(body) ? body : [],
      source: "github.cloud.nango",
      timestamp: new Date().toISOString(),
    };
  }

  async function listIssues(
    owner: string,
    repo: string,
    opts?: ListOptions,
  ): Promise<ListWrappedResult<unknown[]>> {
    const state = opts?.state?.trim() || "all";
    const perPage = Math.min(Math.max(opts?.limit ?? DEFAULT_PER_PAGE, 1), MAX_PER_PAGE);
    const labelsParam =
      opts?.labels && opts.labels.length > 0
        ? { labels: opts.labels }
        : {};
    const body = await queryGitHubJson<unknown[]>(
      "listIssues",
      { owner, repo, state, per_page: perPage, ...labelsParam },
      `listIssues ${owner}/${repo}`,
    );
    // GitHub's /issues endpoint also returns PRs — filter out pull requests
    // so the issue enumeration path only surfaces genuine issues.
    const filtered = Array.isArray(body)
      ? body.filter((entry) => !(entry && typeof entry === "object" && "pull_request" in (entry as Record<string, unknown>)))
      : [];
    return {
      data: filtered,
      source: "github.cloud.nango",
      timestamp: new Date().toISOString(),
    };
  }

  async function getPull(
    owner: string,
    repo: string,
    number: number,
  ): Promise<ListWrappedResult<unknown | null>> {
    const body = await queryGitHubJson<unknown>(
      "getPull",
      { owner, repo, number },
      `getPull ${owner}/${repo}#${number}`,
    );
    return {
      data: body,
      source: "github.cloud.nango",
      timestamp: new Date().toISOString(),
    };
  }

  async function getPullDiff(
    owner: string,
    repo: string,
    number: number,
  ): Promise<ListWrappedResult<string | null>> {
    const body = await queryGitHubText(
      "getPullDiff",
      { owner, repo, number },
      GITHUB_DIFF_ACCEPT,
      `getPullDiff ${owner}/${repo}#${number}`,
    );
    return {
      data: body,
      source: "github.cloud.nango",
      timestamp: new Date().toISOString(),
    };
  }

  async function listAccessibleOrgs(): Promise<string[]> {
    const body = await queryGitHubJson<unknown[]>(
      "listOrgs",
      { per_page: MAX_PER_PAGE },
      "list accessible orgs",
    );
    return Array.isArray(body)
      ? body
          .map((entry) => (entry as GitHubOrgRecord | null)?.login)
          .filter((login): login is string => typeof login === "string" && login.trim().length > 0)
      : [];
  }

  async function getRepoExists(owner: string, repo: string): Promise<boolean> {
    const body = await queryGitHubText(
      "getRepo",
      { owner, repo },
      GITHUB_JSON_ACCEPT,
      `getRepo ${owner}/${repo}`,
    );
    return body !== null;
  }

  async function searchRepos(
    name: string,
    opts?: { orgs?: string[] },
  ): Promise<string[]> {
    const body = await queryGitHubJson<{ items?: unknown[] }>(
      "searchRepos",
      { query: name, per_page: 10 },
      `searchRepos ${name}`,
    );
    const allowedOwners = opts?.orgs && opts.orgs.length > 0
      ? new Set(opts.orgs.map((org) => org.toLowerCase()))
      : null;
    const repos = Array.isArray(body?.items) ? body.items : [];
    return repos
      .map((entry) => {
        const record = entry as GitHubRepoRecord | null;
        return typeof record?.full_name === "string" ? record.full_name : null;
      })
      .filter((fullName): fullName is string => {
        if (!fullName) return false;
        if (!allowedOwners) return true;
        const owner = fullName.split("/")[0]?.toLowerCase();
        return Boolean(owner && allowedOwners.has(owner));
      })
      .slice(0, 5);
  }

  return {
    searchIssues,
    listPulls,
    listIssues,
    getPull,
    getPullDiff,
    listAccessibleOrgs,
    getRepoExists,
    searchRepos,
    // readPRDiff is the name the investigator calls; alias it so either
    // spelling works from the fallback adapter.
    readPRDiff: getPullDiff,
  } as GitHubIntegration;
}

export interface BuildGitHubFallbackOptions {
  cloudApiUrl: string;
  cloudApiToken: string;
  workspaceId: string;
  fetchImpl?: FetchImpl;
  cloneRequester?: CloneRequester;
}

/**
 * Builds the investigator-side GitHubApiFallback. When a CloneRequester +
 * workspaceId are passed, any PR diff request fires a background clone
 * request so subsequent VFS lookups can hit fresh content.
 */
export function createGitHubApiFallback(
  options: BuildGitHubFallbackOptions,
): GitHubApiFallback {
  const integration = createGitHubIntegration({
    cloudApiUrl: options.cloudApiUrl,
    cloudApiToken: options.cloudApiToken,
    workspaceId: options.workspaceId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const base = createGitHubInvestigatorApiFallback(integration);
  const requester = options.cloneRequester;
  const workspaceId = options.workspaceId?.trim();
  if (!requester || !workspaceId) {
    return base;
  }

  return {
    async readPRDiff(owner: string, repo: string, number: number) {
      // Fire the clone in the background so the next VFS read has richer
      // content. Do NOT await — the API call below serves the immediate
      // need.
      try {
        requester.requestIfNeeded(workspaceId, owner, repo);
      } catch {
        // CloneRequester swallows its own errors; this catch is defensive.
      }
      const result = await base.readPRDiff(owner, repo, number);
      return result as Awaited<ReturnType<GitHubApiFallback["readPRDiff"]>>;
    },
  };
}

/**
 * Builds the librarian-side fallback. Same idea as the investigator
 * wrapper: a clone request fires per repo referenced in filters, and the
 * underlying github-api-fallback.ts does the actual REST calls.
 */
export function createGitHubLibrarianApiFallback(
  options: BuildGitHubFallbackOptions,
): GitHubLibrarianApiFallback {
  const integration = createGitHubIntegration({
    cloudApiUrl: options.cloudApiUrl,
    cloudApiToken: options.cloudApiToken,
    workspaceId: options.workspaceId,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const base = buildLibrarianFromIntegration(integration);
  const requester = options.cloneRequester;
  const workspaceId = options.workspaceId?.trim();

  const wrapped: GitHubLibrarianApiFallback = (async (request) => {
    if (requester && workspaceId) {
      const repoSlugs = extractRepoSlugs(
        request.filters,
        `${request.instruction} ${request.text}`,
      );
      for (const slug of repoSlugs) {
        const [owner, repo] = slug.split("/");
        if (!owner || !repo) continue;
        try {
          requester.requestIfNeeded(workspaceId, owner, repo);
        } catch {
          // no-op — CloneRequester is fire-and-forget.
        }
      }
    }
    return base(request);
  }) as GitHubLibrarianApiFallback;

  return wrapped;
}

function extractRepoSlugs(
  filters: Record<string, string[]>,
  text: string,
): string[] {
  const slugs = new Set<string>();

  for (const key of ["repo", "repository"]) {
    for (const value of filters[key] ?? []) {
      const slug = normalizeRepoSlug(value);
      if (slug) slugs.add(slug);
    }
  }

  for (const match of text.matchAll(/\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
    slugs.add(match[1]);
  }
  for (const match of text.matchAll(/github\.com\/(?:repos\/)?([^/\s?#]+)\/([^/\s?#]+)/gi)) {
    slugs.add(`${match[1]}/${match[2]}`);
  }

  return [...slugs];
}

function normalizeRepoSlug(raw: string): string | null {
  const cleaned = raw.trim().replace(/^repo:/i, "");
  const urlMatch = cleaned.match(
    /github\.com\/(?:repos\/)?([^/\s?#]+)\/([^/\s?#]+)(?:[/?#]|$)/i,
  );
  if (urlMatch) {
    return `${urlMatch[1]}/${urlMatch[2]}`;
  }
  const direct = cleaned.match(/^([^/\s?#]+)\/([^/\s?#]+)(?:[/?#]|$)/);
  if (direct) {
    return `${direct[1]}/${direct[2]}`;
  }
  return null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// Re-export the known-good underlying impls for direct wiring in tests.
export { createGitHubInvestigatorApiFallback };
export type { GitHubApiPullRequest };
