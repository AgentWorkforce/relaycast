import { RelayFileClient, type FileReadResponse } from "@relayfile/sdk";
import { mintRelayfileToken } from "@cloud/core/relayfile/client.js";
import {
  githubByIdAliasPath,
  githubCheckRunPath,
  githubCommitPath,
  githubDeploymentStatusPath,
  githubIssuePath,
  githubNumberSlug,
  githubPullRequestPath,
  githubRepoIssuesIndexPath,
  githubRepoPullsIndexPath,
  githubReposIndexPath,
  githubReviewCommentPath,
  githubReviewPath,
} from "@relayfile/adapter-github/path-mapper";
import { resolveRelayfileConfig } from "../relayfile";

export type GitHubRepoRef = {
  owner: string;
  repo: string;
};

export type GitHubPullRequest = {
  number: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  author?: {
    login?: string;
    avatar_url?: string;
  };
  url?: string;
  body?: string | null;
  [key: string]: unknown;
};

export type GitHubIssue = {
  number: number;
  title?: string;
  state?: string;
  url?: string;
  body?: string | null;
  [key: string]: unknown;
};

export type GitHubReview = {
  id: number | string;
  state?: string;
  body?: string | null;
  submitted_at?: string;
  user?: {
    login?: string;
    avatar_url?: string;
  };
  [key: string]: unknown;
};

export type GitHubNormalizedWebhook = {
  provider: "github";
  connectionId: string;
  eventType: string;
  objectType: string;
  objectId: string;
  payload: Record<string, unknown>;
};

export type GitHubWebhookRecordWriterTarget = {
  syncName: string;
  model: string;
};

export const GITHUB_RELAYFILE_FILE_UPDATED_EVENT = "file.updated";
export const GITHUB_RELAYFILE_FILE_DELETED_EVENT = "file.deleted";

const GITHUB_ISSUES_SYNC_NAME = "fetch-open-issues";
const GITHUB_PULL_REQUESTS_SYNC_NAME = "fetch-open-prs";
const REMOVAL_OPERATIONS = new Set([
  "delete",
  "deletion",
  "deleted",
  "disconnect",
  "disconnected",
  "disconnection",
  "remove",
  "removed",
  "revoked",
]);

type GitHubRepoIndexRow = {
  id: string;
  title?: string;
  updated?: string;
};

type GitHubRecordIndexRow = GitHubRepoIndexRow & {
  number?: number;
  state?: string;
};

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function rootClient(workspaceId: string): RelayFileClient {
  const { relayfileUrl, relayAuthUrl, relayAuthApiKey } = resolveRelayfileConfig();
  if (!relayfileUrl || !relayAuthApiKey) {
    throw new Error("Relayfile is not configured.");
  }

  return new RelayFileClient({
    baseUrl: relayfileUrl,
    readCache: {},
    token: () => mintRelayfileToken({
      workspaceId,
      relayAuthUrl,
      relayAuthApiKey,
      agentName: "cloud-github",
    }),
  });
}

function repoRoot(owner: string, repo: string): string {
  return `/github/repos/${encodeSegment(owner)}/${encodeSegment(repo)}`;
}

function parentDirFromPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : path;
}

function legacyPullRequestMetadataPath(owner: string, repo: string, number: number): string {
  return `${repoRoot(owner, repo)}/pulls/${encodeSegment(String(number))}/metadata.json`;
}

function isNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const record = error as Record<string, unknown>;
  return record.status === 404 || record.statusCode === 404 || record.code === "ENOENT";
}

function parseJson<T>(file: FileReadResponse): T {
  return JSON.parse(file.content) as T;
}

function getHeader(
  headers: Headers | Record<string, string | undefined>,
  key: string,
): string | null {
  if (headers instanceof Headers) {
    return headers.get(key);
  }

  const target = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(headers)) {
    if (entryKey.toLowerCase() === target && typeof value === "string") {
      return value;
    }
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" ? value : null;
}

function readIdentifier(record: Record<string, unknown> | null, key: string): number | string | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return null;
}

function readRecord(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return asRecord(record?.[key]);
}

