import { RelayFileApiError, type TreeEntry } from "@relayfile/sdk";
import type { CatalogingContext, InsightGenerator } from "@cloud/cataloging-agent-core";

import { BY_ID_SEGMENT, BY_NAME_SEGMENT, BY_STATE_SEGMENT, BY_TITLE_SEGMENT } from "../aliases.js";

interface CatalogingGithubEnv {
  OPENROUTER_API_KEY?: string;
  [key: string]: unknown;
}

interface ActivePullRequest {
  number: number;
  repo: string;
  title: string;
  author: string;
  updatedAt: string;
  draft: boolean;
  requestedReviewers: string[];
}

interface PullSignalSource extends ActivePullRequest {
  createdAt: string | null;
  headSha: string | null;
  mergeable: boolean | null;
}

interface ReviewSignal {
  state: string;
  pullNumber: number | null;
  headSha: string | null;
}

interface CheckSignal {
  conclusion: string;
  checkName: string;
  pullNumber: number | null;
  headSha: string | null;
  reportedAt: string | null;
}

interface RepoSignals {
  pulls: PullSignalSource[];
  reviews: ReviewSignal[];
  checks: CheckSignal[];
}

interface BlockedOnReviewPr {
  number: number;
  repo: string;
  waitingDays: number;
  reviewer: string;
}

interface CiFailingPr {
  number: number;
  repo: string;
  failingDays: number;
  checkName: string;
}

interface StaleDraftPr {
  number: number;
  repo: string;
  ageDays: number;
}

interface MergeConflictPr {
  number: number;
  repo: string;
}

interface GithubSignalBuckets {
  domain: "github";
  blockedOnReview: BlockedOnReviewPr[];
  ciFailing: CiFailingPr[];
  staleDraft: StaleDraftPr[];
  mergeConflict: MergeConflictPr[];
}

type GithubHighlight =
  | { kind: "blocked-on-review"; headline: string; prs: BlockedOnReviewPr[] }
  | { kind: "ci-failing"; headline: string; prs: CiFailingPr[] }
  | { kind: "stale-draft"; headline: string; prs: StaleDraftPr[] }
  | { kind: "merge-conflict"; headline: string; prs: MergeConflictPr[] };

interface GithubInsightMetrics {
  openCount: number;
  draftCount: number;
  p50AgeDays: number;
  p90AgeDays: number;
}

interface GithubActivePrsInsight {
  generatedAt: string;
  summary: string;
  highlights: GithubHighlight[];
  metrics: GithubInsightMetrics;
  all: ActivePullRequest[];
}

type SummaryResult = { summary: string } | { summary: null; reason: string };

const REPO_ROOT = "/github/repos";
const REVIEW_BLOCKED_DAYS = 3;
const CI_FAILING_DAYS = 1;
const STALE_DRAFT_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SIGNAL_FINGERPRINT_PROPERTY = "cataloging.signalFingerprint";
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const SUMMARY_TIMEOUT_MS = 3_000;

export const activePrsInsight: InsightGenerator<CatalogingGithubEnv> = {
  id: "active-prs",
  outputPath: "/insights/github/active-prs.json",
  triggerPaths: [`${REPO_ROOT}/`],
  debounceMs: 10_000,
  intervalSeconds: 1800,
  async generate(ctx) {
    const repoDirs = await listRepoDirs(ctx);
    const repoSignals = await Promise.all(repoDirs.map((repoDir) => readRepoSignals(ctx, repoDir)));
    const pulls = repoSignals
      .flatMap((repo) => repo.pulls)
      .sort((left, right) => left.repo.localeCompare(right.repo) || left.number - right.number);
    const all = pulls.map(stripSignalFields);
    const signals = buildGithubSignals(ctx.now, repoSignals);
    const highlights = buildGithubHighlights(signals);
    const metrics = buildMetrics(ctx.now, pulls);
    const fingerprint = await signalFingerprint(signals, metrics);
    const cachedSummary = await readCachedSummary(ctx, fingerprint);
    const apiKey = readString(ctx.env.OPENROUTER_API_KEY);
    const summaryResult = cachedSummary
      ? { summary: cachedSummary }
      : apiKey
      ? await summarizeInsight({
          domain: "github",
          signals,
          metrics,
          apiKey,
          signal: ctx.signal,
        })
      : { summary: null, reason: "missing openrouter api key" };
    const summary = summaryResult.summary ?? fallbackSummary(signals);
    const content: GithubActivePrsInsight = {
      generatedAt: ctx.now.toISOString(),
      summary,
      highlights,
      metrics,
      all,
    };

    // Mirrors writeInsightWithSummary metadata until the subscriber switches
    // from the backward-compatible writeInsight path.
    return {
      content,
      contentType: "application/json",
      semantics: {
        properties: {
          [SIGNAL_FINGERPRINT_PROPERTY]: fingerprint,
        },
      },
    };
  },
};

