import type {
  GitHubApiFallback,
  GitHubApiPullRequest,
  GitHubLibrarianOptions,
} from "@agent-assistant/specialists";
import type { VfsEntry } from "@agent-assistant/vfs";
import {
  getPull as buildGetPullOperation,
  getPullDiff as buildGetPullDiffOperation,
  getRepository as buildGetRepositoryOperation,
  listIssues as buildListIssuesOperation,
  listOrgs as buildListOrgsOperation,
  listPullRequests as buildListPullRequestsOperation,
  listRepos as buildListReposOperation,
  searchIssues as buildSearchIssuesOperation,
  searchRepos as buildSearchReposOperation,
  type GitHubOperation,
  githubIssuePath,
  githubPullRequestPath,
} from "@relayfile/adapter-github";

export interface GitHubIntegration {
  searchIssues(query: string, repoSlug?: string): Promise<unknown>;
  listAccessibleOrgs(): Promise<string[]>;
  getRepoExists(owner: string, repo: string): Promise<boolean>;
  searchRepos(name: string, opts?: { orgs?: string[] }): Promise<string[]>;
}

const LOG_PREFIX = "[specialist/api-fallback]";
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const GITHUB_PROVIDER = "github";
const GITHUB_JSON_ACCEPT = "application/vnd.github+json";
const GITHUB_DIFF_ACCEPT = "application/vnd.github.v3.diff";

type GitHubEnumerationType = "pr" | "issue";
type GitHubListState = "open" | "closed" | "all";
// Narrow the upstream union to the function-call variant. The agent-assistant
// LibrarianApiFallback<T> type accepts EITHER `(req) => Promise<entries>` OR
// `{ list?, search? }`, but the GitHub cloud fallback implements the function
// variant and tests need a concrete callable type without an `as` cast.
type GitHubLibrarianApiFallback = Extract<
  NonNullable<GitHubLibrarianOptions["apiFallback"]>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (...args: any[]) => unknown
>;
type GitHubLibrarianApiFallbackImpl = (
  request: GitHubLibrarianFallbackRequest,
) => Promise<readonly FallbackVfsEntry[]>;

type JsonObject = Record<string, unknown>;
type WrappedResult<T> = { data: T; summary?: string; source?: string; timestamp?: string } | T;
type FallbackVfsEntry = VfsEntry & {
  content: string;
  contentType: "application/json";
};
interface GitHubRestRequest {
  accept: string;
  operation: GitHubOperation;
}

interface GitHubLibrarianFallbackRequest {
  instruction: string;
  text: string;
  filters: Record<string, string[]>;
  types: GitHubEnumerationType[];
}

interface GitHubRepoRef {
  owner: string;
  repo: string;
}

type RepoResolutionFailureReason =
  | "no_orgs_accessible"
  | "multiple_exact_matches"
  | "fuzzy_candidates"
  | "no_match";

type ResolveResult =
  | { kind: "resolved"; slug: string }
  | {
      kind: "ambiguous";
      bareName: string;
      reason: RepoResolutionFailureReason;
      candidates: string[];
    };

interface RepoResolution {
  repos: GitHubRepoRef[];
  failure?: Extract<ResolveResult, { kind: "ambiguous" }>;
}

interface GitHubListOptions {
  query?: string;
  state?: string;
  labels?: string[];
  limit?: number;
}

interface GitHubRepoListOptions {
  query?: string;
  limit?: number;
}

type GitHubIntegrationWithOptionalMethods = GitHubIntegration & {
  getPull?: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<WrappedResult<JsonObject | null> | null>;
  getPullDiff?: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<WrappedResult<JsonObject | string | null> | null>;
  readPRDiff?: (
    owner: string,
    repo: string,
    number: number,
  ) => Promise<WrappedResult<JsonObject | string | null> | null>;
  listIssues?: (
    owner: string,
    repo: string,
    options?: GitHubListOptions,
  ) => Promise<WrappedResult<readonly JsonObject[] | { items?: readonly JsonObject[] }> | null>;
  listPulls?: (
    owner: string,
    repo: string,
    options?: GitHubListOptions,
  ) => Promise<WrappedResult<readonly JsonObject[] | { items?: readonly JsonObject[] }> | null>;
  listRepos?: (
    queryOrOptions?: string | GitHubRepoListOptions,
    options?: GitHubRepoListOptions,
  ) => Promise<WrappedResult<readonly JsonObject[] | { items?: readonly JsonObject[] }> | null>;
};