function getRepoInfo(payload: Record<string, unknown>): GitHubRepoRef {
  const repository = asRecord(payload.repository);
  const owner =
    readString(asRecord(repository?.owner), "login") ??
    readString(asRecord(repository?.owner), "name") ??
    readString(repository, "full_name")?.split("/", 2)[0] ??
    "_owner";
  const repo =
    readString(repository, "name") ??
    readString(repository, "full_name")?.split("/", 2)[1] ??
    "_repo";

  return { owner, repo };
}

function issueCommentPath(
  owner: string,
  repo: string,
  issueNumber: number | string,
  commentId: number | string,
  issueTitle?: string,
): string {
  return `${repoRoot(owner, repo)}/issues/${githubNumberSlug(issueNumber, issueTitle)}/comments/${encodeSegment(String(commentId))}.json`;
}

function getEventType(
  headers: Headers | Record<string, string | undefined>,
  payload: Record<string, unknown>,
): string {
  const event = getHeader(headers, "x-github-event") ?? "";
  const action = readString(payload, "action");
  return action ? `${event}.${action}` : event;
}

function readWebhookIdentity(
  eventType: string,
  payload: Record<string, unknown>,
): { objectType: string; objectId: string } {
  const review = asRecord(payload.review);
  const pullRequest = asRecord(payload.pull_request);
  const issue = asRecord(payload.issue);
  const comment = asRecord(payload.comment);
  const checkRun = asRecord(payload.check_run);
  const headCommit = asRecord(payload.head_commit);

  if (eventType.startsWith("pull_request_review_comment.")) {
    return {
      objectType: "review_comment",
      objectId: String(readNumber(comment, "id") ?? "unknown"),
    };
  }

  if (eventType.startsWith("pull_request_review.")) {
    return {
      objectType: "review",
      objectId: String(readNumber(review, "id") ?? "unknown"),
    };
  }

  if (eventType.startsWith("pull_request.")) {
    return {
      objectType: "pull_request",
      objectId: String(readNumber(pullRequest, "number") ?? readNumber(payload as Record<string, unknown>, "number") ?? "unknown"),
    };
  }

  if (eventType.startsWith("issues.")) {
    return {
      objectType: "issue",
      objectId: String(readNumber(issue, "number") ?? "unknown"),
    };
  }

  if (eventType.startsWith("issue_comment.")) {
    return {
      objectType: "issue_comment",
      objectId: String(readNumber(comment, "id") ?? "unknown"),
    };
  }

  if (eventType.startsWith("check_run.")) {
    return {
      objectType: "check_run",
      objectId: String(readNumber(checkRun, "id") ?? "unknown"),
    };
  }

  if (eventType.startsWith("deployment_status.")) {
    return {
      objectType: "deployment_status",
      objectId: String(readIdentifier(asRecord(payload.deployment_status), "id") ?? "unknown"),
    };
  }

  if (eventType === "push") {
    return {
      objectType: "commit",
      objectId:
        readString(headCommit, "id") ??
        readString(payload, "after") ??
        "unknown",
    };
  }

  return {
    objectType: "event",
    objectId: readString(payload, "id") ?? (eventType || "unknown"),
  };
}

export function normalizeWebhook(input: {
  headers: Headers | Record<string, string | undefined>;
  payload: Record<string, unknown>;
  connectionId: string;
}): GitHubNormalizedWebhook {
  const eventType = getEventType(input.headers, input.payload);
  const { objectType, objectId } = readWebhookIdentity(eventType, input.payload);

  return {
    provider: "github",
    connectionId: input.connectionId,
    eventType,
    objectType,
    objectId,
    payload: input.payload,
  };
}

