import { RelayFileApiError, type TreeEntry } from "@relayfile/sdk";
import type { CatalogingContext, InsightGenerator } from "@cloud/cataloging-agent-core";

import { BY_ID_SEGMENT, BY_STATE_SEGMENT, BY_TITLE_SEGMENT } from "../aliases.js";

type CatalogingLinearEnv = {
  OPENROUTER_API_KEY?: string;
  [key: string]: unknown;
};

interface LinearSignals {
  domain: "linear";
  unassignedPriority: UnassignedPriorityIssue[];
  staleNoActivity: StaleNoActivityIssue[];
  customerMentioned: CustomerMentionedIssue[];
}

interface LinearMetrics {
  openCount: number;
  p1Count: number;
  unassignedCount: number;
  p50AgeDays: number;
}

interface UnassignedPriorityIssue {
  identifier: string;
  title: string;
  priority: number;
  unassignedDays: number;
}

interface StaleNoActivityIssue {
  identifier: string;
  title: string;
  ageDays: number;
}

interface CustomerMentionedIssue {
  identifier: string;
  title: string;
  customer: string;
}

type LinearHighlight =
  | { kind: "unassigned-priority"; headline: string; issues: UnassignedPriorityIssue[] }
  | { kind: "stale-no-activity"; headline: string; issues: StaleNoActivityIssue[] }
  | { kind: "customer-mentioned"; headline: string; issues: CustomerMentionedIssue[] };

interface LinearCommentSignal {
  issueId: string;
  updatedAt: Date | null;
  body: string | null;
}

type SummaryResult = { summary: string } | { summary: null; reason: string };

interface OpenRouterChatResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
}

const CUSTOMER_KEYWORDS = ["enterprise", "production outage", "blocker"];
const DAY_MS = 24 * 60 * 60 * 1000;
const SIGNAL_FINGERPRINT_PROPERTY = "cataloging.signalFingerprint";
const OPENROUTER_CHAT_COMPLETIONS_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "openai/gpt-4o-mini";
const SUMMARY_TIMEOUT_MS = 3_000;

export const openIssuesInsight: InsightGenerator<CatalogingLinearEnv> = {
  id: "open-issues",
  outputPath: "/insights/linear/open-issues.json",
  triggerPaths: ["/linear/issues/", "/linear/comments/"],
  debounceMs: 15_000,
  intervalSeconds: 1800,
  async generate(ctx) {
    const [issueEntries, commentEntries] = await Promise.all([
      listIssueTreeEntries(ctx).catch(returnEmptyOnMissing),
      listCommentTreeEntries(ctx).catch(returnEmptyOnMissing),
    ]);

    const issuePaths = issueEntries
      .filter((entry) => entry.type === "file" && entry.path.endsWith(".json"))
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right));
    const commentPaths = commentEntries
      .filter((entry) => entry.type === "file" && entry.path.endsWith(".json"))
      .map((entry) => entry.path)
      .sort((left, right) => left.localeCompare(right));

    const issues = (
      await Promise.all(
        issuePaths.map(async (path) => {
          try {
            const file = await ctx.relayfile.readFile(ctx.workspaceId, path, undefined, ctx.signal);
            const issue = parseJsonObject(file.content);
            if (!issue) {
              return null;
            }

            if (!isIssueOpen(issue)) {
              return null;
            }

            return issue;
          } catch (error) {
            if (error instanceof RelayFileApiError && error.status === 404) {
              return null;
            }
            throw error;
          }
        }),
      )
    ).filter((issue): issue is Record<string, unknown> => issue !== null);

    const commentsByIssueId = await readCommentsByIssueId(ctx, commentPaths);
    const signals = buildLinearSignals(ctx.now, issues, commentsByIssueId);
    const metrics = buildLinearMetrics(ctx.now, issues);
    const fingerprint = await signalFingerprint(signals, metrics);
    const cachedSummary = await readCachedSummary(ctx, fingerprint);
    const apiKey = readEnvString(ctx.env, "OPENROUTER_API_KEY");
    const summaryResult = cachedSummary
      ? { summary: cachedSummary }
      : apiKey
      ? await summarizeInsight({
          domain: "linear",
          signals,
          metrics,
          apiKey,
          signal: ctx.signal,
        })
      : { summary: null, reason: "missing openrouter api key" };

    const content = {
      generatedAt: ctx.now.toISOString(),
      summary: summaryResult.summary ?? fallbackSummary(metrics.openCount),
      highlights: buildHighlights(signals),
      metrics,
      all: issues,
    };

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