interface LoadContext {
  filters: Record<string, string[]>;
  limit: number;
  query: string;
  repos: GitHubRepoRef[];
}

function buildEnumerationRequest(
  type: GitHubEnumerationType,
  owner: string,
  repo: string,
  options: {
    state?: string;
    labels?: string[];
    limit: number;
  },
): GitHubRestRequest {
  const perPage = clampLimit(options.limit);
  return {
    accept: GITHUB_JSON_ACCEPT,
    operation:
      type === "pr"
        ? buildListPullRequestsOperation({
            owner,
            repo,
            state: normalizeGitHubListState(options.state) ?? "all",
            per_page: perPage,
          })
        : buildListIssuesOperation({
            owner,
            repo,
            state: normalizeGitHubListState(options.state) ?? "all",
            labels: options.labels,
            per_page: perPage,
          }),
  };
}

function buildRepositoryLookupRequest(owner: string, repo: string): GitHubRestRequest {
  return {
    accept: GITHUB_JSON_ACCEPT,
    operation: buildGetRepositoryOperation({ owner, repo }),
  };
}

function buildRepositoryCollectionRequest(
  query: string,
  limit: number,
): GitHubRestRequest {
  return {
    accept: GITHUB_JSON_ACCEPT,
    operation: query.trim()
      ? buildSearchReposOperation({ query, per_page: clampLimit(limit) })
      : buildListReposOperation({ per_page: clampLimit(limit) }),
  };
}

function buildOrganizationsRequest(limit = MAX_LIMIT): GitHubRestRequest {
  return {
    accept: GITHUB_JSON_ACCEPT,
    operation: buildListOrgsOperation({ per_page: clampLimit(limit) }),
  };
}

function buildPullRequestRequest(owner: string, repo: string, number: number): GitHubRestRequest {
  return {
    accept: GITHUB_JSON_ACCEPT,
    operation: buildGetPullOperation({ owner, repo, number }),
  };
}

function buildPullDiffRequest(owner: string, repo: string, number: number): GitHubRestRequest {
  return {
    accept: GITHUB_DIFF_ACCEPT,
    operation: buildGetPullDiffOperation({ owner, repo, number }),
  };
}

async function callGitHubIntegration<T>(
  request: GitHubRestRequest,
  loader: () => Promise<T>,
): Promise<T> {
  try {
    return await loader();
  } catch (error) {
    throw new Error(`${describeGitHubRequest(request)} failed: ${errorMessage(error)}`);
  }
}

function describeGitHubRequest(request: GitHubRestRequest): string {
  const query = formatGitHubOperationQuery(request.operation.query);
  return `${request.operation.method} ${request.operation.path}${query} accept=${request.accept}`;
}

