import { RelayFileApiError, type FileSemantics, type WriteQueuedResponse } from "@relayfile/sdk";

import type { CatalogingContext } from "./context.js";
import type { InsightHighlight, InsightMetrics, InsightSummary, SignalBuckets } from "./insight-schema.js";

export interface InsightGenerator<TEnv = unknown> {
  id: string;
  outputPath: string;
  triggerPaths: readonly string[];
  intervalSeconds: number;
  debounceMs: number;
  generate(context: CatalogingContext<TEnv>): Promise<InsightGenerationResult> | InsightGenerationResult;
}

export type InsightGenerationResult =
  | string
  | ArrayBuffer
  | Uint8Array
  | Record<string, unknown>
  | {
      content: string | ArrayBuffer | Uint8Array | Record<string, unknown>;
      contentType?: string;
      encoding?: "utf-8" | "base64";
      semantics?: FileSemantics;
      contentIdentity?: InsightWriteContentIdentity;
    };

export interface InsightContentIdentity {
  kind: "insight";
  key: string;
  ttlSeconds?: number;
}

export type InsightWriteContentIdentity = InsightContentIdentity;

export interface WriteInsightResult {
  status: "written" | "skipped";
  path: string;
  insightId: string;
  contentIdentity: string;
  operation?: WriteQueuedResponse;
}

export interface WriteInsightSummaryInput<
  H extends InsightHighlight = InsightHighlight,
  M extends InsightMetrics = InsightMetrics,
> {
  summary: string | null;
  highlights: H[];
  metrics: M;
  semantics?: FileSemantics;
  contentIdentity?: InsightWriteContentIdentity;
}

const CONTENT_IDENTITY_PROPERTY = "cataloging.contentIdentity";
const CONTENT_FINGERPRINT_PROPERTY = "cataloging.contentFingerprint";
const SIGNAL_FINGERPRINT_PROPERTY = "cataloging.signalFingerprint";
const INSIGHT_ID_PROPERTY = "cataloging.insightId";
const GENERATED_AT_PROPERTY = "cataloging.generatedAt";

/**
 * @deprecated Use writeInsightWithSummary for redesigned insights that include
 * summaries, signal buckets, metrics, and signal-fingerprint caching.
 */
export async function writeInsight<TEnv>(
  context: CatalogingContext<TEnv>,
  insight: InsightGenerator<TEnv>,
  generated: InsightGenerationResult,
): Promise<WriteInsightResult> {
  const payload = await normalizeInsightPayload(context, insight, generated);
  return writeNormalizedInsightPayload(context, insight, payload);
}

export async function writeInsightWithSummary<TEnv, H extends InsightHighlight, M extends InsightMetrics, A>(
  context: CatalogingContext<TEnv>,
  insight: InsightGenerator<TEnv>,
  signals: SignalBuckets,
  summary: WriteInsightSummaryInput<H, M>,
  all: readonly A[],
): Promise<WriteInsightResult>;
export async function writeInsightWithSummary<TEnv, A>(
  context: CatalogingContext<TEnv>,
  insight: InsightGenerator<TEnv>,
  signals: SignalBuckets,
  summary: string | null,
  all: readonly A[],
): Promise<WriteInsightResult>;
export async function writeInsightWithSummary<TEnv, H extends InsightHighlight, M extends InsightMetrics, A>(
  context: CatalogingContext<TEnv>,
  insight: InsightGenerator<TEnv>,
  signals: SignalBuckets,
  summary: WriteInsightSummaryInput<H, M> | string | null,
  all: readonly A[],
): Promise<WriteInsightResult> {
  const summaryInput = isSummaryInput(summary)
    ? summary
    : {
        summary,
        highlights: signalHighlights(signals) as H[],
        metrics: inferMetrics(context, signals, all) as M,
      };
  const contentIdentity = summaryInput.contentIdentity ?? defaultInsightContentIdentity(context, insight);
  const contentIdentityKey = readContentIdentityKey(contentIdentity);
  const signalFingerprint = await sha256Identity(
    JSON.stringify({
      signals,
      metrics: summaryInput.metrics,
    }),
  );
  const existing = await readExistingInsight(context, insight, contentIdentityKey);
  const cachedSummary =
    existing?.semantics?.properties?.[SIGNAL_FINGERPRINT_PROPERTY] === signalFingerprint
      ? readExistingSummary(existing.content)
      : null;
  const resolvedSummary = cachedSummary ?? summaryInput.summary;
  const content: InsightSummary<H, M, A> = {
    generatedAt: context.now.toISOString(),
    summary: resolvedSummary,
    highlights: summaryInput.highlights,
    metrics: summaryInput.metrics,
    all: [...all],
  };
  const payload = await normalizeInsightPayload(context, insight, {
    content,
    contentType: "application/json",
    semantics: summaryInput.semantics,
    contentIdentity,
  });

  return writeNormalizedInsightPayload(context, insight, payload, {
    signalFingerprint,
    existing,
  });
}

