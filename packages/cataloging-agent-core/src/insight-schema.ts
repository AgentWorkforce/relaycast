// Output schema for the redesigned cataloger insights.
//
// The shapes here are the source of truth for what producers
// (cataloging-agent-{github,linear}) write to /insights/**.json and what
// downstream consumers read. See workflows/cataloger-insights-redesign-SPEC.md.

// ---------------------------------------------------------------------------
// Flat per-domain item shapes (the existing "all" entries)
// ---------------------------------------------------------------------------

export interface ActivePullRequest {
  number: number;
  repo: string;
  title: string;
  author: string;
  updatedAt: string;
  draft: boolean;
  requestedReviewers: string[];
}

// Linear's existing extractor passes raw issue JSON through unchanged, so the
// flat list keeps an open shape with the well-known keys typed.
export interface RawLinearIssue {
  id?: string;
  identifier?: string;
  title?: string;
  priority?: number | string | null;
  assignee?: { id?: string; name?: string } | null;
  assigneeId?: string | null;
  state?: { type?: string; name?: string } | null;
  updatedAt?: string;
  createdAt?: string;
  completedAt?: string | null;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Highlight item shapes
// ---------------------------------------------------------------------------

export interface BlockedOnReviewPr {
  number: number;
  repo: string;
  waitingDays: number;
  reviewer: string;
}

export interface CiFailingPr {
  number: number;
  repo: string;
  failingDays: number;
  checkName: string;
}

export interface StaleDraftPr {
  number: number;
  repo: string;
  ageDays: number;
}

export interface MergeConflictPr {
  number: number;
  repo: string;
}

export interface UnassignedPriorityIssue {
  identifier: string;
  title: string;
  priority: number;
  unassignedDays: number;
}

export interface StaleNoActivityIssue {
  identifier: string;
  title: string;
  ageDays: number;
}

export interface CustomerMentionedIssue {
  identifier: string;
  title: string;
  customer: string;
}

// ---------------------------------------------------------------------------
// InsightHighlight — discriminated by `kind`
// ---------------------------------------------------------------------------

export type GithubHighlightKind =
  | "blocked-on-review"
  | "ci-failing"
  | "stale-draft"
  | "merge-conflict";

export type LinearHighlightKind =
  | "unassigned-priority"
  | "stale-no-activity"
  | "customer-mentioned";

export type GithubHighlight =
  | { kind: "blocked-on-review"; headline: string; prs: BlockedOnReviewPr[] }
  | { kind: "ci-failing"; headline: string; prs: CiFailingPr[] }
  | { kind: "stale-draft"; headline: string; prs: StaleDraftPr[] }
  | { kind: "merge-conflict"; headline: string; prs: MergeConflictPr[] };

export type LinearHighlight =
  | { kind: "unassigned-priority"; headline: string; issues: UnassignedPriorityIssue[] }
  | { kind: "stale-no-activity"; headline: string; issues: StaleNoActivityIssue[] }
  | { kind: "customer-mentioned"; headline: string; issues: CustomerMentionedIssue[] };

export type InsightHighlight = GithubHighlight | LinearHighlight;

// ---------------------------------------------------------------------------
// SignalBuckets — deterministic pre-LLM intermediate, fed to summarizeInsight
// ---------------------------------------------------------------------------

export interface GithubSignalBuckets {
  domain: "github";
  blockedOnReview: BlockedOnReviewPr[];
  ciFailing: CiFailingPr[];
  staleDraft: StaleDraftPr[];
  mergeConflict: MergeConflictPr[];
}

export interface LinearSignalBuckets {
  domain: "linear";
  unassignedPriority: UnassignedPriorityIssue[];
  staleNoActivity: StaleNoActivityIssue[];
  customerMentioned: CustomerMentionedIssue[];
}

export type SignalBuckets = GithubSignalBuckets | LinearSignalBuckets;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

export interface GithubInsightMetrics {
  openCount: number;
  draftCount: number;
  p50AgeDays: number;
  p90AgeDays: number;
}

export interface LinearInsightMetrics {
  openCount: number;
  p1Count: number;
  unassignedCount: number;
  p50AgeDays: number;
}

export type InsightMetrics = GithubInsightMetrics | LinearInsightMetrics;

// ---------------------------------------------------------------------------
// InsightSummary — top-level shape written to /insights/**.json
// ---------------------------------------------------------------------------

// `summary` is `string | null` — null means the LLM step failed and the writer
// fell back; structured fields (`highlights`, `metrics`, `all`) remain accurate.
export interface InsightSummary<
  H extends InsightHighlight = InsightHighlight,
  M extends InsightMetrics = InsightMetrics,
  A = unknown,
> {
  generatedAt: string;
  summary: string | null;
  highlights: H[];
  metrics: M;
  all: A[];
}

export type GithubActivePrsInsight = InsightSummary<
  GithubHighlight,
  GithubInsightMetrics,
  ActivePullRequest
>;

export type LinearOpenIssuesInsight = InsightSummary<
  LinearHighlight,
  LinearInsightMetrics,
  RawLinearIssue
>;