function formatGitHubOperationQuery(
  query: GitHubOperation["query"],
): string {
  if (!query) {
    return "";
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }

  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

function normalizeGitHubListState(value: string | undefined): GitHubListState | undefined {
  return value === "open" || value === "closed" || value === "all" ? value : undefined;
}

function clampLimit(value: number): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

export function createGitHubLibrarianApiFallback(
  github: GitHubIntegration,
): GitHubLibrarianApiFallbackImpl & GitHubLibrarianApiFallback {
  const integration = github as GitHubIntegrationWithOptionalMethods;

  const fallback: GitHubLibrarianApiFallbackImpl = async (
    request: GitHubLibrarianFallbackRequest,
  ): Promise<readonly FallbackVfsEntry[]> => {
    const filters = filtersFromRequest(request);
    const query = queryFromRequest(request);
    const types = typesFromRequest(request, filters);
    const limit = limitFromRequest(request);

    try {
      const repoResolution = await repoRefsFromRequest(
        integration,
        filters,
        `${query} ${request.instruction ?? ""}`,
      );
      const repos = repoResolution.repos;

      logInvocation("github librarian fallback invoked", {
        types,
        repos: repos.map((repo) => `${repo.owner}/${repo.repo}`),
        hasQuery: query.length > 0,
        limit,
      });

      if (repoResolution.failure) {
        return [repoResolutionFailureEntry(repoResolution.failure)];
      }

      if (hasRepoFilter(filters) && repos.length === 0) {
        return [invalidRepoSlugEntry(filters)];
      }

      const context: LoadContext = { filters, limit, query, repos };
      const entries: FallbackVfsEntry[] = [];

      for (const type of types) {
        entries.push(...(await loadEnumerationType(integration, type, context)));
        if (entries.length >= limit) {
          break;
        }
      }

      return dedupeEntries(entries).slice(0, limit);
    } catch (error) {
      logFailure("github librarian fallback failed", error);
      return [];
    }
  };

  return fallback as GitHubLibrarianApiFallbackImpl & GitHubLibrarianApiFallback;
}

export function createGitHubInvestigatorApiFallback(
  github: GitHubIntegration,
): GitHubApiFallback {
  const integration = github as GitHubIntegrationWithOptionalMethods;

  return {
    async readPRDiff(owner: string, repo: string, number: number) {
      logInvocation("github investigator fallback invoked", {
        repo: `${owner}/${repo}`,
        number,
      });

      try {
        const pull = await readPullRequest(integration, owner, repo, number);
        return pull ? { data: pull } : null;
      } catch (error) {
        logFailure("github investigator fallback failed", error);
        return null;
      }
    },
  };
}

async function loadEnumerationType(
  github: GitHubIntegrationWithOptionalMethods,
  type: GitHubEnumerationType,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  const listEntries = await loadEntriesFromListMethods(github, type, context);
  if (listEntries.length > 0) {
    return listEntries;
  }

  return loadEntriesFromSearch(github, type, context);
}

async function loadEntriesFromListMethods(
  github: GitHubIntegrationWithOptionalMethods,
  type: GitHubEnumerationType,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  const listMethod = type === "pr" ? github.listPulls : github.listIssues;
  if (!listMethod) {
    return [];
  }

  const repos =
    context.repos.length > 0
      ? context.repos
      : await listReposFromApi(github, context.query, context.limit);
  const entries: FallbackVfsEntry[] = [];

  for (const repoRef of repos) {
    const listOptions: GitHubListOptions = {
      query: context.query,
      state: firstFilterValue(context.filters, "state"),
      labels: context.filters.label ?? [],
      limit: context.limit,
    };
    const request = buildEnumerationRequest(type, repoRef.owner, repoRef.repo, {
      state: listOptions.state,
      labels: listOptions.labels,
      limit: listOptions.limit ?? context.limit,
    });
    const result = await safeGitHubCall(describeGitHubRequest(request), () =>
      listMethod.call(github, repoRef.owner, repoRef.repo, listOptions),
    );

    for (const item of recordsFromResult(result)) {
      const entry = toGitHubEntry(type, item, repoRef);
      if (entry) {
        entries.push(entry);
      }
    }

    if (entries.length >= context.limit) {
      break;
    }
  }

  return entries.slice(0, context.limit);
}

async function loadEntriesFromSearch(
  github: GitHubIntegrationWithOptionalMethods,
  type: GitHubEnumerationType,
  context: LoadContext,
): Promise<FallbackVfsEntry[]> {
  if (hasRepoFilter(context.filters) && context.repos.length === 0) {
    return [invalidRepoSlugEntry(context.filters)];
  }

  const targets = context.repos.length > 0 ? context.repos : [undefined];
  const entries: FallbackVfsEntry[] = [];

  for (const repoRef of targets) {
    const query = buildSearchQuery(type, context.filters, context.query);
    const repoSlug = repoRef ? `${repoRef.owner}/${repoRef.repo}` : undefined;
    const request = {
      accept: GITHUB_JSON_ACCEPT,
      operation: buildSearchIssuesOperation({
        query,
        repoSlug,
        per_page: clampLimit(context.limit),
      }),
    };
    const result = await safeGitHubCall(describeGitHubRequest(request), () =>
      github.searchIssues(query, repoSlug),
    );

    for (const item of recordsFromResult(result)) {
      const entry = toGitHubEntry(type, item, repoRef);
      if (entry) {
        entries.push(entry);
      }
    }

    if (entries.length >= context.limit) {
      break;
    }
  }

  return entries.slice(0, context.limit);
}

async function listReposFromApi(
  github: GitHubIntegrationWithOptionalMethods,
  query: string,
  limit: number,
): Promise<GitHubRepoRef[]> {
  if (!github.listRepos) {
    return [];
  }

  const listRepos = github.listRepos;
  const request = buildRepositoryCollectionRequest(query, limit);
  const result = await safeGitHubCall(describeGitHubRequest(request), () =>
    listRepos(query || undefined, { limit }),
  );

  return dedupeRepos(recordsFromResult(result).map(repoRefFromValue).filter(isDefined)).slice(
    0,
    limit,
  );
}

async function readPullRequest(
  github: GitHubIntegrationWithOptionalMethods,
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubApiPullRequest | null> {
  let pull: GitHubApiPullRequest | null = null;
  let diff: string | null | undefined;

  const getPullDiff = github.getPullDiff;
  if (getPullDiff) {
    const diffRequest = buildPullDiffRequest(owner, repo, number);
    const diffResult = await safeGitHubCall(describeGitHubRequest(diffRequest), () =>
      getPullDiff(owner, repo, number),
    );
    if (isFailedIntegrationResult(diffResult)) {
      return null;
    }

    const diffData = unwrapData(diffResult);
    if (typeof diffData === "string") {
      diff = diffData;
    } else if (isRecord(diffData)) {
      pull = mergePullRequest(pull, normalizePullRequest(diffData, number));
    }
  }

  const getPull = github.getPull;
  if (getPull) {
    const pullRequest = buildPullRequestRequest(owner, repo, number);
    const pullResult = await safeGitHubCall(describeGitHubRequest(pullRequest), () =>
      getPull(owner, repo, number),
    );
    if (isFailedIntegrationResult(pullResult)) {
      return null;
    }

    const pullData = unwrapData(pullResult);
    if (isRecord(pullData)) {
      pull = mergePullRequest(pull, normalizePullRequest(pullData, number));
    }
  }

  const readPRDiff = github.readPRDiff;
  if (!pull && diff === undefined && readPRDiff) {
    const prDiffResult = await safeGitHubCall("read pull request diff", () =>
      readPRDiff(owner, repo, number),
    );
    if (isFailedIntegrationResult(prDiffResult)) {
      return null;
    }

    const prDiffData = unwrapData(prDiffResult);
    if (isRecord(prDiffData)) {
      pull = mergePullRequest(pull, normalizePullRequest(prDiffData, number));
    }
  }

  if (!pull && typeof diff === "string") {
    pull = { number, diff };
  } else if (pull && diff !== undefined) {
    pull.diff = diff;
  }

  return hasUsablePullRequest(pull) ? pull : null;
}

function toGitHubEntry(
  type: GitHubEnumerationType,
  item: JsonObject,
  repoHint?: GitHubRepoRef,
): FallbackVfsEntry | null {
  const repoRef = repoHint ?? repoRefFromValue(item);
  const number = numberFromValue(item);
  if (!repoRef || number === undefined) {
    return null;
  }

  const url = firstString(item.html_url, item.url);
  const title = firstString(item.title, `${type === "pr" ? "PR" : "Issue"} #${number}`);
  const state = firstString(item.state);
  const labels = labelsFromValue(item.labels);
  const updatedAt = firstString(item.updated_at, item.updatedAt);
  const body = nullableString(item.body);
  const repoSlug = `${repoRef.owner}/${repoRef.repo}`;
  const path =
    type === "pr"
      ? githubPullRequestPath(repoRef.owner, repoRef.repo, String(number))
      : githubIssuePath(repoRef.owner, repoRef.repo, String(number));
  const content = safeStringify({
    type,
    repo: repoSlug,
    number,
    title,
    state,
    labels,
    url,
    body,
    raw: item,
  });

  return {
    path,
    type: "file",
    provider: GITHUB_PROVIDER,
    title,
    ...(updatedAt ? { updatedAt } : {}),
    size: content.length,
    properties: compactStringRecord({
      id: firstString(item.id, path),
      type,
      repo: repoSlug,
      repository: repoSlug,
      number: String(number),
      title,
      state,
      label: labels.join(","),
      labels: JSON.stringify(labels),
      url,
    }),
    content,
    contentType: "application/json",
  };
}

function normalizePullRequest(
  value: JsonObject,
  fallbackNumber: number,
): GitHubApiPullRequest {
  const number = readNumber(value.number) ?? fallbackNumber;
  const author = authorFromValue(value.author) ?? authorFromValue(value.user);
  const labels = labelsFromValue(value.labels);

  return compactPullRequest({
    number,
    title: firstString(value.title),
    body: nullableString(value.body),
    state: firstString(value.state),
    diff: nullableString(value.diff),
    url: firstString(value.url),
    html_url: firstString(value.html_url),
    ...(author ? { author } : {}),
    ...(isRecord(value.user) ? { user: userFromValue(value.user) } : {}),
    ...(branchRecord(value.base) ? { base: branchRecord(value.base) } : {}),
    ...(branchRecord(value.head) ? { head: branchRecord(value.head) } : {}),
    baseBranch: firstString(value.baseBranch, value.base_branch),
    headBranch: firstString(value.headBranch, value.head_branch),
    base_branch: firstString(value.base_branch, value.baseBranch),
    head_branch: firstString(value.head_branch, value.headBranch),
    ...(labels.length > 0 ? { labels } : {}),
    reviewStatus: firstString(value.reviewStatus, value.review_status),
    review_status: firstString(value.review_status, value.reviewStatus),
  });
}

function mergePullRequest(
  current: GitHubApiPullRequest | null,
  next: GitHubApiPullRequest,
): GitHubApiPullRequest {
  if (!current) {
    return next;
  }

  const merged: Partial<GitHubApiPullRequest> = { ...current };
  for (const [key, value] of Object.entries(next) as Array<
    [keyof GitHubApiPullRequest, GitHubApiPullRequest[keyof GitHubApiPullRequest]]
  >) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string" && value.length === 0 && merged[key]) {
      continue;
    }
    merged[key] = value as never;
  }
  return merged as GitHubApiPullRequest;
}