async function writeNormalizedInsightPayload<TEnv>(
  context: CatalogingContext<TEnv>,
  insight: InsightGenerator<TEnv>,
  payload: NormalizedInsightPayload,
  options: {
    signalFingerprint?: string;
    existing?: ExistingInsightFile | null;
  } = {},
): Promise<WriteInsightResult> {
  let baseRevision = "0";

  const existing = options.existing ?? (await readExistingInsight(context, insight, payload.contentIdentityKey));
  if (existing) {
    baseRevision = existing.revision;
    const existingFingerprint =
      existing.semantics?.properties?.[CONTENT_FINGERPRINT_PROPERTY] ??
      existing.semantics?.properties?.[CONTENT_IDENTITY_PROPERTY];
    if (existingFingerprint === payload.contentFingerprint) {
      return {
        status: "skipped",
        path: insight.outputPath,
        insightId: insight.id,
        contentIdentity: payload.contentIdentityKey,
      };
    }
  }

  const semantics = mergeCatalogingSemantics(payload.semantics, {
    insightId: insight.id,
    contentIdentity: payload.contentIdentityKey,
    contentFingerprint: payload.contentFingerprint,
    signalFingerprint: options.signalFingerprint,
    generatedAt: context.now.toISOString(),
  });

  const writeInput = {
    workspaceId: context.workspaceId,
    path: insight.outputPath,
    baseRevision,
    content: payload.content,
    contentType: payload.contentType,
    encoding: payload.encoding,
    semantics,
    correlationId: payload.contentIdentityKey,
    contentIdentity: payload.contentIdentity,
    signal: context.signal,
  };

  const operation = await context.relayfile.writeFile(writeInput);

  return {
    status: "written",
    path: insight.outputPath,
    insightId: insight.id,
    contentIdentity: payload.contentIdentityKey,
    operation,
  };
}

type ExistingInsightFile = Awaited<ReturnType<CatalogingContext["relayfile"]["readFile"]>>;

interface NormalizedInsightPayload {
  content: string;
  contentType: string;
  encoding: "utf-8" | "base64";
  semantics?: FileSemantics;
  contentIdentity: InsightWriteContentIdentity;
  contentIdentityKey: string;
  contentFingerprint: string;
}

async function normalizeInsightPayload<TEnv>(
  context: CatalogingContext<TEnv>,
  insight: InsightGenerator<TEnv>,
  generated: InsightGenerationResult,
): Promise<NormalizedInsightPayload> {
  const explicit = isExplicitInsightOutput(generated) ? generated : { content: generated };
  const normalizedContent = normalizeContent(explicit.content);
  const contentType = explicit.contentType ?? defaultContentType(explicit.content);
  const encoding = explicit.encoding ?? normalizedContent.encoding;
  const contentIdentity = explicit.contentIdentity ?? defaultInsightContentIdentity(context, insight);
  const contentIdentityKey = readContentIdentityKey(contentIdentity);
  const contentFingerprint = await sha256Identity(
    JSON.stringify({
      insightId: insight.id,
      outputPath: insight.outputPath,
      contentType,
      encoding,
      content: normalizedContent.content,
    }),
  );

  return {
    content: normalizedContent.content,
    contentType,
    encoding,
    semantics: explicit.semantics,
    contentIdentity,
    contentIdentityKey,
    contentFingerprint,
  };
}

function isExplicitInsightOutput(value: InsightGenerationResult): value is Extract<InsightGenerationResult, { content: unknown }> {
  return typeof value === "object" && value !== null && "content" in value;
}

function normalizeContent(value: string | ArrayBuffer | Uint8Array | Record<string, unknown>): {
  content: string;
  encoding: "utf-8" | "base64";
} {
  if (typeof value === "string") {
    return { content: value, encoding: "utf-8" };
  }
  if (value instanceof Uint8Array) {
    return { content: bytesToBase64(value), encoding: "base64" };
  }
  if (value instanceof ArrayBuffer) {
    return { content: bytesToBase64(new Uint8Array(value)), encoding: "base64" };
  }
  return { content: `${JSON.stringify(value, null, 2)}\n`, encoding: "utf-8" };
}

function defaultContentType(value: string | ArrayBuffer | Uint8Array | Record<string, unknown>): string {
  if (typeof value === "string") {
    return "text/markdown; charset=utf-8";
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return "application/octet-stream";
  }
  return "application/json";
}

function mergeCatalogingSemantics(
  semantics: FileSemantics | undefined,
  properties: {
    insightId: string;
    contentIdentity: string;
    contentFingerprint: string;
    signalFingerprint?: string;
    generatedAt: string;
  },
): FileSemantics {
  return {
    ...semantics,
    properties: {
      ...(semantics?.properties ?? {}),
      [INSIGHT_ID_PROPERTY]: properties.insightId,
      [CONTENT_IDENTITY_PROPERTY]: properties.contentIdentity,
      [CONTENT_FINGERPRINT_PROPERTY]: properties.contentFingerprint,
      ...(properties.signalFingerprint ? { [SIGNAL_FINGERPRINT_PROPERTY]: properties.signalFingerprint } : {}),
      [GENERATED_AT_PROPERTY]: properties.generatedAt,
    },
  };
}