export function computePath(event: GitHubNormalizedWebhook): string {
  const { owner, repo } = getRepoInfo(event.payload);
  const base = repoRoot(owner, repo);
  const payload = event.payload;
  const review = asRecord(payload.review);
  const pullRequest = asRecord(payload.pull_request);
  const issue = asRecord(payload.issue);
  const comment = asRecord(payload.comment);
  const checkRun = asRecord(payload.check_run);

  // Delegate to the `@relayfile/adapter-github/path-mapper` helpers so forward
  // webhooks land at the same canonical paths the sync writer
  // (`writeGitHubRecord` in `@cloud/core/sync/record-writer`) produces. Before
  // cloud#526's `e18da6a9` switch to adapter-driven paths the sync used the
  // legacy `<n>/metadata.json` shape this file once hardcoded; now both
  // pipelines must agree on `<n>__<slug>/meta.json` (PRs/issues) and the flat
  // `reviews/<id>.json` / `comments/<id>.json` (reviews / review comments).
  // Otherwise a single PR materializes twice on disk with divergent names —
  // see cloud#529 for the github-content half of this gap.
  if (event.eventType.startsWith("pull_request_review_comment.")) {
    const commentId = readNumber(comment, "id") ?? 0;
    return githubReviewCommentPath(owner, repo, commentId);
  }

  if (event.eventType.startsWith("pull_request_review.")) {
    const reviewId = readNumber(review, "id") ?? 0;
    return githubReviewPath(owner, repo, reviewId);
  }

  if (event.eventType.startsWith("pull_request.")) {
    const prTitle = readString(pullRequest, "title") ?? undefined;
    return githubPullRequestPath(owner, repo, event.objectId, prTitle);
  }

  if (event.eventType.startsWith("issues.")) {
    const issueNumber = readNumber(issue, "number") ?? event.objectId;
    const issueTitle = readString(issue, "title") ?? undefined;
    return githubIssuePath(owner, repo, issueNumber, issueTitle);
  }

  if (event.eventType.startsWith("issue_comment.")) {
    const issueNumber = readNumber(issue, "number") ?? "unknown";
    const issueTitle = readString(issue, "title") ?? undefined;
    const commentId = readNumber(comment, "id") ?? event.objectId;
    return issueCommentPath(owner, repo, issueNumber, commentId, issueTitle);
  }

  if (event.eventType.startsWith("check_run.")) {
    const checkRunId = readNumber(checkRun, "id") ?? event.objectId;
    return githubCheckRunPath(owner, repo, checkRunId);
  }

  if (event.eventType.startsWith("deployment_status.")) {
    const deployment = asRecord(payload.deployment);
    const deploymentStatus = asRecord(payload.deployment_status);
    const deploymentId = readIdentifier(deployment, "id") ?? "deployment-unknown";
    const statusId = readIdentifier(deploymentStatus, "id") ?? event.objectId;
    return githubDeploymentStatusPath(owner, repo, deploymentId, statusId);
  }

  if (event.eventType === "push") {
    return githubCommitPath(owner, repo, String(event.objectId));
  }

  return `${base}/events/${encodeSegment(event.eventType || "unknown")}.json`;
}

function withGitHubRepository(
  record: Record<string, unknown>,
  repository: Record<string, unknown> | null,
): Record<string, unknown> {
  const fullName = readString(repository, "full_name");
  const hasRepository = asRecord(record.repository);
  const hasFullName = readString(record, "full_name");

  if (!repository && (!fullName || hasFullName)) {
    return record;
  }

  return {
    ...record,
    ...(fullName && !hasFullName ? { full_name: fullName } : {}),
    ...(repository && !hasRepository ? { repository } : {}),
  };
}

function withGitHubAuthor(record: Record<string, unknown>): Record<string, unknown> {
  const author = record.author;
  if (typeof author === "string" && author.trim().length > 0) {
    return record;
  }
  if (readString(asRecord(author), "login")) {
    return record;
  }

  const user = readRecord(record, "user");
  const login = readString(user, "login");
  if (!login) {
    return record;
  }

  return {
    ...record,
    author: login,
  };
}

function readForwardAction(payload: Record<string, unknown>): string | null {
  return readString(payload, "action") ?? readString(readRecord(payload, "_webhook"), "action");
}

function fallbackWebhookAction(eventType: string): string | null {
  const parts = eventType.split(".").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] ?? null : null;
}

function buildGitHubWebhookMetadata(
  normalized: GitHubNormalizedWebhook,
): Record<string, unknown> {
  const label = readRecord(normalized.payload, "label");
  const labelName = readString(label, "name");
  return {
    eventType: normalized.eventType,
    action:
      readForwardAction(normalized.payload) ??
      fallbackWebhookAction(normalized.eventType),
    objectType: normalized.objectType,
    objectId: normalized.objectId,
    ...(labelName ? { labelName } : {}),
  };
}