async function listRepoDirs(ctx: CatalogingContext<CatalogingGithubEnv>): Promise<string[]> {
  const entries = await listTreeEntries(ctx, REPO_ROOT, 2, "insight:active-prs:repos").catch((error: unknown) => {
    if (error instanceof RelayFileApiError && error.status === 404) {
      return [];
    }
    throw error;
  });
  const repoDirs = new Set<string>();

  for (const entry of entries) {
    const match = /^\/github\/repos\/([^/]+)\/([^/]+)(?:\/|$)/.exec(entry.path);
    if (!match) {
      continue;
    }
    const [, owner, repo] = match;
    // Skip the repo-level by-name alias subtree at `/github/repos/by-name/<owner>__<repo>/...`.
    // This is the only segment-level reservation: real owners/repos may
    // legitimately contain `by-id`/`by-title` in their name, so we
    // narrowly key off the position of `by-name` directly under repos/.
    if (owner === BY_NAME_SEGMENT) {
      continue;
    }
    repoDirs.add(`${REPO_ROOT}/${owner}/${repo}`);
  }

  return [...repoDirs].sort((left, right) => left.localeCompare(right));
}

async function readCachedSummary(
  ctx: CatalogingContext<CatalogingGithubEnv>,
  signalFingerprintValue: string,
): Promise<string | null> {
  try {
    const existing = await ctx.relayfile.readFile(
      ctx.workspaceId,
      activePrsInsight.outputPath,
      `${ctx.domain}:${activePrsInsight.id}:${ctx.workspaceId}`,
      ctx.signal,
    );
    if (existing.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY] !== signalFingerprintValue) {
      return null;
    }
    const parsed = parseJsonObject(existing.content);
    const summary = parsed ? readString(parsed.summary) : null;
    return summary;
  } catch (error) {
    if (error instanceof RelayFileApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

async function readRepoSignals(
  ctx: CatalogingContext<CatalogingGithubEnv>,
  repoDir: string,
): Promise<RepoSignals> {
  const [pullEntries, reviewEntries, checkEntries] = await Promise.all([
    listJsonTreeEntries(ctx, `${repoDir}/pulls`, "insight:active-prs:pulls"),
    listJsonTreeEntries(ctx, `${repoDir}/reviews`, "insight:active-prs:reviews"),
    listJsonTreeEntries(ctx, `${repoDir}/checks`, "insight:active-prs:checks"),
  ]);

  const [pulls, reviews, checks] = await Promise.all([
    readJsonEntries(ctx, pullEntries, normalizePullRequest),
    readJsonEntries(ctx, reviewEntries, normalizeReview),
    readJsonEntries(ctx, checkEntries, normalizeCheck),
  ]);

  return { pulls, reviews, checks };
}

async function listJsonTreeEntries(
  ctx: CatalogingContext<CatalogingGithubEnv>,
  path: string,
  correlationId: string,
): Promise<TreeEntry[]> {
  const entries = await listTreeEntries(ctx, path, 2, correlationId).catch((error: unknown) => {
    if (error instanceof RelayFileApiError && error.status === 404) {
      return [];
    }
    throw error;
  });

  return entries
    .filter(
      (entry) => entry.type === "file" && entry.path.endsWith(".json") && !hasAliasSegment(entry.path),
    )
    .sort((left, right) => left.path.localeCompare(right.path));
}

function hasAliasSegment(path: string): boolean {
  // Only treat the path as an alias when the alias segment appears at
  // the position the layout actually reserves. Without this scoping,
  // a canonical repo whose owner or repo name happens to be
  // `by-id`/`by-title`/`by-name`/`by-state` (e.g.
  // `/github/repos/acme/by-id/...`) would be incorrectly hidden.
  //
  // Reserved layouts:
  //   /github/repos/<BY_NAME_SEGMENT>/<owner>__<repo>/metadata.json
  //   /github/repos/<owner>/<repo>/pulls/<BY_TITLE_SEGMENT>/<slug>.json
  //   /github/repos/<owner>/<repo>/pulls/<BY_ID_SEGMENT>/<n>.json
  //   /github/repos/<owner>/<repo>/pulls/<BY_STATE_SEGMENT>/<state>/<n>.json
  //   /github/repos/<owner>/<repo>/issues/<BY_TITLE_SEGMENT>/<slug>.json
  //   /github/repos/<owner>/<repo>/issues/<BY_ID_SEGMENT>/<n>.json
  //   /github/repos/<owner>/<repo>/issues/<BY_STATE_SEGMENT>/<state>/<n>.json
  // TODO(issue #106): add a targeted alias-subtree listTree 404 regression if this reader ever traverses alias trees directly.
  if (path.startsWith(`${REPO_ROOT}/${BY_NAME_SEGMENT}/`)) {
    return true;
  }
  const pullsOrIssuesAlias = new RegExp(
    `^${escapeRegex(REPO_ROOT)}/[^/]+/[^/]+/(pulls|issues)/(${escapeRegex(BY_TITLE_SEGMENT)}|${escapeRegex(BY_ID_SEGMENT)}|${escapeRegex(BY_STATE_SEGMENT)})/`,
    "u",
  );
  return pullsOrIssuesAlias.test(path);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listTreeEntries(
  ctx: CatalogingContext<CatalogingGithubEnv>,
  path: string,
  depth: number,
  correlationId: string,
): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let cursor: string | null = null;
  do {
    const tree = await ctx.relayfile.listTree(ctx.workspaceId, {
      path,
      depth,
      cursor: cursor ?? undefined,
      correlationId,
      signal: ctx.signal,
    });
    entries.push(...tree.entries);
    cursor = tree.nextCursor;
  } while (cursor);
  return entries;
}

async function readJsonEntries<T>(
  ctx: CatalogingContext<CatalogingGithubEnv>,
  entries: readonly TreeEntry[],
  normalize: (value: Record<string, unknown>) => T | null,
): Promise<T[]> {
  const values: Array<T | null> = await Promise.all(
    entries.map(async (entry) => {
      try {
        const file = await ctx.relayfile.readFile(ctx.workspaceId, entry.path, undefined, ctx.signal);
        const parsed = parseJsonObject(file.content);
        return parsed ? normalize(parsed) : null;
      } catch (error) {
        if (error instanceof RelayFileApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    }),
  );

  return values.filter((value): value is T => value !== null);
}

function parseJsonObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizePullRequest(pull: Record<string, unknown>): PullSignalSource | null {
  const state = readString(pull.state)?.toLowerCase() ?? "";
  if (state !== "open") {
    return null;
  }

  const number = readNumber(pull.number);
  const title = readString(pull.title);
  const updatedAt = readString(pull.updatedAt) ?? readString(pull.updated_at);

  if (number === null || !title || !updatedAt) {
    return null;
  }

  const head = readObject(pull.head);

  return {
    number,
    repo: pullRepoKey(pull),
    title,
    author: readIdentity(pull.author) ?? readIdentity(pull.user) ?? "unknown",
    updatedAt,
    draft: readBoolean(pull.draft) ?? false,
    requestedReviewers: pullRequestedReviewers(pull),
    createdAt: readString(pull.createdAt) ?? readString(pull.created_at),
    headSha: readString(pull.headSha) ?? readString(pull.head_sha) ?? readString(head?.sha),
    mergeable: readBoolean(pull.mergeable),
  };
}

function normalizeReview(review: Record<string, unknown>): ReviewSignal | null {
  const state = readString(review.state);
  if (!state) {
    return null;
  }
  const pull = readObject(review.pullRequest) ?? readObject(review.pull_request) ?? readObject(review.pull);
  const commit = readObject(review.commit);

  return {
    state: state.toLowerCase(),
    pullNumber:
      readNumber(review.pullNumber) ??
      readNumber(review.pull_number) ??
      readNumber(review.pullRequestNumber) ??
      readNumber(review.pull_request_number) ??
      readNumber(pull?.number) ??
      pullNumberFromUrl(readString(review.pull_request_url)),
    headSha:
      readString(review.headSha) ??
      readString(review.head_sha) ??
      readString(review.commitId) ??
      readString(review.commit_id) ??
      readString(commit?.sha),
  };
}

function normalizeCheck(check: Record<string, unknown>): CheckSignal | null {
  const conclusion = readString(check.conclusion);
  if (!conclusion) {
    return null;
  }
  const suite = readObject(check.checkSuite) ?? readObject(check.check_suite);
  const pullRequests = readArray(check.pullRequests) ?? readArray(check.pull_requests) ?? [];
  const pull = pullRequests.map(readObject).find((value): value is Record<string, unknown> => value !== null);

  return {
    conclusion: conclusion.toLowerCase(),
    checkName: readString(check.name) ?? readString(check.checkName) ?? readString(check.check_name) ?? "unknown check",
    pullNumber:
      readNumber(check.pullNumber) ??
      readNumber(check.pull_number) ??
      readNumber(check.pullRequestNumber) ??
      readNumber(check.pull_request_number) ??
      readNumber(pull?.number),
    headSha:
      readString(check.headSha) ??
      readString(check.head_sha) ??
      readString(check.commitSha) ??
      readString(check.commit_sha) ??
      readString(suite?.headSha) ??
      readString(suite?.head_sha),
    reportedAt:
      readString(check.completedAt) ??
      readString(check.completed_at) ??
      readString(check.updatedAt) ??
      readString(check.updated_at) ??
      readString(check.startedAt) ??
      readString(check.started_at),
  };
}

function buildGithubSignals(now: Date, repos: readonly RepoSignals[]): GithubSignalBuckets {
  const blockedOnReview: BlockedOnReviewPr[] = [];
  const ciFailing: CiFailingPr[] = [];
  const staleDraft: StaleDraftPr[] = [];
  const mergeConflict: MergeConflictPr[] = [];

  for (const repo of repos) {
    for (const pull of repo.pulls) {
      const ageDays = daysSince(now, pull.updatedAt);

      if (
        pull.requestedReviewers.length > 0 &&
        ageDays >= REVIEW_BLOCKED_DAYS &&
        !hasCurrentApproval(repo.reviews, pull)
      ) {
        blockedOnReview.push({
          number: pull.number,
          repo: pull.repo,
          waitingDays: ageDays,
          reviewer: pull.requestedReviewers[0] ?? "unknown",
        });
      }

      const failingCheck = repo.checks
        .filter((check) => checkMatchesPull(check, pull) && check.conclusion === "failure")
        .map((check) => ({
          check,
          failingDays: daysSince(now, check.reportedAt ?? pull.updatedAt),
        }))
        .filter((entry) => entry.failingDays >= CI_FAILING_DAYS)
        .sort((left, right) => right.failingDays - left.failingDays || left.check.checkName.localeCompare(right.check.checkName))[0];
      if (failingCheck) {
        ciFailing.push({
          number: pull.number,
          repo: pull.repo,
          failingDays: failingCheck.failingDays,
          checkName: failingCheck.check.checkName,
        });
      }

      if (pull.draft && ageDays >= STALE_DRAFT_DAYS) {
        staleDraft.push({
          number: pull.number,
          repo: pull.repo,
          ageDays,
        });
      }

      if (pull.mergeable === false) {
        mergeConflict.push({
          number: pull.number,
          repo: pull.repo,
        });
      }
    }
  }

  return { domain: "github", blockedOnReview, ciFailing, staleDraft, mergeConflict };
}

function buildGithubHighlights(signals: GithubSignalBuckets): GithubHighlight[] {
  const highlights: GithubHighlight[] = [];
  if (signals.blockedOnReview.length) {
    highlights.push({
      kind: "blocked-on-review",
      headline: `${signals.blockedOnReview.length} PR${plural(signals.blockedOnReview.length)} waiting on review > ${REVIEW_BLOCKED_DAYS} days`,
      prs: signals.blockedOnReview,
    });
  }
  if (signals.ciFailing.length) {
    highlights.push({
      kind: "ci-failing",
      headline: `${signals.ciFailing.length} PR${plural(signals.ciFailing.length)} with failing CI > ${CI_FAILING_DAYS} day`,
      prs: signals.ciFailing,
    });
  }
  if (signals.staleDraft.length) {
    highlights.push({
      kind: "stale-draft",
      headline: `${signals.staleDraft.length} stale draft${plural(signals.staleDraft.length)} (no activity > ${STALE_DRAFT_DAYS} days)`,
      prs: signals.staleDraft,
    });
  }
  if (signals.mergeConflict.length) {
    highlights.push({
      kind: "merge-conflict",
      headline: `${signals.mergeConflict.length} PR${plural(signals.mergeConflict.length)} with merge conflicts`,
      prs: signals.mergeConflict,
    });
  }
  return highlights;
}

function buildMetrics(now: Date, pulls: readonly PullSignalSource[]): GithubInsightMetrics {
  const ages = pulls.map((pull) => daysSince(now, pull.updatedAt)).sort((left, right) => left - right);
  return {
    openCount: pulls.length,
    draftCount: pulls.filter((pull) => pull.draft).length,
    p50AgeDays: percentile(ages, 0.5),
    p90AgeDays: percentile(ages, 0.9),
  };
}

function stripSignalFields(pull: PullSignalSource): ActivePullRequest {
  return {
    number: pull.number,
    repo: pull.repo,
    title: pull.title,
    author: pull.author,
    updatedAt: pull.updatedAt,
    draft: pull.draft,
    requestedReviewers: pull.requestedReviewers,
  };
}

function hasCurrentApproval(reviews: readonly ReviewSignal[], pull: PullSignalSource): boolean {
  const matching = reviews.filter(
    (review) => review.state === "approved" && reviewMatchesPull(review, pull),
  );
  if (!matching.length) {
    return false;
  }
  if (pull.headSha) {
    return matching.some((review) => review.headSha === pull.headSha);
  }
  return true;
}

function reviewMatchesPull(review: ReviewSignal, pull: PullSignalSource): boolean {
  return review.pullNumber === pull.number || (Boolean(review.headSha) && review.headSha === pull.headSha);
}

function checkMatchesPull(check: CheckSignal, pull: PullSignalSource): boolean {
  return check.pullNumber === pull.number || (Boolean(check.headSha) && check.headSha === pull.headSha);
}

function fallbackSummary(signals: GithubSignalBuckets): string {
  const total =
    signals.blockedOnReview.length +
    signals.ciFailing.length +
    signals.staleDraft.length +
    signals.mergeConflict.length;
  return `${total} PR${plural(total)} need attention. See highlights for details.`;
}

async function summarizeInsight(input: {
  domain: "github";
  signals: GithubSignalBuckets;
  metrics: GithubInsightMetrics;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<SummaryResult> {
  if (input.signal?.aborted) {
    return { summary: null, reason: "aborted" };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SUMMARY_TIMEOUT_MS);
  const abortFromParent = () => controller.abort();
  input.signal?.addEventListener("abort", abortFromParent, { once: true });

  try {
    const response = await globalThis.fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a morning-standup briefer. Write concise, specific insight summaries for engineering operators.",
          },
          {
            role: "user",
            content: JSON.stringify({
              domain: input.domain,
              signals: input.signals,
              metrics: input.metrics,
              instruction:
                "Summarize what needs attention this morning in <=3 sentences. Be specific, avoid raw counting, and mention the most important blockers first.",
            }),
          },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      return { summary: null, reason: `openrouter returned ${response.status}` };
    }

    const payload = (await response.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    } | null;
    const summary = payload?.choices?.[0]?.message?.content;
    if (typeof summary !== "string" || !summary.trim()) {
      return { summary: null, reason: "invalid response" };
    }

    return { summary: summary.trim() };
  } catch {
    if (timedOut) {
      return { summary: null, reason: "timed out" };
    }
    if (input.signal?.aborted) {
      return { summary: null, reason: "aborted" };
    }
    return { summary: null, reason: "request failed" };
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", abortFromParent);
  }
}

function pullRepoKey(pull: Record<string, unknown>): string {
  return (
    readRepoName(pull.repo) ??
    readRepoName(pull.repository) ??
    readRepoName(readObject(pull.base)?.repo) ??
    readRepoName(readObject(pull.head)?.repo) ??
    "unknown"
  );
}

function pullRequestedReviewers(pull: Record<string, unknown>): string[] {
  const reviewers = readArray(pull.requestedReviewers) ?? readArray(pull.requested_reviewers) ?? [];
  return reviewers.map(readIdentity).filter((reviewer): reviewer is string => reviewer !== null);
}

function pullNumberFromUrl(value: string | null): number | null {
  if (!value) {
    return null;
  }
  const match = /\/pulls?\/(\d+)(?:\D|$)/.exec(value);
  return match ? readNumber(match[1]) : null;
}

function readRepoName(value: unknown): string | null {
  const direct = readString(value);
  if (direct) {
    return direct;
  }

  const repo = readObject(value);
  if (!repo) {
    return null;
  }

  return (
    readString(repo.full_name) ??
    readString(repo.fullName) ??
    readString(repo.nameWithOwner) ??
    readString(repo.name)
  );
}

function readIdentity(value: unknown): string | null {
  const direct = readString(value);
  if (direct) {
    return direct;
  }

  const identity = readObject(value);
  if (!identity) {
    return null;
  }

  return readString(identity.login) ?? readString(identity.name) ?? readString(identity.id);
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return null;
}

function daysSince(now: Date, value: string): number {
  const date = readDate(value);
  if (!date) {
    return 0;
  }
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / MS_PER_DAY));
}

function readDate(value: string | null): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (!values.length) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentileValue) - 1));
  return values[index] ?? 0;
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

async function signalFingerprint(signals: GithubSignalBuckets, metrics: GithubInsightMetrics): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        signals,
        metrics,
      }),
    ),
  );
  return `sha256:${bytesToBase64Url(new Uint8Array(digest))}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