async function listIssueTreeEntries(ctx: CatalogingContext): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let cursor: string | null = null;
  do {
    const tree = await ctx.relayfile.listTree(ctx.workspaceId, {
      path: "/linear/issues",
      depth: 2,
      cursor: cursor ?? undefined,
      correlationId: "insight:open-issues",
      signal: ctx.signal,
    });
    entries.push(...tree.entries.filter((entry) => !hasAliasSegment(entry.path)));
    cursor = tree.nextCursor;
  } while (cursor);
  return entries;
}

async function listCommentTreeEntries(ctx: CatalogingContext): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  let cursor: string | null = null;
  do {
    const tree = await ctx.relayfile.listTree(ctx.workspaceId, {
      path: "/linear/comments",
      depth: 2,
      cursor: cursor ?? undefined,
      correlationId: "insight:open-issues:comments",
      signal: ctx.signal,
    });
    entries.push(...tree.entries.filter((entry) => !hasAliasSegment(entry.path)));
    cursor = tree.nextCursor;
  } while (cursor);
  return entries;
}

function hasAliasSegment(path: string): boolean {
  // Linear issue trees only emit by-title, by-id, and by-state aliases today; projects/teams own by-name.
  const segments = path.split("/");
  return (
    segments.includes(BY_TITLE_SEGMENT) ||
    segments.includes(BY_ID_SEGMENT) ||
    segments.includes(BY_STATE_SEGMENT)
  );
}

function returnEmptyOnMissing(error: unknown): TreeEntry[] {
  if (error instanceof RelayFileApiError && error.status === 404) {
    return [];
  }
  throw error;
}