function withGitHubWebhookMetadata(
  record: Record<string, unknown>,
  normalized: GitHubNormalizedWebhook,
): Record<string, unknown> {
  return {
    ...record,
    _webhook: {
      ...(readRecord(record, "_webhook") ?? {}),
      ...buildGitHubWebhookMetadata(normalized),
    },
  };
}

function isRemovalOperation(value: string): boolean {
  return REMOVAL_OPERATIONS.has(value.trim().toLowerCase());
}

export function isGitHubWebhookDeletionEvent(normalized: GitHubNormalizedWebhook): boolean {
  const eventAction = normalized.eventType.split(".").pop() ?? "";
  const payloadAction = readForwardAction(normalized.payload) ?? "";

  return [eventAction, payloadAction].some((candidate) =>
    candidate ? isRemovalOperation(candidate) : false,
  );
}

function readReactionCount(record: Record<string, unknown> | null, key: string): number {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function buildIssueCommentRecord(comment: Record<string, unknown>): Record<string, unknown> {
  const user = readRecord(comment, "user");
  const reactions = readRecord(comment, "reactions");

  return {
    id: readNumber(comment, "id") ?? 0,
    body: readString(comment, "body"),
    author: {
      login: readString(user, "login"),
      avatarUrl: readString(user, "avatar_url"),
    },
    created_at: readString(comment, "created_at"),
    updated_at: readString(comment, "updated_at"),
    reactions: {
      total_count: readReactionCount(reactions, "total_count"),
      "+1": readReactionCount(reactions, "+1"),
      "-1": readReactionCount(reactions, "-1"),
      laugh: readReactionCount(reactions, "laugh"),
      confused: readReactionCount(reactions, "confused"),
      eyes: readReactionCount(reactions, "eyes"),
      heart: readReactionCount(reactions, "heart"),
      hooray: readReactionCount(reactions, "hooray"),
      rocket: readReactionCount(reactions, "rocket"),
    },
  };
}

function buildDeploymentStatusRecord(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const deployment = readRecord(payload, "deployment");
  const deploymentStatus = readRecord(payload, "deployment_status");
  const status = deploymentStatus ?? payload;
  const deploymentId =
    readIdentifier(deployment, "id") ??
    readIdentifier(status, "deployment_id");
  const deploymentEnvironment = readString(deployment, "environment");
  const deploymentSha = readString(deployment, "sha");
  const targetUrl = readString(status, "target_url");
  const createdAt = readString(status, "created_at");
  const updatedAt = readString(status, "updated_at");

  return {
    ...status,
    ...(deploymentId !== null ? { deployment_id: deploymentId, deploymentId } : {}),
    ...(deploymentEnvironment
      ? {
          deployment_environment: deploymentEnvironment,
          environment: deploymentEnvironment,
        }
      : {}),
    ...(deploymentSha ? { deployment_sha: deploymentSha } : {}),
    ...(targetUrl ? { targetUrl } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(deployment ? { deployment } : {}),
  };
}

export function buildGitHubWebhookFileData(
  normalized: GitHubNormalizedWebhook,
): Record<string, unknown> {
  const payload = normalized.payload;
  const repository = readRecord(payload, "repository");

  if (normalized.objectType === "pull_request") {
    const pullRequest = readRecord(payload, "pull_request");
    return withGitHubWebhookMetadata(
      withGitHubAuthor(withGitHubRepository(pullRequest ?? payload, repository)),
      normalized,
    );
  }

  if (normalized.objectType === "issue") {
    const issue = readRecord(payload, "issue");
    return withGitHubWebhookMetadata(
      withGitHubRepository(issue ?? payload, repository),
      normalized,
    );
  }

  if (normalized.objectType === "issue_comment") {
    const comment = readRecord(payload, "comment");
    return withGitHubWebhookMetadata(
      buildIssueCommentRecord(comment ?? payload),
      normalized,
    );
  }

  if (normalized.objectType === "review") {
    const review = readRecord(payload, "review");
    return withGitHubWebhookMetadata(
      withGitHubRepository(review ?? payload, repository),
      normalized,
    );
  }

  if (normalized.objectType === "review_comment") {
    const comment = readRecord(payload, "comment");
    return withGitHubWebhookMetadata(
      withGitHubRepository(comment ?? payload, repository),
      normalized,
    );
  }

  if (normalized.objectType === "check_run") {
    const checkRun = readRecord(payload, "check_run");
    return withGitHubWebhookMetadata(
      withGitHubRepository(checkRun ?? payload, repository),
      normalized,
    );
  }

  if (normalized.objectType === "deployment_status") {
    return withGitHubWebhookMetadata(
      withGitHubRepository(buildDeploymentStatusRecord(payload), repository),
      normalized,
    );
  }

  return withGitHubWebhookMetadata(payload, normalized);
}

/**
 * Enrich the integration-watch DELIVERY payload (never the stored record) so
 * the pr-reviewer persona can resolve the PR author without racing the
 * relayfile mount. `buildGitHubWebhookFileData` unwraps the pull_request
 * object, which moves the author to `payload.user.login` / `payload.author`
 * — but the deployed persona reads `payload.pull_request.user.login`
 * (agents review/agent.ts) and otherwise falls back to the mounted
 * `meta.json`, which only wins when the mount sync (5s interval) beats the
 * handler's ~1ms read. Nesting a minimal `pull_request.user.login` stub makes
 * author resolution deterministic for every deployed persona version with no
 * redeploy.
 *
 * The stub is deliberately MINIMAL ({ user: { login } } only): every other
 * nested reader in the dispatcher (`githubPrKeyFromPayload` reading
 * `pull_request.number/base/head`, `isPrContextPayload` reading presence)
 * either falls through `firstString(undefined, record.number)` to the exact
 * same unwrapped-record fallbacks as today, or flips a disjunct that is
 * already true for pull_request events via their /pulls/ event paths — so
 * dedupe keys and PR-context classification are provably unchanged.
 */
export function enrichGitHubWatchPayload(
  data: Record<string, unknown>,
  normalized: GitHubNormalizedWebhook,
): Record<string, unknown> {
  if (normalized.objectType !== "pull_request") {
    return data;
  }
  if (data.pull_request !== undefined) {
    return data;
  }
  const author = typeof data.author === "string" ? data.author.trim() : "";
  if (!author) {
    return data;
  }
  return {
    ...data,
    pull_request: { user: { login: author } },
  };
}

export function buildGitHubWebhookIngestData(
  normalized: GitHubNormalizedWebhook,
): { eventType: string; data: Record<string, unknown> } {
  const data = buildGitHubWebhookFileData(normalized);

  if (isGitHubWebhookDeletionEvent(normalized)) {
    return {
      eventType: GITHUB_RELAYFILE_FILE_DELETED_EVENT,
      data,
    };
  }

  return {
    eventType: GITHUB_RELAYFILE_FILE_UPDATED_EVENT,
    data: {
      ...data,
      content: `${JSON.stringify(data, null, 2)}\n`,
      contentType: "application/json; charset=utf-8",
    },
  };
}

export function getGitHubWebhookRecordWriterTarget(
  normalized: GitHubNormalizedWebhook,
): GitHubWebhookRecordWriterTarget | null {
  if (normalized.objectType === "issue") {
    return {
      syncName: GITHUB_ISSUES_SYNC_NAME,
      model: "Issue",
    };
  }

  if (normalized.objectType === "pull_request") {
    return {
      syncName: GITHUB_PULL_REQUESTS_SYNC_NAME,
      model: "PullRequest",
    };
  }

  return null;
}

async function readJsonFile<T>(client: RelayFileClient, workspaceId: string, path: string): Promise<T> {
  const file = await client.readFile(workspaceId, path);
  return parseJson<T>(file);
}

async function readIndexOrEmpty<T>(
  client: RelayFileClient,
  workspaceId: string,
  path: string,
): Promise<T[]> {
  try {
    return await readJsonFile<T[]>(client, workspaceId, path);
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }
}

function indexRowNumber(row: GitHubRecordIndexRow): number | null {
  if (typeof row.number === "number" && Number.isFinite(row.number)) {
    return row.number;
  }
  const number = Number(row.id);
  return Number.isFinite(number) ? number : null;
}

function pullRequestFromIndexRow(row: GitHubRecordIndexRow): GitHubPullRequest | null {
  const number = indexRowNumber(row);
  if (number === null) return null;
  return {
    number,
    title: row.title,
    state: row.state,
  };
}

function issueFromIndexRow(row: GitHubRecordIndexRow): GitHubIssue | null {
  const number = indexRowNumber(row);
  if (number === null) return null;
  return {
    number,
    title: row.title,
    state: row.state,
  };
}

export async function listRepos(workspaceId: string): Promise<GitHubRepoRef[]> {
  const client = rootClient(workspaceId);
  const rows = await readIndexOrEmpty<GitHubRepoIndexRow>(
    client,
    workspaceId,
    githubReposIndexPath(),
  );
  return rows.flatMap((row) => {
    const [owner, repo] = row.id.split("/", 2);
    return owner && repo ? [{ owner, repo }] : [];
  });
}

export async function listPullRequests(
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<GitHubPullRequest[]> {
  const client = rootClient(workspaceId);
  const rows = await readIndexOrEmpty<GitHubRecordIndexRow>(
    client,
    workspaceId,
    githubRepoPullsIndexPath(owner, repo),
  );
  return rows.flatMap((row) => {
    const pullRequest = pullRequestFromIndexRow(row);
    return pullRequest ? [pullRequest] : [];
  });
}

export async function getPullRequest(
  workspaceId: string,
  owner: string,
  repo: string,
  number: number,
): Promise<GitHubPullRequest | null> {
  const client = rootClient(workspaceId);
  const primaryPath = githubByIdAliasPath(owner, repo, "pulls", number);
  try {
    return await readJsonFile<GitHubPullRequest>(client, workspaceId, primaryPath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    const fallbackPath = legacyPullRequestMetadataPath(owner, repo, number);
    console.warn("[github-relayfile] falling back to legacy pull request metadata path", {
      workspaceId,
      owner,
      repo,
      number,
      primaryPath,
      fallbackPath,
    });
    try {
      return await readJsonFile<GitHubPullRequest>(client, workspaceId, fallbackPath);
    } catch (fallbackError) {
      if (!isNotFoundError(fallbackError)) {
        throw fallbackError;
      }
      return null;
    }
  }
}

export async function listIssues(
  workspaceId: string,
  owner: string,
  repo: string,
): Promise<GitHubIssue[]> {
  const client = rootClient(workspaceId);
  const rows = await readIndexOrEmpty<GitHubRecordIndexRow>(
    client,
    workspaceId,
    githubRepoIssuesIndexPath(owner, repo),
  );
  return rows.flatMap((row) => {
    const issue = issueFromIndexRow(row);
    return issue ? [issue] : [];
  });
}

export async function getReviews(
  workspaceId: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<GitHubReview[]> {
  const client = rootClient(workspaceId);
  // Reviews are written flat by both the sync writer (cloud#526) and forward
  // webhooks (cloud#533). Filtering by `pull_request_url` is the only
  // correlation available without an index.
  const reviewsDir = parentDirFromPath(githubReviewPath(owner, repo, "__review_id__"));
  let tree: Awaited<ReturnType<typeof client.listTree>>;
  try {
    tree = await client.listTree(workspaceId, { path: reviewsDir, depth: 1 });
  } catch {
    return [];
  }
  const reviewPaths = tree.entries
    .filter((entry) => entry.type === "file" && entry.path.endsWith(".json"))
    .map((entry) => entry.path);

  const reviews = await Promise.all(
    reviewPaths.map((path) =>
      readJsonFile<GitHubReview & { pull_request_url?: unknown }>(client, workspaceId, path),
    ),
  );
  const suffix = `/pulls/${prNumber}`;
  return reviews
    .filter((review) => {
      const url = review.pull_request_url;
      return typeof url === "string" && url.endsWith(suffix);
    })
    .sort((left, right) => {
      const leftTs = typeof left.submitted_at === "string" ? left.submitted_at : "";
      const rightTs = typeof right.submitted_at === "string" ? right.submitted_at : "";
      return rightTs.localeCompare(leftTs);
    });
}

export function createGitHubRelayfileClient(workspaceId: string): RelayFileClient {
  return rootClient(workspaceId);
}