function hasUsablePullRequest(value: GitHubApiPullRequest | null): value is GitHubApiPullRequest {
  if (!value) {
    return false;
  }

  const state = value.state?.toLowerCase();
  const hasContent = Boolean(value.title || value.body || value.diff || value.url || value.html_url);
  if (state === "error" && !hasContent) {
    return false;
  }

  return value.number !== undefined || hasContent;
}

function buildSearchQuery(
  type: GitHubEnumerationType,
  filters: Record<string, string[]>,
  text: string,
): string {
  const parts = text.trim() ? [text.trim()] : [];
  appendQualifier(parts, "type", type === "pr" ? "pr" : "issue");

  for (const state of filters.state ?? []) {
    appendQualifier(parts, "state", state);
  }
  for (const label of filters.label ?? []) {
    appendQualifier(parts, "label", label);
  }

  return parts.join(" ").trim() || `type:${type === "pr" ? "pr" : "issue"}`;
}

function appendQualifier(parts: string[], key: string, value: string): void {
  if (!value.trim()) {
    return;
  }

  const existing = new RegExp(`\\b${escapeRegExp(key)}:`, "i");
  if (parts.some((part) => existing.test(part))) {
    return;
  }

  const safeValue = /\s/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
  parts.push(`${key}:${safeValue}`);
}