async function readExistingInsight<TEnv>(
  context: CatalogingContext<TEnv>,
  insight: InsightGenerator<TEnv>,
  contentIdentityKey: string,
): Promise<ExistingInsightFile | null> {
  try {
    return await context.relayfile.readFile(context.workspaceId, insight.outputPath, contentIdentityKey, context.signal);
  } catch (error) {
    if (error instanceof RelayFileApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

function readExistingSummary(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const summary = (parsed as { summary?: unknown }).summary;
    return typeof summary === "string" ? summary : null;
  } catch {
    return null;
  }
}

function isSummaryInput(value: unknown): value is WriteInsightSummaryInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<WriteInsightSummaryInput>;
  return Array.isArray(candidate.highlights) && typeof candidate.metrics === "object" && candidate.metrics !== null;
}

function signalHighlights(signals: SignalBuckets): InsightHighlight[] {
  if (signals.domain === "github") {
    const highlights: InsightHighlight[] = [];
    if (signals.blockedOnReview.length) {
      highlights.push({
        kind: "blocked-on-review",
        headline: `${signals.blockedOnReview.length} PRs waiting on review`,
        prs: signals.blockedOnReview,
      });
    }
    if (signals.ciFailing.length) {
      highlights.push({
        kind: "ci-failing",
        headline: `${signals.ciFailing.length} PRs with failing CI`,
        prs: signals.ciFailing,
      });
    }
    if (signals.staleDraft.length) {
      highlights.push({
        kind: "stale-draft",
        headline: `${signals.staleDraft.length} stale draft PRs`,
        prs: signals.staleDraft,
      });
    }
    if (signals.mergeConflict.length) {
      highlights.push({
        kind: "merge-conflict",
        headline: `${signals.mergeConflict.length} PRs with merge conflicts`,
        prs: signals.mergeConflict,
      });
    }
    return highlights;
  }

  const highlights: InsightHighlight[] = [];
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
      headline: `${signals.staleNoActivity.length} stale issues with no recent activity`,
      issues: signals.staleNoActivity,
    });
  }
  if (signals.customerMentioned.length) {
    highlights.push({
      kind: "customer-mentioned",
      headline: `${signals.customerMentioned.length} issues mentioning customers`,
      issues: signals.customerMentioned,
    });
  }
  return highlights;
}

function inferMetrics<TEnv, A>(
  context: CatalogingContext<TEnv>,
  signals: SignalBuckets,
  all: readonly A[],
): InsightMetrics {
  if (signals.domain === "github") {
    const pullRequests = all.map(readObject).filter((item): item is Record<string, unknown> => item !== null);
    return {
      openCount: all.length,
      draftCount: pullRequests.filter((pull) => pull.draft === true).length,
      p50AgeDays: percentileAgeDays(context.now, pullRequests, 0.5),
      p90AgeDays: percentileAgeDays(context.now, pullRequests, 0.9),
    };
  }

  const issues = all.map(readObject).filter((item): item is Record<string, unknown> => item !== null);
  return {
    openCount: all.length,
    p1Count: issues.filter((issue) => readNumber(issue.priority) === 1).length,
    unassignedCount: issues.filter((issue) => !readAssignee(issue)).length,
    p50AgeDays: percentileAgeDays(context.now, issues, 0.5),
  };
}

function percentileAgeDays(now: Date, items: readonly Record<string, unknown>[], percentile: number): number {
  const ages = items
    .map((item) => readDate(item.updatedAt) ?? readDate(item.updated_at) ?? readDate(item.createdAt) ?? readDate(item.created_at))
    .filter((date): date is Date => date !== null)
    .map((date) => Math.max(0, Math.floor((now.getTime() - date.getTime()) / (24 * 60 * 60 * 1000))))
    .sort((left, right) => left - right);
  if (!ages.length) {
    return 0;
  }
  const index = Math.min(ages.length - 1, Math.max(0, Math.ceil(ages.length * percentile) - 1));
  return ages[index] ?? 0;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function readAssignee(issue: Record<string, unknown>): unknown {
  const assignee = readObject(issue.assignee);
  return assignee?.id ?? assignee?.name ?? issue.assigneeId;
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
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function defaultInsightContentIdentity<TEnv>(
  context: CatalogingContext<TEnv>,
  insight: InsightGenerator<TEnv>,
): InsightContentIdentity {
  return {
    kind: "insight",
    key: `${context.domain}:${insight.id}:${context.workspaceId}`,
  };
}

function readContentIdentityKey(contentIdentity: InsightWriteContentIdentity): string {
  return contentIdentity.key;
}

async function sha256Identity(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
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