async function readCachedSummary(
  ctx: CatalogingContext<CatalogingLinearEnv>,
  signalFingerprintValue: string,
): Promise<string | null> {
  try {
    const existing = await ctx.relayfile.readFile(
      ctx.workspaceId,
      openIssuesInsight.outputPath,
      `${ctx.domain}:${openIssuesInsight.id}:${ctx.workspaceId}`,
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

async function readCommentsByIssueId(
  ctx: CatalogingContext,
  commentPaths: readonly string[],
): Promise<Map<string, LinearCommentSignal>> {
  const comments = (
    await Promise.all(
      commentPaths.map(async (path) => {
        try {
          const file = await ctx.relayfile.readFile(ctx.workspaceId, path, undefined, ctx.signal);
          const comment = parseJsonObject(file.content);
          if (!comment) {
            return null;
          }
          const issueId = commentIssueId(comment);
          if (!issueId) {
            return null;
          }
          return {
            issueId,
            updatedAt: commentUpdatedAt(comment),
            body: commentBody(comment),
          };
        } catch (error) {
          if (error instanceof RelayFileApiError && error.status === 404) {
            return null;
          }
          throw error;
        }
      }),
    )
  ).filter((comment): comment is LinearCommentSignal => comment !== null);

  const byIssueId = new Map<string, LinearCommentSignal>();
  for (const comment of comments) {
    const existing = byIssueId.get(comment.issueId);
    if (!existing || compareNullableDates(comment.updatedAt, existing.updatedAt) > 0) {
      byIssueId.set(comment.issueId, comment);
    }
  }
  return byIssueId;
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

function isIssueOpen(issue: Record<string, unknown>): boolean {
  if (readString(issue.completedAt)) {
    return false;
  }

  const state = readObject(issue.state);
  const rawType = readString(state?.type);
  const stateType = rawType ? rawType.toLowerCase() : "";
  if (stateType && new Set(["done", "canceled", "cancelled", "completed", "closed"]).has(stateType)) {
    return false;
  }

  const rawName = readString(state?.name);
  const stateName = rawName ? rawName.toLowerCase() : "";
  if (stateName && new Set(["done", "canceled", "cancelled", "completed", "closed"]).has(stateName)) {
    return false;
  }

  return true;
}

function buildLinearSignals(
  now: Date,
  issues: readonly Record<string, unknown>[],
  commentsByIssueId: ReadonlyMap<string, LinearCommentSignal>,
): LinearSignals {
  const unassignedPriority: UnassignedPriorityIssue[] = [];
  const staleNoActivity: StaleNoActivityIssue[] = [];
  const customerMentioned: CustomerMentionedIssue[] = [];

  for (const issue of issues) {
    const identifier = issueIdentifier(issue);
    const title = issueTitle(issue);
    const priority = issuePriorityNumber(issue);
    const issueId = issueStableId(issue);
    const latestComment = issueId ? commentsByIssueId.get(issueId) ?? null : null;

    if (!issueAssignee(issue) && priority !== null && priority <= 2) {
      unassignedPriority.push({
        identifier,
        title,
        priority,
        unassignedDays: issueAgeDays(now, issue),
      });
    }

    const lastActivityAt = latestDate(issueLastActivityAt(issue), latestComment?.updatedAt ?? null);
    const staleDays = lastActivityAt ? ageDays(now, lastActivityAt) : null;
    if (staleDays !== null && staleDays >= 14) {
      staleNoActivity.push({
        identifier,
        title,
        ageDays: staleDays,
      });
    }

    const customerKeyword = findCustomerKeyword([issueBody(issue), latestComment?.body ?? null]);
    if (customerKeyword) {
      customerMentioned.push({
        identifier,
        title,
        customer: customerKeyword,
      });
    }
  }

  return {
    domain: "linear",
    unassignedPriority: unassignedPriority.sort(sortByPriorityThenIdentifier),
    staleNoActivity: staleNoActivity.sort((left, right) => right.ageDays - left.ageDays || left.identifier.localeCompare(right.identifier)),
    customerMentioned: customerMentioned.sort((left, right) => left.identifier.localeCompare(right.identifier)),
  };
}

function buildLinearMetrics(now: Date, issues: readonly Record<string, unknown>[]): LinearMetrics {
  return {
    openCount: issues.length,
    p1Count: issues.filter((issue) => issuePriorityNumber(issue) === 1).length,
    unassignedCount: issues.filter((issue) => !issueAssignee(issue)).length,
    p50AgeDays: percentile(
      issues.map((issue) => issueAgeDays(now, issue)).sort((left, right) => left - right),
      0.5,
    ),
  };
}

function buildHighlights(signals: LinearSignals): LinearHighlight[] {
  const highlights: LinearHighlight[] = [];
  if (signals.unassignedPriority.length) {
    highlights.push({
      kind: "unassigned-priority",
      headline: `${signals.unassignedPriority.length} high-priority unassigned issues`,
      issues: signals.unassignedPriority,
    });
  }
  if (signals.staleNoActivity.length) {
    highlights.push({
      kind: "stale-no-activity",
      headline: `${signals.staleNoActivity.length} issues with no activity for 14+ days`,
      issues: signals.staleNoActivity,
    });
  }
  if (signals.customerMentioned.length) {
    highlights.push({
      kind: "customer-mentioned",
      headline: `${signals.customerMentioned.length} issues mention customer-impact keywords`,
      issues: signals.customerMentioned,
    });
  }
  return highlights;
}

function issueLastActivityAt(issue: Record<string, unknown>): Date | null {
  const updated = readDate(issue.updatedAt);
  if (updated) {
    return updated;
  }
  return readDate(issue.createdAt);
}

function issueAgeDays(now: Date, issue: Record<string, unknown>): number {
  const ageStart = readDate(issue.createdAt) ?? readDate(issue.updatedAt) ?? now;
  return ageDays(now, ageStart);
}

function issueStableId(issue: Record<string, unknown>): string | null {
  return readString(issue.id) ?? readString(issue.identifier);
}

function issueIdentifier(issue: Record<string, unknown>): string {
  return readString(issue.identifier) ?? readString(issue.id) ?? "unknown";
}

function issueTitle(issue: Record<string, unknown>): string {
  return readString(issue.title) ?? "(untitled)";
}

function issueAssignee(issue: Record<string, unknown>): string | null {
  const assignee = readObject(issue.assignee);
  return readString(assignee?.name) ?? readString(assignee?.id) ?? readString(issue.assigneeId);
}

function issuePriorityNumber(issue: Record<string, unknown>): number | null {
  return readNumber(issue.priority);
}

function issueBody(issue: Record<string, unknown>): string | null {
  return (
    readString(issue.description) ??
    readString(issue.body) ??
    readString(issue.text) ??
    readString(issue.markdownDescription)
  );
}

function commentIssueId(comment: Record<string, unknown>): string | null {
  const issue = readObject(comment.issue);
  return (
    readString(comment.issueId) ??
    readString(comment.issue_id) ??
    readString(comment.issueIdentifier) ??
    readString(issue?.id) ??
    readString(issue?.identifier)
  );
}

function commentUpdatedAt(comment: Record<string, unknown>): Date | null {
  return readDate(comment.updatedAt) ?? readDate(comment.createdAt);
}

function commentBody(comment: Record<string, unknown>): string | null {
  return readString(comment.body) ?? readString(comment.text) ?? readString(comment.content);
}

function latestDate(left: Date | null, right: Date | null): Date | null {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return left.getTime() >= right.getTime() ? left : right;
}

function compareNullableDates(left: Date | null, right: Date | null): number {
  if (!left && !right) {
    return 0;
  }
  if (!left) {
    return -1;
  }
  if (!right) {
    return 1;
  }
  return left.getTime() - right.getTime();
}

function ageDays(now: Date, date: Date): number {
  return Math.max(0, Math.floor((now.getTime() - date.getTime()) / DAY_MS));
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (!values.length) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * percentileValue) - 1));
  return values[index] ?? 0;
}

function findCustomerKeyword(values: readonly (string | null)[]): string | null {
  for (const value of values) {
    const normalized = value?.toLowerCase();
    if (!normalized) {
      continue;
    }
    const keyword = CUSTOMER_KEYWORDS.find((candidate) => normalized.includes(candidate));
    if (keyword) {
      return keyword;
    }
  }
  return null;
}

function fallbackSummary(openCount: number): string {
  if (openCount === 0) {
    return "No open Linear issues need attention.";
  }
  return `${openCount} Linear issues need attention. See highlights for details.`;
}

function sortByPriorityThenIdentifier(left: UnassignedPriorityIssue, right: UnassignedPriorityIssue): number {
  return left.priority - right.priority || right.unassignedDays - left.unassignedDays || left.identifier.localeCompare(right.identifier);
}

async function summarizeInsight(input: {
  domain: "linear";
  signals: LinearSignals;
  metrics: LinearMetrics;
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

    const payload = (await response.json().catch(() => null)) as OpenRouterChatResponse | null;
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

function readEnvString(env: unknown, key: string): string | null {
  const value = readObject(env)?.[key];
  return readString(value);
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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

function readDate(value: unknown): Date | null {
  const raw = readString(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

async function signalFingerprint(signals: LinearSignals, metrics: LinearMetrics): Promise<string> {
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