function filtersFromRequest(request: unknown): Record<string, string[]> {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const directFilters = readFilterRecord(record.filters);
  const paramsFilters = readFilterRecord(params.filters);
  const directKeys = readKnownFilterKeys(record);
  const paramsKeys = readKnownFilterKeys(params);

  return mergeFilters(directFilters, paramsFilters, directKeys, paramsKeys);
}

function readKnownFilterKeys(record: Record<string, unknown>): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const key of ["repo", "repository", "label", "state", "type"]) {
    const values = readStringArray(record[key]);
    if (values.length > 0) {
      output[key] = values;
    }
  }
  return output;
}

function queryFromRequest(request: unknown): string {
  const record = asRecord(request);
  const params = asRecord(record.params);
  return firstString(params.query, record.query, record.text, record.instruction) ?? "";
}

function limitFromRequest(request: unknown): number {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const requested = readNumber(params.limit) ?? readNumber(record.limit) ?? DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(requested)));
}

function typesFromRequest(
  request: unknown,
  filters: Record<string, string[]>,
): GitHubEnumerationType[] {
  const record = asRecord(request);
  const params = asRecord(record.params);
  const requested = [
    ...readStringArray(record.types),
    ...readStringArray(params.types),
    ...(filters.type ?? []),
  ]
    .map(normalizeEnumerationType)
    .filter(isDefined);

  const deduped = [...new Set(requested)];
  return deduped.length > 0 ? deduped : ["pr", "issue"];
}

export async function repoRefsFromRequest(
  github: GitHubIntegration,
  filters: Record<string, string[]>,
  text: string,
): Promise<RepoResolution> {
  const repos: GitHubRepoRef[] = [];

  for (const value of [...(filters.repo ?? []), ...(filters.repository ?? [])]) {
    const repoRef = parseRepoRef(value);
    if (repoRef) {
      repos.push(repoRef);
      continue;
    }

    const bareName = bareRepoName(value);
    if (!bareName) {
      continue;
    }

    const result = await resolveBareRepoSlug(bareName, github);
    if (result.kind === "ambiguous") {
      return { repos: dedupeRepos(repos), failure: result };
    }

    const resolvedRepo = parseRepoRef(result.slug);
    if (resolvedRepo) {
      repos.push(resolvedRepo);
    }
  }

  for (const slug of repoSlugsFromText(text)) {
    const repoRef = parseRepoRef(slug);
    if (repoRef) {
      repos.push(repoRef);
    }
  }

  return { repos: dedupeRepos(repos) };
}

export async function resolveBareRepoSlug(
  raw: string,
  integration: GitHubIntegration,
): Promise<ResolveResult> {
  const parsed = parseRepoRef(raw);
  if (parsed) {
    return { kind: "resolved", slug: `${parsed.owner}/${parsed.repo}` };
  }

  const bareName = bareRepoName(raw);
  if (!bareName) {
    return { kind: "ambiguous", bareName: String(raw), reason: "no_match", candidates: [] };
  }

  const orgsRequest = buildOrganizationsRequest();
  const orgs = dedupeStrings(
    (
      await callGitHubIntegration(orgsRequest, () => integration.listAccessibleOrgs())
    ).filter(isRepoSegment),
  );
  if (orgs.length === 0) {
    return { kind: "ambiguous", bareName, reason: "no_orgs_accessible", candidates: [] };
  }

  if (orgs.length === 1) {
    const owner = orgs[0];
    const repoRequest = buildRepositoryLookupRequest(owner, bareName);
    if (await callGitHubIntegration(repoRequest, () => integration.getRepoExists(owner, bareName))) {
      return { kind: "resolved", slug: `${owner}/${bareName}` };
    }
    return fuzzyFallback(integration, orgs, bareName);
  }

  const exactMatches: string[] = [];
  for (const owner of orgs) {
    const repoRequest = buildRepositoryLookupRequest(owner, bareName);
    if (await callGitHubIntegration(repoRequest, () => integration.getRepoExists(owner, bareName))) {
      exactMatches.push(`${owner}/${bareName}`);
    }
  }

  if (exactMatches.length === 1) {
    return { kind: "resolved", slug: exactMatches[0] };
  }
  if (exactMatches.length > 1) {
    return {
      kind: "ambiguous",
      bareName,
      reason: "multiple_exact_matches",
      candidates: exactMatches,
    };
  }

  return fuzzyFallback(integration, orgs, bareName);
}

async function fuzzyFallback(
  integration: GitHubIntegration,
  orgs: string[],
  bareName: string,
): Promise<ResolveResult> {
  const allowedOwners = new Set(orgs.map((org) => org.toLowerCase()));
  const searchRequest = buildRepositoryCollectionRequest(bareName, 10);
  const candidates = dedupeStrings(
    await callGitHubIntegration(searchRequest, () => integration.searchRepos(bareName, { orgs })),
  )
    .filter((slug) => {
      const owner = parseRepoRef(slug)?.owner;
      return owner ? allowedOwners.has(owner.toLowerCase()) : false;
    })
    .slice(0, 5);

  return {
    kind: "ambiguous",
    bareName,
    reason: candidates.length === 0 ? "no_match" : "fuzzy_candidates",
    candidates,
  };
}

function recordsFromResult(value: unknown): JsonObject[] {
  if (isFailedIntegrationResult(value)) {
    return [];
  }

  const data = unwrapData(value);
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data) && Array.isArray(data.items)) {
    return data.items.filter(isRecord);
  }
  if (isRecord(data) && Array.isArray(data.repositories)) {
    return data.repositories.filter(isRecord);
  }
  return [];
}

function unwrapData(value: unknown): unknown {
  if (
    isRecord(value) &&
    "data" in value &&
    ("summary" in value || "source" in value || "timestamp" in value)
  ) {
    return value.data;
  }
  return value;
}

function isFailedIntegrationResult(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const summary = firstString(value.summary)?.toLowerCase();
  return Boolean(
    summary &&
      (summary.includes("request failed") ||
        summary.includes("rate limit") ||
        summary.includes("not found") ||
        summary.includes("missing connection") ||
        summary.includes("connection not found")),
  );
}

async function safeGitHubCall<T>(
  action: string,
  loader: () => Promise<T | null | undefined>,
): Promise<T | null> {
  try {
    return (await loader()) ?? null;
  } catch (error) {
    logFailure(`github ${action} failed`, error);
    return null;
  }
}

function repoRefFromValue(value: unknown): GitHubRepoRef | null {
  if (typeof value === "string") {
    return parseRepoRef(value);
  }
  if (!isRecord(value)) {
    return null;
  }

  const direct = parseRepoRef(firstString(value.full_name, value.fullName, value.repo, value.repository));
  if (direct) {
    return direct;
  }

  const owner = ownerFromValue(value.owner);
  const repo = firstString(value.name, value.repoName, value.repositoryName);
  if (owner && repo) {
    return { owner, repo };
  }

  const nestedRepo = repoRefFromValue(value.repo) ?? repoRefFromValue(value.repository);
  if (nestedRepo) {
    return nestedRepo;
  }

  const apiUrl = firstString(value.repository_url);
  const url = firstString(value.html_url, value.url);
  return parseRepoRef(apiUrl) ?? parseRepoRef(url);
}

function parseRepoRef(value: unknown): GitHubRepoRef | null {
  const raw = firstString(value);
  if (!raw) {
    return null;
  }

  const cleaned = raw.trim().replace(/^repo:/i, "");
  const urlMatch = cleaned.match(
    /github\.com\/(?:repos\/)?([^/\s?#]+)\/([^/\s?#]+)(?:[/?#]|$)/i,
  );
  const slug = urlMatch
    ? `${urlMatch[1]}/${urlMatch[2]}`
    : cleaned.match(/^([^/\s?#]+)\/([^/\s?#]+)(?:[/?#]|$)/)?.slice(1, 3).join("/");
  if (!slug) {
    return null;
  }

  const [owner, repo] = slug.split("/");
  if (!owner || !repo) {
    return null;
  }

  return { owner: decodePathSegment(owner), repo: decodePathSegment(repo) };
}

function bareRepoName(value: unknown): string | null {
  const raw = firstString(value);
  if (!raw) {
    return null;
  }
  const cleaned = raw.trim().replace(/^repo:/i, "");
  return isRepoSegment(cleaned) ? decodePathSegment(cleaned) : null;
}

function isRepoSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function hasRepoFilter(filters: Record<string, string[]>): boolean {
  return (filters.repo?.some((value) => value.trim().length > 0) ?? false) ||
    (filters.repository?.some((value) => value.trim().length > 0) ?? false);
}

function invalidRepoSlugEntry(filters: Record<string, string[]>): FallbackVfsEntry {
  const summary = "Specify the repo as <owner>/<name> (e.g. AgentWorkforce/cloud)";
  const content = safeStringify({
    type: "warning",
    warning: "invalid_repo_slug",
    summary,
    filters: {
      repo: filters.repo ?? [],
      repository: filters.repository ?? [],
    },
  });

  return {
    path: "/github/warnings/invalid_repo_slug.json",
    type: "file",
    provider: GITHUB_PROVIDER,
    title: "Invalid GitHub repo slug",
    size: content.length,
    properties: {
      id: "invalid_repo_slug",
      type: "warning",
      warning: "invalid_repo_slug",
      summary,
    },
    content,
    contentType: "application/json",
  };
}

function repoResolutionFailureEntry(
  failure: Extract<ResolveResult, { kind: "ambiguous" }>,
): FallbackVfsEntry {
  const candidates = failure.candidates.slice(0, 5);
  const summary = `Could not resolve "${failure.bareName}" to a single repo. Candidates: ${
    candidates.join(", ") || "none"
  }. Ask the user to specify owner/name (e.g. AgentWorkforce/${failure.bareName}).`;
  const content = safeStringify({
    warning: "ambiguous_repo_slug",
    summary,
    candidates,
  });

  return {
    path: "/_meta/repo-resolution-failed.json",
    type: "file",
    provider: GITHUB_PROVIDER,
    title: "GitHub repo resolution failed",
    size: content.length,
    properties: {
      warning: "ambiguous_repo_slug",
      bare_name: failure.bareName,
      reason: failure.reason,
      candidates: candidates.join(", "),
    },
    content,
    contentType: "application/json",
  };
}

function repoSlugsFromText(text: string): string[] {
  // Only accept explicit repo references. The previous permissive match on any
  // `word/word` sequence misread file paths like `src/harness/slack-runner.ts`
  // as repo slugs and scoped the API fallback to nonexistent repos.
  const slugs = new Set<string>();
  for (const match of text.matchAll(/\brepo:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
    slugs.add(match[1]);
  }
  for (const match of text.matchAll(/github\.com\/(?:repos\/)?([^/\s?#]+)\/([^/\s?#]+)/gi)) {
    slugs.add(`${match[1]}/${match[2]}`);
  }
  return [...slugs];
}

function numberFromValue(value: JsonObject): number | undefined {
  return (
    readNumber(value.number) ??
    readNumber(value.pull_number) ??
    readNumber(value.issue_number) ??
    numberFromUrl(firstString(value.html_url, value.url))
  );
}

function numberFromUrl(value: string | undefined): number | undefined {
  const match = value?.match(/\/(?:pull|pulls|issues?)\/(\d+)(?:[/?#]|$)/i);
  return match ? readNumber(match[1]) : undefined;
}

function labelsFromValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (isRecord(item) ? firstString(item.name) : firstString(item)))
      .filter(isDefined);
  }

  const text = firstString(value);
  if (!text) {
    return [];
  }

  if (text.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (Array.isArray(parsed)) {
        return labelsFromValue(parsed);
      }
    } catch {
      // Fall through to comma-separated labels.
    }
  }

  return text
    .split(",")
    .map((label) => label.trim())
    .filter(Boolean);
}

function ownerFromValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (isRecord(value)) {
    return firstString(value.login, value.name);
  }
  return undefined;
}

function authorFromValue(value: unknown): GitHubApiPullRequest["author"] | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const login = firstString(value.login);
  const name = firstString(value.name);
  return login || name ? { ...(login ? { login } : {}), ...(name ? { name } : {}) } : undefined;
}

function userFromValue(value: JsonObject): { login?: string; name?: string } {
  const login = firstString(value.login);
  const name = firstString(value.name);
  return { ...(login ? { login } : {}), ...(name ? { name } : {}) };
}

function branchRecord(value: unknown): { ref?: string } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const ref = firstString(value.ref);
  return ref ? { ref } : undefined;
}

function compactPullRequest(input: GitHubApiPullRequest): GitHubApiPullRequest {
  const output: Partial<GitHubApiPullRequest> = {};
  for (const [key, value] of Object.entries(input) as Array<
    [keyof GitHubApiPullRequest, GitHubApiPullRequest[keyof GitHubApiPullRequest]]
  >) {
    if (value !== undefined) {
      output[key] = value as never;
    }
  }
  return output as GitHubApiPullRequest;
}

function compactStringRecord(input: Record<string, string | undefined>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && value.length > 0) {
      output[key] = value;
    }
  }
  return output;
}

function mergeFilters(...sources: Record<string, string[]>[]): Record<string, string[]> {
  const output: Record<string, string[]> = {};
  for (const source of sources) {
    for (const [key, values] of Object.entries(source)) {
      output[key] = [...new Set([...(output[key] ?? []), ...values])];
    }
  }
  return output;
}

function readFilterRecord(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    return {};
  }

  const output: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const values = readStringArray(raw);
    if (values.length > 0) {
      output[key] = values;
    }
  }
  return output;
}

function firstFilterValue(filters: Record<string, string[]>, key: string): string | undefined {
  return filters[key]?.find((value) => value.trim().length > 0);
}

function readStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => firstString(item)).filter(isDefined);
  }
  const text = firstString(value);
  return text ? [text] : [];
}

function normalizeEnumerationType(value: string): GitHubEnumerationType | undefined {
  const normalized = value.trim().toLowerCase();
  if (["pr", "prs", "pull", "pulls", "pull_request", "pull-request", "pull request"].includes(normalized)) {
    return "pr";
  }
  if (["issue", "issues"].includes(normalized)) {
    return "issue";
  }
  return undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return firstString(value);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(normalized);
  }
  return output;
}

function dedupeEntries(entries: FallbackVfsEntry[]): FallbackVfsEntry[] {
  const seen = new Set<string>();
  const output: FallbackVfsEntry[] = [];
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      continue;
    }
    seen.add(entry.path);
    output.push(entry);
  }
  return output;
}

function dedupeRepos(repos: GitHubRepoRef[]): GitHubRepoRef[] {
  const seen = new Set<string>();
  const output: GitHubRepoRef[] = [];
  for (const repo of repos) {
    const key = `${repo.owner}/${repo.repo}`.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(repo);
  }
  return output;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return JSON.stringify({ value: String(value) });
  }
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function logInvocation(message: string, metadata: Record<string, unknown>): void {
  console.info(LOG_PREFIX, message, metadata);
}

function logFailure(message: string, error: unknown): void {
  console.warn(LOG_PREFIX, message, errorMessage(error));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (isRecord(error)) {
    const response = asRecord(error.response);
    const status = firstString(response.status);
    const data = asRecord(response.data);
    const message = firstString(data.message, error.message);
    return [status ? `status ${status}` : undefined, message].filter(isDefined).join(": ");
  }
  return String(error);
}
