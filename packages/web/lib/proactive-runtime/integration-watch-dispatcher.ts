import { sql } from "drizzle-orm";
import {
  agentMatchesEvent,
  deriveIntegrationWatchDeliveryId,
  parseWatchRules,
  pathsMatchAgent,
  type WatchRule,
  type IntegrationWatchAgentRow,
  watchRuleConditionsMatch,
} from "@cloud/core/proactive-runtime/match.js";
import {
  conversationalConfig,
  isConflictAutofixPersona,
  isConversationalPersona,
  isPullRequestReviewerPersona,
} from "@cloud/core/proactive-runtime/capabilities.js";
import { deploymentPersonaSpec } from "@cloud/core/proactive-runtime/agent-spec.js";
import {
  CONFLICT_AUTOFIX_BOT_LOGIN,
  matchesConflictResolveDirective,
} from "@/lib/proactive-runtime/pull-request-conflict-autofix-dispatch";
import { isConflictResolvePersona } from "@/lib/proactive-runtime/conflict-resolve-capability";
import {
  relayfileProviderEventPaths,
  resolveRelayfileProviderContract,
} from "@cloud/core/relayfile/provider-contracts.js";
import {
  parseJsonArrayMaybeString,
  parsePostgresTextArray,
} from "@cloud/core/db/postgres-array.js";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  drainIntegrationWatchDeliveries,
  enqueueIntegrationWatchDelivery,
} from "@/lib/proactive-runtime/integration-watch-deliveries";
import { enqueueIntegrationWatchDeliveryDrain } from "@/lib/proactive-runtime/integration-watch-delivery-queue";
import { PR_REVIEWER_SELF_TRIGGER_BOT_LOGINS } from "@/lib/proactive-runtime/pr-reviewer-bot-identity";
import {
  listWorkspaceIntegrationsByProviderAlias,
  type WorkspaceIntegrationRecord,
} from "@/lib/integrations/workspace-integrations";
import { tryResourceValue } from "@/lib/env";
import { getCloudflareContext } from "@/lib/cloudflare-context";
import { claimWebhookDelivery, releaseWebhookDelivery } from "@/lib/ricky/webhook-dedup";
import { resolveAppWorkspaceIdForRelayRuntime } from "@/lib/workspaces/workspace-integration-identity-core";
import { isRelayWorkspaceId } from "@/lib/workspaces/relay-workspace-binding";
import {
  isTeamLaunchMultiEnabled,
  isTeamLaunchN1Enabled,
  teamSolveMaxMembers,
} from "@/lib/proactive-runtime/team-launch-n1";
import { slackConversationEgress } from "@/lib/integrations/slack-conversation/egress";
import { executeRelayfileProviderWriteback } from "@/lib/integrations/relayfile-writeback-bridge";
import {
  maybeDispatchSlackConversationalAppMention,
} from "@/lib/integrations/slack-conversation/dispatch";
import {
  lookupSlackConversationThreadOwner,
  recordSlackConversationThreadOwner,
} from "@/lib/integrations/slack-conversation/threads";
import {
  finalizeSlackConversationDispatchResult,
  logIntegrationWatchMatchedAgents,
} from "@/lib/proactive-runtime/slack-conversation-dispatch-finalize";
import {
  isFactoryBrainCandidateSpec,
  isFactoryBrainEnabled,
  isFactoryIssuePayload,
  markFactoryBrainPayload,
} from "@/lib/proactive-runtime/factory-cloud-orchestrator";

export type IntegrationWatchDispatchInput = {
  workspaceId: string;
  provider: string;
  eventType: string;
  connectionId?: string | null;
  deliveryId?: string | null;
  paths?: readonly string[];
  payload?: unknown;
  occurredAt?: string;
};

export type IntegrationWatchDispatchResult = {
  matched: number;
  delivered: number;
  failed: number;
};

type RawRows<T> = { rows?: T[] };
type DedupeOutcome = "claimed" | "skipped" | "released" | "unavailable";
type DedupeBroker = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};
type DispatchFailureReason = "workspace_mapping_unresolved";
const cloudflareContextSymbol = Symbol.for("__cloudflare-context__");
const DEFAULT_ISSUE_DISPATCH_COOLDOWN_SECONDS = 180;
const ISSUE_DISPATCH_COOLDOWN_ENV = "CLOUD_AGENT_ISSUE_DISPATCH_COOLDOWN_SECONDS";
const ISSUE_DISPATCH_COOLDOWN_RESOURCE = "CloudAgentIssueDispatchCooldownSeconds";
const TEAM_ISSUE_ENABLED_ENV = "CLOUD_TEAM_ISSUE_ENABLED";
const TEAM_ISSUE_TEST_ENABLED_ENV = "TEAM_ISSUE_TEST_MODE";
const INLINE_DRAIN_OPTIONS = {
  // Inline webhook drains run inside the originating request's `waitUntil`,
  // which workerd caps at ~30s after the response is sent. There is no budget
  // to poll a cold sandbox to STARTED here: the previous 20s default provision
  // poll, stacked on claim + prepare + token-mint pre-work, blew past the cap,
  // workerd severed the drain's in-flight I/O ("Network connection lost"), and
  // — because the kill landed before DeploymentSandboxProvisioningPendingError
  // was thrown and persisted — the pending row never learned its sandbox id,
  // so the next sweep attempt provisioned a brand-new sandbox (leaking the
  // first one toward the Daytona org disk cap).
  //
  // Warm-only fast path instead: launch detached, then bail immediately with
  // DeploymentSandboxProvisioningPendingError (provision wait 0) unless the
  // sandbox is already STARTED. The drain's catch persists the sandbox id via
  // markPendingDeliveryProvisioning well inside the waitUntil window, and the
  // relaycron sweep — which runs in its own request context with the full
  // SWEEP_DELIVERY_OPTIONS budget — re-attaches to the SAME sandbox instead
  // of creating another. sandboxCreateTimeoutSeconds still bounds the
  // detached create call itself.
  sandboxCreateTimeoutSeconds: 120,
  sandboxProvisionWaitTimeoutMs: 0,
  runScriptTimeoutMs: 15_000,
  asyncRunScript: true,
};

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as RawRows<T>;
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

type MatchedIntegrationWatchAgentRow = IntegrationWatchAgentRow & {
  triggerKey: string | null;
};

type DispatchFailureRow = {
  id: string;
  relay_workspace_id: string;
  provider: string;
  event_type: string;
  connection_id: string | null;
  delivery_id: string;
  payload: unknown;
  occurred_at: string | Date | null;
};

export type DrainIntegrationWatchDispatchFailuresInput = {
  relayWorkspaceId?: string;
  limit?: number;
  maxFailureAgeSeconds?: number;
};

export type DrainIntegrationWatchDispatchFailuresResult = {
  attempted: number;
  replayed: number;
  failed: number;
};

function parseJsonRecordMaybeString(value: unknown): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record) return record;
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function readTriggerCap(
  caps: Record<string, number> | null | undefined,
  triggerKey: string,
): number | null {
  const value = caps?.[triggerKey];
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function watchRuleMatchesEvent(input: {
  rule: WatchRule;
  eventType: string;
  eventPaths: readonly string[];
  payload?: unknown;
}): boolean {
  if (input.rule.events && input.rule.events.length > 0 && !input.rule.events.includes(input.eventType)) {
    return false;
  }
  if (!watchRuleConditionsMatch(input.rule.conditions, input.payload)) {
    return false;
  }
  return pathsMatchAgent(input.rule.paths, input.eventPaths);
}

function matchingWatchRules(input: {
  row: IntegrationWatchAgentRow;
  eventType: string;
  eventPaths: readonly string[];
  payload?: unknown;
}): WatchRule[] {
  return parseWatchRules(input.row.watch_rules).filter((rule) =>
    watchRuleMatchesEvent({
      rule,
      eventType: input.eventType,
      eventPaths: input.eventPaths,
      payload: input.payload,
    }),
  );
}

function chooseTriggerKeyForMatchedRules(
  row: IntegrationWatchAgentRow,
  rules: readonly WatchRule[],
): string | null {
  let selected: { key: string; cap: number | null } | null = null;
  for (const rule of rules) {
    if (!rule.triggerKey) {
      continue;
    }
    const cap = readTriggerCap(row.delivery_max_concurrency_by_trigger, rule.triggerKey);
    if (!selected) {
      selected = { key: rule.triggerKey, cap };
      continue;
    }
    const selectedSort = selected.cap ?? Number.POSITIVE_INFINITY;
    const capSort = cap ?? Number.POSITIVE_INFINITY;
    if (capSort < selectedSort) {
      selected = { key: rule.triggerKey, cap };
    }
  }
  return selected?.key ?? null;
}

function agentMatchesExplicitEventPaths(input: {
  row: IntegrationWatchAgentRow;
  eventType: string;
  eventPaths: readonly string[];
  payload?: unknown;
}): boolean {
  if (input.eventPaths.length === 0) {
    return true;
  }

  const rules = parseWatchRules(input.row.watch_rules);
  if (rules.length > 0) {
    return rules.some((rule) =>
      watchRuleMatchesEvent({
        rule,
        eventType: input.eventType,
        eventPaths: input.eventPaths,
        payload: input.payload,
      }),
    );
  }

  const watchGlobs = Array.isArray(input.row.watch_globs) ? input.row.watch_globs : [];
  return watchGlobs.length === 0 || pathsMatchAgent(watchGlobs, input.eventPaths);
}

function resolveMatchedTriggerKey(input: {
  row: IntegrationWatchAgentRow;
  eventType: string;
  eventPaths: readonly string[];
  payload?: unknown;
}): string | null {
  const rules = matchingWatchRules(input);
  return chooseTriggerKeyForMatchedRules(input.row, rules);
}

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function cleanIssueIdSegment(value: string): string {
  return decodePathSegment(value)
    .replace(/\.json$/u, "")
    .replace(/__.*$/u, "")
    .trim();
}

function githubIssueKeyFromPath(path: string): string | null {
  const canonical = path.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/issues\/([^/]+)/u);
  if (canonical) {
    const issueId = cleanIssueIdSegment(canonical[3] ?? "");
    if (!issueId || issueId === "_index" || issueId.includes("*")) return null;
    return `github:${decodePathSegment(canonical[1] ?? "")}/${decodePathSegment(canonical[2] ?? "")}#${issueId}`;
  }

  const byId = path.match(/^\/github\/repos\/([^/]+)__([^/]+)\/issues\/by-id\/([^/]+)/u);
  if (byId) {
    const issueId = cleanIssueIdSegment(byId[3] ?? "");
    if (!issueId || issueId.includes("*")) return null;
    return `github:${decodePathSegment(byId[1] ?? "")}/${decodePathSegment(byId[2] ?? "")}#${issueId}`;
  }

  return null;
}

function githubPrKeyFromPath(path: string): string | null {
  const canonical = path.match(/^\/github\/repos\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/([^/]+)/u);
  if (!canonical) return null;
  const prId = cleanIssueIdSegment(canonical[3] ?? "");
  if (!prId || prId === "_index" || prId.includes("*")) return null;
  return `github-pr:${decodePathSegment(canonical[1] ?? "")}/${decodePathSegment(canonical[2] ?? "")}#${prId}`;
}

function githubPrContextPathFromPath(path: string): boolean {
  return /^\/github\/repos\/[^/]+\/[^/]+\/pulls\/[^/]+/u.test(path);
}

function linearIssueKeyFromPath(path: string): string | null {
  const canonical = path.match(/^\/linear\/issues\/([^/]+)/u);
  if (!canonical) return null;
  const issueId = cleanIssueIdSegment(canonical[1] ?? "");
  return issueId && !issueId.includes("*") ? `linear:${issueId}` : null;
}

function issueDispatchDedupeKeyFromPath(provider: string, path: string): string | null {
  if (provider === "github") return githubIssueKeyFromPath(path);
  if (provider === "linear") return linearIssueKeyFromPath(path);
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function githubPayloadResource(payload: unknown): Record<string, unknown> | null {
  const record = asRecord(payload);
  return asRecord(record?.resource) ?? record;
}

function githubPrPartsFromApiUrl(value: unknown): {
  owner: string;
  repo: string;
  number: string;
} | null {
  const raw = firstString(value);
  if (!raw) return null;
  const match = raw.match(/\/repos\/([^/?#]+)\/([^/?#]+)\/pulls\/([1-9]\d*)(?:$|[/?#])/u);
  if (!match) return null;
  return {
    owner: decodePathSegment(match[1] ?? ""),
    repo: decodePathSegment(match[2] ?? ""),
    number: match[3] ?? "",
  };
}

function githubPrKeyFromApiUrl(value: unknown): string | null {
  const parts = githubPrPartsFromApiUrl(value);
  return parts && parts.owner && parts.repo && parts.number
    ? `github-pr:${parts.owner}/${parts.repo}#${parts.number}`
    : null;
}

function githubPrUrlSignalFromPayload(payload: unknown): boolean {
  const resource = githubPayloadResource(payload);
  const links = asRecord(resource?._links);
  const linkPullRequest = asRecord(links?.pull_request);
  const comment = asRecord(resource?.comment);
  return Boolean(
    githubPrKeyFromApiUrl(resource?.pull_request_url) ??
      githubPrKeyFromApiUrl(linkPullRequest?.href) ??
      githubPrKeyFromApiUrl(comment?.pull_request_url),
  );
}

function githubRepositoryKey(
  repository: Record<string, unknown> | null,
  repoNameFallback?: unknown,
): string | null {
  const fullName = firstString(repository?.full_name);
  if (fullName) return fullName;
  const owner = asRecord(repository?.owner);
  const ownerName = firstString(owner?.login, owner?.name, repository?.owner);
  const repoName = firstString(repository?.name, repoNameFallback);
  return ownerName && repoName ? `${ownerName}/${repoName}` : null;
}

function githubIssueKeyFromPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  const issue = asRecord(record?.issue);
  const repository = asRecord(record?.repository) ?? asRecord(issue?.repository);
  const issueId = firstString(issue?.number, record?.number);
  const repoKey = githubRepositoryKey(repository, record?.repo);
  return issueId && repoKey ? `github:${repoKey}#${issueId}` : null;
}

// A check_run.completed payload carries no top-level `pull_request`/`number`;
// instead the associated PRs live in `check_run.pull_requests[]`, each with an
// API `url` like `/repos/<owner>/<repo>/pulls/<n>`. Deriving a PR key here lets
// the failing-CI persona reuse the PR-context #1491 dispatch cooldown: repeated
// failing check_runs for the same PR collapse onto one `github-pr:<repo>#<n>`
// key, so the bot re-attempts a fix at most once per cooldown window instead of
// on every CI re-run.
function githubCheckRunPrKeyFromPayload(payload: unknown): string | null {
  const record = githubPayloadResource(payload);
  const pullRequests = Array.isArray(record?.pull_requests) ? record.pull_requests : [];
  for (const entry of pullRequests) {
    const pr = asRecord(entry);
    if (!pr) continue;
    const urlKey = githubPrKeyFromApiUrl(pr.url);
    if (urlKey) return urlKey;
    const base = asRecord(pr.base);
    const repository = asRecord(base?.repo);
    const repoKey = githubRepositoryKey(repository, record?.repo);
    const prNumber = firstString(pr.number);
    if (repoKey && prNumber) return `github-pr:${repoKey}#${prNumber}`;
  }
  return null;
}

function githubPrKeyFromPayload(payload: unknown): string | null {
  const checkRunKey = githubCheckRunPrKeyFromPayload(payload);
  if (checkRunKey) return checkRunKey;
  const record = githubPayloadResource(payload);
  const links = asRecord(record?._links);
  const linkPullRequest = asRecord(links?.pull_request);
  const comment = asRecord(record?.comment);
  const urlKey =
    githubPrKeyFromApiUrl(record?.pull_request_url) ??
    githubPrKeyFromApiUrl(linkPullRequest?.href) ??
    githubPrKeyFromApiUrl(comment?.pull_request_url);
  if (urlKey) return urlKey;

  const issue = asRecord(record?.issue);
  const pullRequest = asRecord(record?.pull_request);
  const issuePullRequest = asRecord(issue?.pull_request);
  const prId = issuePullRequest
    ? firstString(issue?.number)
    : firstString(pullRequest?.number, record?.number);
  const base = asRecord(pullRequest?.base);
  const head = asRecord(pullRequest?.head);
  const repository =
    asRecord(record?.repository) ??
    asRecord(issue?.repository) ??
    asRecord(base?.repo) ??
    asRecord(head?.repo);
  const repoKey = githubRepositoryKey(repository, record?.repo);
  return prId && repoKey ? `github-pr:${repoKey}#${prId}` : null;
}

function linearIssueKeyFromPayload(payload: unknown): string | null {
  const record = asRecord(payload);
  const eventType = firstString(record?.eventType, record?.type);
  const action = firstString(record?.action);
  const isAgentSessionEvent =
    eventType?.startsWith("AgentSessionEvent.") === true ||
    eventType === "AgentSessionEvent" ||
    (eventType === "AgentSessionEvent" && Boolean(action));
  if (isAgentSessionEvent) {
    const activity = asRecord(record?.agentActivity);
    const prompt = asRecord(record?.prompt);
    const promptContext = asRecord(record?.promptContext);
    const activityId = firstString(
      activity?.id,
      activity?.activityId,
      activity?.uuid,
      prompt?.id,
      prompt?.promptId,
      promptContext?.id,
      record?.agentActivityId,
      record?.promptId,
      record?.activityId,
      record?.webhookId,
      record?.id,
    );
    if (activityId) {
      return `linear-agent-session:${activityId}`;
    }
  }
  const issue = asRecord(record?.issue) ?? asRecord(record?.data);
  const agentSession = asRecord(record?.agentSession);
  const agentSessionIssue = asRecord(agentSession?.issue);
  const issueId = firstString(
    issue?.identifier,
    issue?.id,
    agentSessionIssue?.identifier,
    agentSessionIssue?.id,
    record?.identifier,
    record?.id,
  );
  return issueId ? `linear:${issueId}` : null;
}

function issueDispatchDedupeKeyFromPayload(provider: string, payload: unknown): string | null {
  if (provider === "github") return githubIssueKeyFromPayload(payload);
  if (provider === "linear") return linearIssueKeyFromPayload(payload);
  return null;
}

function isPrContextPayload(payload: unknown, eventPaths: readonly string[] = []): boolean {
  const record = githubPayloadResource(payload);
  const issue = asRecord(record?.issue);
  return Boolean(record?.pull_request) ||
    Boolean(issue?.pull_request) ||
    githubPrUrlSignalFromPayload(payload) ||
    githubCheckRunPrKeyFromPayload(payload) !== null ||
    eventPaths.some(githubPrContextPathFromPath);
}

function readCloudflareEnvString(name: string): string | undefined {
  try {
    const env = getCloudflareContext({ async: false }).env as Record<string, unknown> | undefined;
    const value = env?.[name];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function readIssueDispatchCooldownSeconds(): number {
  const raw =
    tryResourceValue(ISSUE_DISPATCH_COOLDOWN_RESOURCE)?.trim() ??
    readCloudflareEnvString(ISSUE_DISPATCH_COOLDOWN_ENV);
  if (!raw) {
    return DEFAULT_ISSUE_DISPATCH_COOLDOWN_SECONDS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_ISSUE_DISPATCH_COOLDOWN_SECONDS;
}

function normalizedIssueEventName(eventType: string): string {
  return eventType.trim().toLowerCase().replace(/[:_\s/-]+/gu, ".");
}

const ONE_SHOT_ISSUE_DISPATCH_EVENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  github: new Set([
    "issues.opened",
    "issue.opened",
    "issues.created",
    "issue.created",
  ]),
  linear: new Set([
    "issue.created",
    "issue.opened",
    "issues.created",
    "issues.opened",
  ]),
};

const ONE_SHOT_ISSUE_DISPATCH_ACTIONS = new Set(["create", "created", "open", "opened"]);

function issueDispatchPayloadAction(payload: unknown): string | null {
  const record = asRecord(payload);
  const resource = asRecord(record?.resource);
  return firstString(
    record?.action,
    resource?.action,
    record?.webhookAction,
    resource?.webhookAction,
    record?.eventAction,
    resource?.eventAction,
  );
}

function isPermanentIssueDispatchEvent(input: {
  provider: string;
  eventType: string;
  payload?: unknown;
}): boolean {
  const eventType = normalizedIssueEventName(input.eventType);
  if (ONE_SHOT_ISSUE_DISPATCH_EVENTS[input.provider]?.has(eventType)) {
    return true;
  }
  if (eventType === "issue" || eventType === "issues") {
    const action = issueDispatchPayloadAction(input.payload);
    return Boolean(action && ONE_SHOT_ISSUE_DISPATCH_ACTIONS.has(normalizedIssueEventName(action)));
  }
  return false;
}

// A pull-request reviewer's own writebacks re-enter GitHub's event stream: a
// fix push emits pull_request.synchronize, and bot-authored review/comment
// surfaces emit pull_request_review.submitted / *_review_comment.created /
// issue_comment.created. Each of those is a re-review trigger for the same
// reviewer, so without this guard the agent can answer its own comment and
// double-post. We skip ONLY events authored by that reviewer persona's own bot
// identity; a human's or another bot's review/comment still flows through so
// the reviewer can act on it.
const PR_REVIEWER_SELF_TRIGGER_EVENTS = new Set([
  "pull_request.synchronize",
  "pull_request_review.submitted",
  "pull_request_review_comment.created",
  "issue_comment.created",
]);

function githubSelfTriggerActor(input: {
  provider: string;
  eventType: string;
  payload: unknown;
}): { login: string; type: string | null } | null {
  if (input.provider !== "github" || !PR_REVIEWER_SELF_TRIGGER_EVENTS.has(input.eventType)) {
    return null;
  }
  const resource = githubPayloadResource(input.payload);
  // The actor lives in different places per event: sender for every webhook,
  // head.user for a synchronize push, review.user for a submitted review, and
  // comment.user for a review/issue comment.
  const sender = asRecord(resource?.sender);
  const pullRequest = asRecord(resource?.pull_request) ?? resource;
  const head = asRecord(pullRequest?.head);
  const headUser = asRecord(head?.user);
  const review = asRecord(resource?.review);
  const reviewUser = asRecord(review?.user);
  const comment = asRecord(resource?.comment);
  const commentUser = asRecord(comment?.user);
  const actorLogin = firstString(sender?.login, reviewUser?.login, commentUser?.login, headUser?.login);
  const actorType = firstString(sender?.type, reviewUser?.type, commentUser?.type, headUser?.type);
  return actorLogin ? { login: actorLogin, type: actorType } : null;
}

function githubConflictResolveDirectiveMatches(input: {
  provider: string;
  eventType: string;
  payload: unknown;
}): boolean {
  if (input.provider !== "github" || input.eventType !== "issue_comment.created") {
    return false;
  }
  const resource = githubPayloadResource(input.payload);
  const issue = asRecord(resource?.issue);
  if (!asRecord(issue?.pull_request)) {
    return false;
  }
  const comment = asRecord(resource?.comment);
  return matchesConflictResolveDirective(comment?.body);
}

function addLogin(target: Set<string>, value: unknown): void {
  const login = firstString(value);
  if (login) {
    target.add(login);
  }
}

function addReviewerBotLoginAliases(target: Set<string>, login: string): void {
  target.add(login);
  if (PR_REVIEWER_SELF_TRIGGER_BOT_LOGINS.has(login)) {
    for (const alias of PR_REVIEWER_SELF_TRIGGER_BOT_LOGINS) {
      target.add(alias);
    }
  }
}

function botLoginFromAppSlug(value: unknown): string | null {
  const slug = firstString(value);
  if (!slug) return null;
  return slug.endsWith("[bot]") ? slug : `${slug}[bot]`;
}

function githubIntegrationSource(spec: unknown): Record<string, unknown> | null {
  const persona = deploymentPersonaSpec(spec) ?? asRecord(spec);
  const integrations = asRecord(persona?.integrations);
  const github = asRecord(integrations?.github);
  return asRecord(github?.source);
}

function githubWorkspaceServiceAccountName(spec: unknown): string | null {
  const source = githubIntegrationSource(spec);
  return firstString(source?.kind) === "workspace_service_account"
    ? firstString(source?.name)
    : null;
}

function explicitReviewerBotLogins(spec: unknown): Set<string> {
  const logins = new Set<string>();
  const persona = deploymentPersonaSpec(spec) ?? asRecord(spec);
  const capabilities = asRecord(persona?.capabilities);
  const pullRequest = asRecord(capabilities?.pullRequest);
  const source = githubIntegrationSource(persona);
  const github = asRecord(asRecord(persona?.integrations)?.github);
  const identity = asRecord(github?.identity);

  for (const container of [pullRequest, source, identity]) {
    addLogin(logins, container?.botIdentity);
    addLogin(logins, container?.bot_identity);
    addLogin(logins, container?.botLogin);
    addLogin(logins, container?.bot_login);
    addLogin(logins, container?.githubBotLogin);
    addLogin(logins, container?.github_bot_login);
    addLogin(logins, container?.githubAppBotLogin);
    addLogin(logins, container?.github_app_bot_login);
  }
  for (const login of [...logins]) {
    addReviewerBotLoginAliases(logins, login);
  }
  return logins;
}

function githubBotLoginFromIntegrationMetadata(metadata: Record<string, unknown>): string | null {
  const app = asRecord(metadata.app) ?? asRecord(metadata.githubApp) ?? asRecord(metadata.github_app);
  const bot = asRecord(metadata.bot) ?? asRecord(metadata.githubBot) ?? asRecord(metadata.github_bot);
  return firstString(
    metadata.botLogin,
    metadata.bot_login,
    metadata.githubBotLogin,
    metadata.github_bot_login,
    metadata.githubAppBotLogin,
    metadata.github_app_bot_login,
    app?.botLogin,
    app?.bot_login,
    app?.bot_login_name,
    bot?.login,
    bot?.name,
  ) ?? botLoginFromAppSlug(
    firstString(
      metadata.appSlug,
      metadata.app_slug,
      metadata.githubAppSlug,
      metadata.github_app_slug,
      app?.slug,
    ),
  );
}

function preferredGithubIntegrationForReviewer(
  row: IntegrationWatchAgentRow,
  integrations: readonly WorkspaceIntegrationRecord[],
): WorkspaceIntegrationRecord | null {
  const sourceName = githubWorkspaceServiceAccountName(row.spec);
  if (sourceName) {
    return integrations.find((integration) => integration.name === sourceName) ?? null;
  }
  return integrations.find((integration) => !integration.name) ?? integrations[0] ?? null;
}

async function resolveReviewerBotLogins(input: {
  workspaceId: string;
  rows: readonly IntegrationWatchAgentRow[];
}): Promise<Map<string, Set<string>>> {
  const byAgentId = new Map<string, Set<string>>();
  const metadataResolutionRows: IntegrationWatchAgentRow[] = [];
  for (const row of input.rows) {
    const explicit = explicitReviewerBotLogins(row.spec);
    if (explicit.size > 0) {
      byAgentId.set(row.id, explicit);
    } else {
      metadataResolutionRows.push(row);
    }
  }

  if (metadataResolutionRows.length === 0) {
    return byAgentId;
  }

  let integrations: WorkspaceIntegrationRecord[] = [];
  try {
    integrations = await listWorkspaceIntegrationsByProviderAlias(input.workspaceId, "github");
  } catch (error) {
    await logger.warn("Integration watch dispatch could not read GitHub integration metadata for reviewer bot identity", {
      area: "integration-watch-dispatch",
      diag: "github-bot-login-metadata-unavailable",
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  for (const row of metadataResolutionRows) {
    const logins = new Set<string>();
    const integration = preferredGithubIntegrationForReviewer(row, integrations);
    const metadataLogin = integration
      ? githubBotLoginFromIntegrationMetadata(integration.metadata)
      : null;
    if (metadataLogin) {
      addReviewerBotLoginAliases(logins, metadataLogin);
      byAgentId.set(row.id, logins);
      continue;
    }

    const sourceName = githubWorkspaceServiceAccountName(row.spec);
    if (sourceName) {
      const derivedBotLogin = botLoginFromAppSlug(sourceName);
      if (derivedBotLogin) {
        addReviewerBotLoginAliases(logins, derivedBotLogin);
        byAgentId.set(row.id, logins);
        await logger.warn("Integration watch dispatch used heuristic GitHub bot login fallback", {
          area: "integration-watch-dispatch",
          diag: "github-bot-login-source-name-fallback",
          workspaceId: input.workspaceId,
          agentId: row.id,
          deployedName: row.deployed_name ?? undefined,
          sourceName,
          derivedBotLogin,
        });
      }
      continue;
    }

    for (const login of PR_REVIEWER_SELF_TRIGGER_BOT_LOGINS) {
      logins.add(login);
    }
    byAgentId.set(row.id, logins);
    await logger.warn("Integration watch dispatch used default GitHub bot login fallback", {
      area: "integration-watch-dispatch",
      diag: "github-bot-login-default-fallback",
      workspaceId: input.workspaceId,
      agentId: row.id,
      deployedName: row.deployed_name ?? undefined,
      derivedBotLogins: [...PR_REVIEWER_SELF_TRIGGER_BOT_LOGINS],
    });
  }

  return byAgentId;
}

function deriveIssueDispatchDedupeKey(input: {
  provider: string;
  eventPaths: readonly string[];
  payload: unknown;
  isPrContext: boolean;
}): string | null {
  if (input.provider === "github" && input.isPrContext) {
    const payloadKey = githubPrKeyFromPayload(input.payload);
    if (payloadKey) return payloadKey;
    for (const path of input.eventPaths) {
      const key = githubPrKeyFromPath(path);
      if (key) return key;
    }
    return null;
  }
  for (const path of input.eventPaths) {
    const key = issueDispatchDedupeKeyFromPath(input.provider, path);
    if (key) return key;
  }
  return issueDispatchDedupeKeyFromPayload(input.provider, input.payload);
}

export function deriveIntegrationWatchIssueDedupeKey(input: {
  provider: string;
  eventPaths: readonly string[];
  payload: unknown;
}): string | null {
  return deriveIssueDispatchDedupeKey({
    ...input,
    isPrContext: isPrContextPayload(input.payload, input.eventPaths),
  });
}

function readCloudflareWaitUntil(): ((promise: Promise<unknown>) => void) | undefined {
  const context = (globalThis as Record<symbol, unknown>)[cloudflareContextSymbol];
  if (!context || typeof context !== "object") {
    return undefined;
  }
  const cloudflareContext = context as {
    waitUntil?: (promise: Promise<unknown>) => void;
    ctx?: { waitUntil?: (promise: Promise<unknown>) => void };
  };
  if (typeof cloudflareContext.waitUntil === "function") {
    return (promise: Promise<unknown>) => cloudflareContext.waitUntil!(promise);
  }
  if (cloudflareContext.ctx && typeof cloudflareContext.ctx.waitUntil === "function") {
    const ctx = cloudflareContext.ctx;
    return (promise: Promise<unknown>) => ctx.waitUntil!(promise);
  }
  return undefined;
}

function scheduleInlineDrain(input: {
  workspaceId: string;
  agentId: string;
  deliveryId: string;
}): void {
  const waitUntil = readCloudflareWaitUntil();
  if (!waitUntil) {
    logger.warn("Integration watch inline delivery drain skipped without waitUntil", {
      area: "integration-watch-dispatch",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
    });
    return;
  }
  waitUntil(
    drainIntegrationWatchDeliveries({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      deliveryId: input.deliveryId,
      limit: 1,
      leaseSeconds: 60,
      deliveryOptions: INLINE_DRAIN_OPTIONS,
    }).catch((error) =>
      logger.warn("Integration watch inline delivery drain failed", {
        area: "integration-watch-dispatch",
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        deliveryId: input.deliveryId,
        error: error instanceof Error ? error.message : String(error),
      }),
    ),
  );
}

// teamSolveMaxMembers moved to team-launch-n1.ts (exported) so the dispatcher
// gate and the delivery drain share one definition.

function truthyFlag(value: string | null | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" ||
    normalized === "true" ||
    normalized === "yes" ||
    normalized === "enabled";
}

type TeamLaunchN1LaunchDiagStage =
  | "issue-dedupe-skipped"
  | "vfs-dedupe-skipped"
  | "payload-unavailable"
  | "dispatch-skipped"
  | "launch-branch-entered";

// TEMP DIAG: remove after team-N=1 launch-leg root-cause.
async function logCloudTeamIssueLaunchDiag(input: {
  row: IntegrationWatchAgentRow;
  isTeamLaunchN1: boolean;
  workspaceId: string;
  relayWorkspaceId?: string | null;
  provider: string;
  eventType: string;
  deliveryId: string;
  stage: TeamLaunchN1LaunchDiagStage;
  issueDedupe?: DedupeOutcome;
  vfsDedupe?: DedupeOutcome;
  skipReason?: string;
  error?: unknown;
}): Promise<void> {
  if (!input.isTeamLaunchN1) {
    return;
  }
  if (!(input.row.deployed_name ?? "").includes("team-issue")) {
    return;
  }
  const row = input.row as IntegrationWatchAgentRow & {
    deployed_by_user_id?: unknown;
    organization_id?: unknown;
  };
  await logger.info("team-launch-n1 launch-leg diag", {
    area: "team-launch-n1-launch-diag",
    diag: input.stage,
    workspaceId: input.workspaceId,
    relayWorkspaceId: input.relayWorkspaceId ?? undefined,
    provider: input.provider,
    eventType: input.eventType,
    deliveryId: input.deliveryId,
    agentId: input.row.id,
    deployedName: input.row.deployed_name ?? undefined,
    deployedByUserIdPresent: typeof row.deployed_by_user_id === "string" &&
      row.deployed_by_user_id.trim().length > 0,
    organizationIdPresent: typeof row.organization_id === "string" &&
      row.organization_id.trim().length > 0,
    issueDedupe: input.issueDedupe,
    vfsDedupe: input.vfsDedupe,
    skipReason: input.skipReason,
    errorName: input.error instanceof Error ? input.error.name : undefined,
    errorMessage: input.error instanceof Error ? input.error.message.slice(0, 500) : undefined,
  });
}

function readProcessEnvString(name: string): string | undefined {
  if (typeof process === "undefined") {
    return undefined;
  }
  const value = process.env[name];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function isCloudTeamIssueEnabled(): boolean {
  return truthyFlag(
    readCloudflareEnvString(TEAM_ISSUE_ENABLED_ENV) ??
      readProcessEnvString(TEAM_ISSUE_ENABLED_ENV) ??
      readProcessEnvString(TEAM_ISSUE_TEST_ENABLED_ENV),
  );
}

export async function readIntegrationWatchCandidateAgents(
  workspaceId: string,
): Promise<IntegrationWatchAgentRow[]> {
  const result = await getDb().execute(sql`
    SELECT
      agents.id,
      agents.deployed_name,
      agents.deployed_by_user_id,
      workspaces.organization_id,
      agents.watch_globs,
      agents.watch_rules,
      agents.delivery_max_concurrency_by_trigger,
      persona_versions.spec
    FROM agents
    INNER JOIN workspaces ON workspaces.id = agents.workspace_id
    LEFT JOIN persona_versions ON persona_versions.id = agents.pinned_version_id
    WHERE agents.workspace_id = ${workspaceId}
      AND agents.status = 'active'
      AND (
        COALESCE(array_length(agents.watch_globs, 1), 0) > 0
        OR (agents.watch_rules IS NOT NULL AND jsonb_array_length(agents.watch_rules) > 0)
      )
  `);
  // Some Postgres drivers can return `text[]` and `jsonb` columns as raw
  // literal strings — `'{"/github/repos/**/issues/**"}'` for text[], a
  // JSON-stringified blob for jsonb — rather than parsed JS values. The
  // downstream `agentMatchesEvent`
  // matcher and the dispatch diag rely on `Array.isArray(row.watch_globs)`;
  // without normalisation here, every candidate matches as if it had no watch
  // config and the dispatcher silently bails. Parse at the SQL boundary so
  // callers see consistent JS arrays.
  return rowsOf<IntegrationWatchAgentRow>(result).map((row) => ({
    ...row,
    watch_globs: parsePostgresTextArray(row.watch_globs) ?? null,
    watch_rules: parseJsonArrayMaybeString(row.watch_rules) ?? null,
    delivery_max_concurrency_by_trigger: parseJsonRecordMaybeString(
      row.delivery_max_concurrency_by_trigger,
    ) as Record<string, number> | null,
  }));
}

export { deriveIntegrationWatchDeliveryId };

async function claimVfsWatchDedupe(input: {
  workspaceId: string;
  agentId: string;
  writeId?: string | null;
}): Promise<DedupeOutcome> {
  if (!input.writeId?.trim()) {
    return "unavailable";
  }
  const localOutcome = await claimLocalIntegrationWatchDedupe(input);
  if (localOutcome !== "claimed") {
    return localOutcome;
  }

  // The Postgres claim is the authoritative cross-runtime guard. The
  // WorkspaceDO broker remains a best-effort compatibility signal for older
  // VFS paths, but it cannot override a durable DB claim: under DO load the
  // broker's if-match claim can fail open or return stale state.
  await callDedupeBroker("/internal/vfs-dedupe/claim", input);
  return localOutcome;
}

async function claimIssueDispatchDedupe(input: {
  workspaceId: string;
  agentId: string;
  issueKey: string | null;
  deliveryId: string;
  isPrContext: boolean;
  provider: string;
  eventType: string;
  // The dispatched event payload. Recorded as a PENDING coalesced re-dispatch
  // (#1516 Bug 1) when a cooldown claim is suppressed, so the trailing-edge
  // sweep can re-fire it once after the window — picking up reviewers (e.g.
  // cubic) and recurring issue updates that would otherwise be dropped.
  payload?: unknown;
}): Promise<DedupeOutcome> {
  if (!input.issueKey) return "unavailable";
  try {
    if (
      !input.isPrContext &&
      isPermanentIssueDispatchEvent({
        provider: input.provider,
        eventType: input.eventType,
        payload: input.payload,
      })
    ) {
      const result = await getDb().execute(sql`
        INSERT INTO integration_watch_issue_dispatch_dedup (
          workspace_id,
          issue_key,
          agent_id,
          delivery_id,
          updated_at
        )
        VALUES (
          ${input.workspaceId},
          ${input.issueKey},
          ${input.agentId},
          ${input.deliveryId},
          NOW()
        )
        ON CONFLICT (workspace_id, issue_key, agent_id) DO NOTHING
        RETURNING id
      `);
      return rowsOf(result).length > 0 ? "claimed" : "skipped";
    }

    const cooldownSeconds = readIssueDispatchCooldownSeconds();
    const result = await getDb().execute(sql`
      INSERT INTO integration_watch_issue_dispatch_dedup (
        workspace_id,
        issue_key,
        agent_id,
        delivery_id,
        updated_at
      )
      VALUES (
        ${input.workspaceId},
        ${input.issueKey},
        ${input.agentId},
        ${input.deliveryId},
        NOW()
      )
        ON CONFLICT (workspace_id, issue_key, agent_id)
        DO UPDATE SET
          delivery_id = ${input.deliveryId},
          updated_at = NOW(),
          -- A fresh claim (the cooldown has elapsed) starts a NEW window and is
          -- itself the re-dispatch any prior pending marker was waiting for —
          -- clear it so the trailing-edge sweep can't ALSO re-fire (#1516 Bug 1).
          pending_delivery_id = NULL,
          pending_payload = NULL
        WHERE integration_watch_issue_dispatch_dedup.updated_at
          < NOW() - (${cooldownSeconds}::text || ' seconds')::interval
      RETURNING id
    `);
    if (rowsOf(result).length > 0) {
      return "claimed";
    }
    // Within-window suppression: instead of dropping the event, record it as
    // the pending coalesced re-dispatch (latest within-window payload wins).
    // The trailing-edge sweep (sweepCoalescedIssueDispatchRedispatches in
    // integration-watch-deliveries.ts) re-fires exactly ONE run per window after
    // the cooldown expires, so a reviewer who commented inside the window is no
    // longer lost (#1516 Bug 1). Best-effort: a failure here only loses the
    // trailing edge (the pre-existing drop behaviour), never breaks dispatch.
    await getDb().execute(sql`
      UPDATE integration_watch_issue_dispatch_dedup
      SET pending_delivery_id = ${input.deliveryId},
          pending_payload = ${JSON.stringify(input.payload ?? null)}::jsonb
      WHERE workspace_id = ${input.workspaceId}
        AND issue_key = ${input.issueKey}
        AND agent_id = ${input.agentId}
    `);
    return "skipped";
  } catch (error) {
    await logger.error("Integration watch issue dedupe claim failed closed", {
      area: "integration-watch-dispatch",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      issueKey: input.issueKey,
      deliveryId: input.deliveryId,
      error: error instanceof Error ? error.message : String(error),
      errorCauseChain: describeErrorCauseChain(error),
    });
    return "skipped";
  }
}

export async function releaseIssueDispatchDedupe(input: {
  workspaceId: string;
  agentId: string;
  issueKey: string | null;
}): Promise<void> {
  if (!input.issueKey) return;
  try {
    await getDb().execute(sql`
      DELETE FROM integration_watch_issue_dispatch_dedup
      WHERE workspace_id = ${input.workspaceId}
        AND issue_key = ${input.issueKey}
        AND agent_id = ${input.agentId}
    `);
  } catch (error) {
    await logger.warn("Integration watch issue dedupe release failed", {
      area: "integration-watch-dispatch",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      issueKey: input.issueKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function clearIssueDispatchPendingDedupe(input: {
  workspaceId: string;
  agentIds: readonly string[];
  issueKey: string | null;
  deliveryId: string;
}): Promise<void> {
  if (!input.issueKey || input.agentIds.length === 0) return;
  const agentIdList = sql.join(input.agentIds.map((agentId) => sql`${agentId}`), sql`, `);
  try {
    await getDb().execute(sql`
      UPDATE integration_watch_issue_dispatch_dedup
      SET pending_delivery_id = NULL,
          pending_payload = NULL
      WHERE workspace_id = ${input.workspaceId}
        AND issue_key = ${input.issueKey}
        AND agent_id IN (${agentIdList})
    `);
  } catch (error) {
    await logger.warn("Integration watch issue pending dedupe clear failed", {
      area: "integration-watch-dispatch",
      workspaceId: input.workspaceId,
      agentIds: Array.from(input.agentIds),
      issueKey: input.issueKey,
      deliveryId: input.deliveryId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function releaseVfsWatchDedupe(input: {
  workspaceId: string;
  agentId: string;
  writeId?: string | null;
}): Promise<DedupeOutcome> {
  if (!input.writeId?.trim()) {
    return "unavailable";
  }
  const [brokerOutcome, localOutcome] = await Promise.all([
    callDedupeBroker("/internal/vfs-dedupe/release", input),
    releaseLocalIntegrationWatchDedupe(input),
  ]);
  return brokerOutcome !== "unavailable" ? brokerOutcome : localOutcome;
}

function integrationWatchDedupeKey(input: {
  workspaceId: string;
  agentId: string;
  writeId?: string | null;
}): string | null {
  const writeId = input.writeId?.trim();
  if (!writeId) return null;
  return [input.workspaceId, "integration-watch", input.agentId, writeId].join(":");
}

function describeErrorCauseChain(error: unknown): Array<Record<string, string>> {
  const chain: Array<Record<string, string>> = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current != null; depth += 1) {
    if (typeof current !== "object") {
      chain.push({ value: String(current) });
      break;
    }
    const record = current as Record<string, unknown>;
    const link: Record<string, string> = {};
    for (const field of [
      "name",
      "code",
      "severity",
      "message",
      "detail",
      "hint",
      "constraint",
      "table",
      "column",
      "schema",
      "routine",
    ] as const) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) {
        link[field] = value.slice(0, 500);
      }
    }
    if (Object.keys(link).length > 0) {
      chain.push(link);
    }
    if (!("cause" in record) || record.cause === current) {
      break;
    }
    current = record.cause;
  }
  return chain;
}

async function claimLocalIntegrationWatchDedupe(input: {
  workspaceId: string;
  agentId: string;
  writeId?: string | null;
}): Promise<DedupeOutcome> {
  const deliveryId = integrationWatchDedupeKey(input);
  if (!deliveryId) return "unavailable";
  try {
    const claimed = await claimWebhookDelivery({
      surface: "webhook-dispatch",
      deliveryId,
    });
    return claimed ? "claimed" : "skipped";
  } catch (error) {
    await logger.error("Integration watch local dedupe claim failed closed", {
      area: "integration-watch-dispatch",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      writeId: input.writeId ?? undefined,
      error: error instanceof Error ? error.message : String(error),
      errorCauseChain: describeErrorCauseChain(error),
    });
    return "skipped";
  }
}

async function releaseLocalIntegrationWatchDedupe(input: {
  workspaceId: string;
  agentId: string;
  writeId?: string | null;
}): Promise<DedupeOutcome> {
  const deliveryId = integrationWatchDedupeKey(input);
  if (!deliveryId) return "unavailable";
  try {
    await releaseWebhookDelivery({
      surface: "webhook-dispatch",
      deliveryId,
    });
    return "released";
  } catch (error) {
    await logger.warn("Integration watch local dedupe release failed", {
      area: "integration-watch-dispatch",
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      writeId: input.writeId ?? undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    return "unavailable";
  }
}

async function callDedupeBroker(
  path: "/internal/vfs-dedupe/claim" | "/internal/vfs-dedupe/release",
  input: { workspaceId: string; agentId: string; writeId?: string | null },
): Promise<DedupeOutcome> {
  const broker = resolveDedupeBroker();
  const secret = tryResourceValue("AgentGatewayInternalSecret")
    ?? process.env.AGENT_GATEWAY_INTERNAL_SECRET?.trim();
  const body = JSON.stringify({
    workspaceId: input.workspaceId,
    agentId: input.agentId,
    writeId: input.writeId,
  });
  if (!broker && !process.env.AGENT_GATEWAY_BASE_URL?.trim()) {
    return "unavailable";
  }
  if (!broker && !secret) {
    return "unavailable";
  }

  try {
    const response = broker
      ? await broker.fetch(new Request(`https://agent-gateway.internal${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(secret ? { "x-agent-gateway-secret": secret } : {}),
          },
          body,
        }))
      : await globalThis.fetch(`${process.env.AGENT_GATEWAY_BASE_URL!.replace(/\/+$/u, "")}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agent-gateway-secret": secret!,
          },
          body,
        });

    if (!response.ok) {
      return "unavailable";
    }
    const payload = await response.json().catch(() => null) as
      | { data?: { dedupe?: unknown } }
      | null;
    if (payload?.data?.dedupe === "skipped") {
      return "skipped";
    }
    if (payload?.data?.dedupe === "released") {
      return "released";
    }
    return "claimed";
  } catch {
    return "unavailable";
  }
}

function resolveDedupeBroker(): DedupeBroker | null {
  try {
    const env = getCloudflareContext({ async: false }).env;
    const candidate = env?.AGENT_GATEWAY_DEDUPE_BROKER;
    if (
      candidate &&
      typeof candidate === "object" &&
      typeof (candidate as DedupeBroker).fetch === "function"
    ) {
      return candidate as DedupeBroker;
    }
  } catch {
    return null;
  }
  return null;
}

function buildPayload(
  input: IntegrationWatchDispatchInput & { relayWorkspaceId?: string | null },
  eventPaths: readonly string[],
): Record<string, unknown> {
  return {
    id:
      input.deliveryId ??
      `${input.provider}:${input.eventType}:${Date.now().toString(36)}`,
    // `<provider>.<eventType>` matches the runner's `RawGatewayEnvelope.type`
    // convention (`packages/runtime/src/shim.ts:shimEnvelope` — splits on the
    // FIRST dot, requires the first segment to be a known provider source).
    // Earlier code emitted `integration.<provider>.<eventType>`, which made
    // the runtime classify every integration-triggered envelope as
    // `runner.envelope.unsupported` and ack without invoking the handler —
    // dispatch matched the agent, the sandbox spun up, but the agent never
    // saw the event. No other consumer depends on the `integration.` prefix.
    type: `${input.provider}.${input.eventType}`,
    eventType: input.eventType,
    provider: input.provider,
    workspaceId: input.workspaceId,
    relayWorkspaceId: input.relayWorkspaceId ?? undefined,
    connectionId: input.connectionId ?? undefined,
    deliveryId: input.deliveryId ?? undefined,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
    paths: eventPaths,
    resource: input.payload ?? {},
  };
}

function dispatchFailureDeliveryId(input: IntegrationWatchDispatchInput): string {
  return input.deliveryId?.trim() || deriveIntegrationWatchDeliveryId({
    workspaceId: input.workspaceId,
    provider: input.provider,
    eventType: input.eventType,
    connectionId: input.connectionId,
    paths: input.paths,
    payload: input.payload,
  });
}

async function recordDispatchFailure(input: {
  dispatch: IntegrationWatchDispatchInput;
  reason: DispatchFailureReason;
  error: Error;
}): Promise<void> {
  const deliveryId = dispatchFailureDeliveryId(input.dispatch);
  const payload = {
    paths: input.dispatch.paths ?? [],
    payload: input.dispatch.payload ?? null,
  };

  await getDb().execute(sql`
    INSERT INTO integration_watch_dispatch_failures (
      relay_workspace_id,
      provider,
      event_type,
      connection_id,
      delivery_id,
      payload,
      status,
      reason,
      error,
      occurred_at,
      updated_at
    )
    VALUES (
      ${input.dispatch.workspaceId},
      ${input.dispatch.provider},
      ${input.dispatch.eventType},
      ${input.dispatch.connectionId ?? null},
      ${deliveryId},
      ${JSON.stringify(payload)}::jsonb,
      'failed',
      ${input.reason},
      ${input.error.message},
      ${input.dispatch.occurredAt ?? null}::timestamp with time zone,
      NOW()
    )
    ON CONFLICT (relay_workspace_id, provider, event_type, delivery_id) DO UPDATE
    SET connection_id = EXCLUDED.connection_id,
        payload = EXCLUDED.payload,
        status = EXCLUDED.status,
        reason = EXCLUDED.reason,
        error = EXCLUDED.error,
        occurred_at = COALESCE(EXCLUDED.occurred_at, integration_watch_dispatch_failures.occurred_at),
        updated_at = NOW()
  `);

  await logger.warn("Integration watch dispatch failure recorded", {
    area: "integration-watch-dispatch",
    metric: "integration_watch_dispatch_failures_total",
    reason: input.reason,
    status: "failed",
    workspaceId: input.dispatch.workspaceId,
    provider: input.dispatch.provider,
    eventType: input.dispatch.eventType,
    connectionId: input.dispatch.connectionId ?? undefined,
    deliveryId,
  });
}

async function resolveDispatchWorkspace(input: IntegrationWatchDispatchInput): Promise<{
  workspaceId: string;
  relayWorkspaceId: string | null;
}> {
  let appWorkspaceId: string | null;
  try {
    appWorkspaceId = await resolveAppWorkspaceIdForRelayRuntime(input.workspaceId);
  } catch (error) {
    await logger.error("Integration watch dispatch workspace mapping failed", {
      area: "integration-watch-dispatch",
      diag: "workspace_mapping_failed",
      workspaceId: input.workspaceId,
      provider: input.provider,
      eventType: input.eventType,
      connectionId: input.connectionId ?? undefined,
      deliveryId: input.deliveryId ?? undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (isRelayWorkspaceId(input.workspaceId) && !appWorkspaceId) {
    const error = new Error(
      `Integration watch dispatch could not resolve Relay workspace ${input.workspaceId} to an app workspace`,
    );
    await logger.error("Integration watch dispatch workspace mapping unresolved", {
      area: "integration-watch-dispatch",
      diag: "workspace_mapping_unresolved",
      workspaceId: input.workspaceId,
      provider: input.provider,
      eventType: input.eventType,
      connectionId: input.connectionId ?? undefined,
      deliveryId: input.deliveryId ?? undefined,
    });
    try {
      await recordDispatchFailure({
        dispatch: input,
        reason: "workspace_mapping_unresolved",
        error,
      });
    } catch (recordError) {
      await logger.error("Integration watch dispatch failure record failed", {
        area: "integration-watch-dispatch",
        diag: "dispatch_failure_record_failed",
        workspaceId: input.workspaceId,
        provider: input.provider,
        eventType: input.eventType,
        connectionId: input.connectionId ?? undefined,
        deliveryId: input.deliveryId ?? undefined,
        error: recordError instanceof Error ? recordError.message : String(recordError),
      });
    }
    throw error;
  }

  const dispatchWorkspaceId = appWorkspaceId ?? input.workspaceId;
  return {
    workspaceId: dispatchWorkspaceId,
    relayWorkspaceId: dispatchWorkspaceId === input.workspaceId ? null : input.workspaceId,
  };
}

function dispatchFailurePayloadPaths(payload: unknown): string[] {
  const record = asRecord(payload);
  const paths = Array.isArray(record?.paths) ? record.paths : [];
  return paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0);
}

function dispatchFailurePayloadResource(payload: unknown): unknown {
  const record = asRecord(payload);
  return record && "payload" in record ? record.payload : undefined;
}

function readDispatchFailuresForReplayQuery(input: Required<
  Pick<DrainIntegrationWatchDispatchFailuresInput, "limit">
> & Pick<DrainIntegrationWatchDispatchFailuresInput, "relayWorkspaceId" | "maxFailureAgeSeconds">): ReturnType<typeof sql> {
  return sql`
    SELECT
      id,
      relay_workspace_id,
      provider,
      event_type,
      connection_id,
      delivery_id,
      payload,
      occurred_at
    FROM integration_watch_dispatch_failures
    WHERE status = 'failed'
      AND reason = 'workspace_mapping_unresolved'
      AND (${input.relayWorkspaceId ?? null}::text IS NULL OR relay_workspace_id = ${input.relayWorkspaceId ?? null})
      AND (
        ${input.maxFailureAgeSeconds ?? null}::integer IS NULL
        OR created_at >= NOW() - (${input.maxFailureAgeSeconds ?? null} || ' seconds')::interval
      )
    ORDER BY created_at ASC
    LIMIT ${input.limit}
  `;
}

async function markDispatchFailureReplayed(id: string): Promise<void> {
  await getDb().execute(sql`
    UPDATE integration_watch_dispatch_failures
    SET status = 'replayed',
        error = NULL,
        updated_at = NOW()
    WHERE id = ${id}::uuid
      AND status = 'failed'
  `);
}

async function markDispatchFailureReplayError(id: string, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await getDb().execute(sql`
    UPDATE integration_watch_dispatch_failures
    SET error = ${message.slice(0, 4000)},
        updated_at = NOW()
    WHERE id = ${id}::uuid
      AND status = 'failed'
  `);
}

export async function drainIntegrationWatchDispatchFailures(
  input: DrainIntegrationWatchDispatchFailuresInput = {},
): Promise<DrainIntegrationWatchDispatchFailuresResult> {
  const limit = Math.min(Math.max(Math.floor(input.limit ?? 10), 1), 100);
  const maxFailureAgeSeconds =
    typeof input.maxFailureAgeSeconds === "number" && Number.isFinite(input.maxFailureAgeSeconds)
      ? Math.max(Math.floor(input.maxFailureAgeSeconds), 1)
      : undefined;
  const result = await getDb().execute(readDispatchFailuresForReplayQuery({
    relayWorkspaceId: input.relayWorkspaceId,
    limit,
    maxFailureAgeSeconds,
  }));
  const rows = rowsOf<DispatchFailureRow>(result);
  let replayed = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const dispatchResult = await dispatchIntegrationWatchEvent({
        workspaceId: row.relay_workspace_id,
        provider: row.provider,
        eventType: row.event_type,
        connectionId: row.connection_id,
        deliveryId: row.delivery_id,
        paths: dispatchFailurePayloadPaths(row.payload),
        payload: dispatchFailurePayloadResource(row.payload),
        occurredAt: row.occurred_at instanceof Date
          ? row.occurred_at.toISOString()
          : row.occurred_at ?? undefined,
      });
      if (dispatchResult.failed > 0) {
        throw new Error(
          `Replay dispatch had ${dispatchResult.failed} delivery failure(s) for ${row.delivery_id}`,
        );
      }
      await markDispatchFailureReplayed(row.id);
      replayed += 1;
    } catch (error) {
      failed += 1;
      await markDispatchFailureReplayError(row.id, error);
      await logger.warn("Integration watch dispatch failure replay failed", {
        area: "integration-watch-dispatch",
        diag: "dispatch-failure-replay-failed",
        relayWorkspaceId: row.relay_workspace_id,
        provider: row.provider,
        eventType: row.event_type,
        deliveryId: row.delivery_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (rows.length > 0) {
    await logger.info("Integration watch dispatch failure replay completed", {
      area: "integration-watch-dispatch",
      diag: "dispatch-failure-replay",
      relayWorkspaceId: input.relayWorkspaceId,
      attempted: rows.length,
      replayed,
      failed,
      limit,
      maxFailureAgeSeconds,
    });
  }

  return {
    attempted: rows.length,
    replayed,
    failed,
  };
}

export async function dispatchIntegrationWatchEvent(
  input: IntegrationWatchDispatchInput,
): Promise<IntegrationWatchDispatchResult> {
  const { workspaceId: dispatchWorkspaceId, relayWorkspaceId } =
    await resolveDispatchWorkspace(input);
  const dispatchInput = {
    ...input,
    workspaceId: dispatchWorkspaceId,
    relayWorkspaceId,
  };

  // Diagnostic: log every entry so we can pin down where dispatch silently
  // bails for integration-triggered proactive agents. Used to verify the
  // post-#937 unblock of cron also produces dispatches for github issues
  // when an `issue-greeter`-style persona is deployed.
  await logger.info("Integration watch dispatch entered", {
    area: "integration-watch-dispatch",
    diag: "entry",
    workspaceId: dispatchWorkspaceId,
    relayWorkspaceId: relayWorkspaceId ?? undefined,
    provider: input.provider,
    eventType: input.eventType,
    connectionId: input.connectionId ?? undefined,
    deliveryId: input.deliveryId ?? undefined,
    pathCount: input.paths?.length ?? 0,
  });
  const contract = resolveRelayfileProviderContract(input.provider);
  if (!contract) {
    await logger.warn("Integration watch dispatch skipped unknown provider", {
      area: "integration-watch-dispatch",
      diag: "no-contract",
      workspaceId: dispatchWorkspaceId,
      relayWorkspaceId: relayWorkspaceId ?? undefined,
      provider: input.provider,
      eventType: input.eventType,
    });
    return { matched: 0, delivered: 0, failed: 0 };
  }

  const eventPaths = relayfileProviderEventPaths({
    provider: contract.id,
    eventType: input.eventType,
    paths: input.paths,
  });
  const isPrContext = isPrContextPayload(input.payload, eventPaths);
  const issueDedupeKey = deriveIssueDispatchDedupeKey({
    provider: contract.id,
    eventPaths,
    payload: input.payload,
    isPrContext,
  });
  const deliveryId = input.deliveryId?.trim() || deriveIntegrationWatchDeliveryId({
    workspaceId: dispatchWorkspaceId,
    provider: contract.id,
    eventType: input.eventType,
    connectionId: input.connectionId,
    paths: input.paths,
    payload: input.payload,
  });
  const candidates = await readIntegrationWatchCandidateAgents(dispatchWorkspaceId);
  await logger.info("Integration watch dispatch resolved candidates", {
    area: "integration-watch-dispatch",
    diag: "candidates",
    workspaceId: dispatchWorkspaceId,
    relayWorkspaceId: relayWorkspaceId ?? undefined,
    provider: contract.id,
    eventType: input.eventType,
    deliveryId,
    candidateCount: candidates.length,
    candidateIds: candidates.map((row) => row.id),
    // Surface the watch-trigger shape on each candidate so we can see
    // whether `integrations.<provider>.triggers` was persisted at deploy
    // time (agents without watch_globs/watch_rules don't even make it into
    // this list — the readIntegrationWatchCandidateAgents query gates on
    // those columns being non-empty).
    candidateWatchShapes: candidates.map((row) => ({
      id: row.id,
      hasWatchGlobs: Array.isArray(row.watch_globs) && row.watch_globs.length > 0,
      watchRuleCount: Array.isArray(row.watch_rules) ? row.watch_rules.length : 0,
    })),
  });
  // Gate candidate watch paths/rules against the SPECIFIC event path(s), not
  // the broadened `eventPaths`. `relayfileProviderEventPaths` mixes in generic
  // provider resource globs (e.g. `/slack/channels/**/messages/**`) — useful
  // for trigger compatibility, dedupe and payload context, but fatal as a
  // watch-scope gate because channel-scoped paths share that broad prefix.
  // Keep the concrete path gate separate from `agentMatchesEvent` so provider
  // trigger matching can still see the broadened paths older callers rely on.
  const explicitEventPaths = (input.paths ?? []).filter(
    (path): path is string => typeof path === "string" && path.trim().length > 0,
  );
  let matched = candidates.flatMap((row): MatchedIntegrationWatchAgentRow[] => {
    if (
      !agentMatchesExplicitEventPaths({
        row,
        eventType: input.eventType,
        eventPaths: explicitEventPaths,
        payload: input.payload,
      }) ||
      !agentMatchesEvent({
        row,
        provider: contract.id,
        eventType: input.eventType,
        eventPaths,
        // Payload feeds watch-rule `conditions` (e.g. the CI-fix persona only
        // wakes on a check_run whose `conclusion` is a failure).
        payload: input.payload,
      })
    ) {
      return [];
    }
    return [{
      ...row,
      triggerKey: resolveMatchedTriggerKey({
        row,
        eventType: input.eventType,
        eventPaths: explicitEventPaths.length > 0 ? explicitEventPaths : eventPaths,
        payload: input.payload,
      }),
    }];
  });
  if (contract.id === "github" && input.eventType === "issue_comment.created") {
    const directiveMatches = githubConflictResolveDirectiveMatches({
      provider: contract.id,
      eventType: input.eventType,
      payload: input.payload,
    });
    const beforeDirectiveGate = matched.length;
    matched = matched.filter((row) =>
      !isConflictResolvePersona(row.spec) || directiveMatches,
    );
    const skipped = beforeDirectiveGate - matched.length;
    if (skipped > 0) {
      await logger.info("Integration watch dispatch skipped conflict-resolve comment without directive", {
        area: "integration-watch-dispatch",
        diag: "conflict-resolve-directive-missing",
        workspaceId: dispatchWorkspaceId,
        relayWorkspaceId: relayWorkspaceId ?? undefined,
        provider: contract.id,
        eventType: input.eventType,
        deliveryId,
        skipped,
      });
    }
  }
  const payload = buildPayload(
    { ...dispatchInput, provider: contract.id, deliveryId },
    eventPaths,
  );
  const slackConversationResult = await maybeDispatchSlackConversationalAppMention({
    workspaceId: dispatchWorkspaceId,
    deliveryId,
    provider: contract.id,
    eventType: input.eventType,
    matched,
    payload: input.payload,
    enqueuePayload: payload,
  }, {
    isConversationalPersona,
    conversationalConfig,
    threadOwnerLookup: lookupSlackConversationThreadOwner,
    recordThreadOwner: recordSlackConversationThreadOwner,
    startStream: slackConversationEgress.startStream.bind(slackConversationEgress),
    enqueueDelivery: enqueueIntegrationWatchDelivery,
    isPullRequestReviewerPersona,
    applyPullRequestLabel: async ({ workspaceId, deliveryId: labelDeliveryId, target, label }) => {
      const encodedOwner = encodeURIComponent(target.owner);
      const encodedRepo = encodeURIComponent(target.repo);
      const encodedLabel = encodeURIComponent(label);
      const result = await executeRelayfileProviderWriteback({
        opId: `slack-merge-on-green:${labelDeliveryId}:${target.owner}/${target.repo}#${target.number}:${label}`,
        workspaceId,
        provider: "github",
        path: `/github/repos/${encodedOwner}/${encodedRepo}/issues/${target.number}/labels/${encodedLabel}.json`,
        revision: labelDeliveryId,
        correlationId: labelDeliveryId,
        content: JSON.stringify({ labels: [label] }),
      });
      return result.outcome === "success"
        ? { ok: true as const }
        : {
            ok: false as const,
            error: result.error.message,
          };
    },
  });
  const finalizedSlackConversationResult = await finalizeSlackConversationDispatchResult({
    result: slackConversationResult,
    workspaceId: dispatchWorkspaceId,
    relayWorkspaceId,
    provider: contract.id,
    eventType: input.eventType,
    deliveryId,
    matched,
  });
  if (finalizedSlackConversationResult) {
    return finalizedSlackConversationResult;
  }
  const selfTriggerActor = githubSelfTriggerActor({
    provider: contract.id,
    eventType: input.eventType,
    payload: input.payload,
  });
  const reviewerRows = selfTriggerActor?.type === "Bot"
    ? matched.filter((row) => isPullRequestReviewerPersona(row.spec))
    : [];
  const reviewerBotLogins = reviewerRows.length > 0
    ? await resolveReviewerBotLogins({ workspaceId: dispatchWorkspaceId, rows: reviewerRows })
    : new Map<string, Set<string>>();
  const suppressedPrReviewerRows = selfTriggerActor?.type === "Bot"
    ? reviewerRows.filter((row) => reviewerBotLogins.get(row.id)?.has(selfTriggerActor.login))
    : [];
  const deliverable = matched.filter((row) => {
    if (selfTriggerActor?.type !== "Bot") {
      return true;
    }
    // A pr-reviewer persona suppresses its own bot identity's review/comment/
    // push so it cannot answer itself.
    const expectedBotLogins = reviewerBotLogins.get(row.id);
    if (expectedBotLogins?.has(selfTriggerActor.login)) {
      return false;
    }
    // A conflict-autofix persona's safe rebase pushes to the PR head, which
    // emits a `pull_request.synchronize` from the autofix bot. Suppress that
    // self-push so a successful auto-fix cannot immediately re-trigger another
    // classification (the #1491 PR-context cooldown is the second line of
    // defence; the natural loop terminator is the rebased PR reporting
    // `mergeable_state: clean`).
    if (
      isConflictAutofixPersona(row.spec) &&
      selfTriggerActor.login === CONFLICT_AUTOFIX_BOT_LOGIN
    ) {
      return false;
    }
    return true;
  });
  const selfTriggered = matched.length - deliverable.length;
  if (
    contract.id === "github" &&
    input.eventType.startsWith("pull_request") &&
    selfTriggerActor?.type === "Bot"
  ) {
    await logger.info("Integration watch dispatch observed pull-request bot actor", {
      area: "pr-reviewer-self-trigger",
      actorLogin: selfTriggerActor.login,
      actorType: selfTriggerActor.type,
      suppressed: selfTriggered > 0,
      eventType: input.eventType,
    });
  }
  if (selfTriggered > 0) {
    await logger.info("Integration watch dispatch skipped self-trigger", {
      area: "integration-watch-dispatch",
      diag: "self-trigger",
      workspaceId: dispatchWorkspaceId,
      relayWorkspaceId: relayWorkspaceId ?? undefined,
      provider: contract.id,
      eventType: input.eventType,
      deliveryId,
      matched: matched.length,
      skipped: selfTriggered,
    });
  }
  if (suppressedPrReviewerRows.length > 0) {
    await clearIssueDispatchPendingDedupe({
      workspaceId: dispatchWorkspaceId,
      agentIds: suppressedPrReviewerRows.map((row) => row.id),
      issueKey: issueDedupeKey,
      deliveryId,
    });
  }
  if (matched.length === 0) {
    await logger.warn("Integration watch dispatch matched no agents", {
      area: "integration-watch-dispatch",
      diag: "no-match",
      workspaceId: dispatchWorkspaceId,
      relayWorkspaceId: relayWorkspaceId ?? undefined,
      provider: contract.id,
      eventType: input.eventType,
      deliveryId,
      candidateCount: candidates.length,
      candidateIds: candidates.map((row) => row.id),
      eventPaths: Array.from(eventPaths),
    });
    return { matched: 0, delivered: 0, failed: 0 };
  }
  await logIntegrationWatchMatchedAgents({
    workspaceId: dispatchWorkspaceId,
    relayWorkspaceId,
    provider: contract.id,
    eventType: input.eventType,
    deliveryId,
    matched,
  });
  const teamLaunchEnabled = isTeamLaunchN1Enabled();
  const teamLaunchMultiEnabled = isTeamLaunchMultiEnabled();
  const teamIssueEnabled = isCloudTeamIssueEnabled();
  const factoryBrainEnabled = isFactoryBrainEnabled();
  const outcomes = await Promise.allSettled(
    deliverable.map(async (row) => {
      const maxTeamMembers = teamSolveMaxMembers(row.spec);
      const isTeamLaunchN1 = maxTeamMembers === 1;
      // maxMembers > 1 routes into the same launch-delivery arm as N=1 when
      // the multi flag is on; the drain caps the roster loop at maxMembers.
      // Flag off → byte-identical to today: the teamIssue stand-down below.
      const isTeamLaunchMulti =
        maxTeamMembers !== null && maxTeamMembers > 1 && teamLaunchMultiEnabled;
      const isTeamLaunch = isTeamLaunchN1 || isTeamLaunchMulti;
      const isFactoryBrainCandidate =
        contract.id === "linear" &&
        isFactoryIssuePayload(payload) &&
        isFactoryBrainCandidateSpec(row.spec);
      // Gate the live factory-brain dispatch behind the dormant-flip flag. When
      // the flag is off, a `[factory]` issue matching a factory/teamSolve
      // persona falls through to today's behavior (the teamSolve stand-down
      // below, or a plain delivery for a non-teamSolve factory persona) instead
      // of diverting into the live fleet emitter — no enqueue, fully reversible.
      const isFactoryBrain = factoryBrainEnabled && isFactoryBrainCandidate;
      if (isFactoryBrainCandidate && !factoryBrainEnabled) {
        await logger.info("Integration watch factory brain stand-down", {
          area: "factory-cloud-brain",
          diag: "disabled",
          workspaceId: dispatchWorkspaceId,
          relayWorkspaceId: relayWorkspaceId ?? undefined,
          provider: contract.id,
          eventType: input.eventType,
          deliveryId,
          agentId: row.id,
        });
      }
      if (isFactoryBrain) {
        await logger.info("Integration watch factory brain matched", {
          area: "factory-cloud-brain",
          diag: "matched",
          workspaceId: dispatchWorkspaceId,
          relayWorkspaceId: relayWorkspaceId ?? undefined,
          provider: contract.id,
          eventType: input.eventType,
          deliveryId,
          agentId: row.id,
        });
      }
      if (!isFactoryBrain && isTeamLaunchN1 && !teamLaunchEnabled) {
        await logger.info("Integration watch teamSolve N=1 stand-down", {
          area: "team-launch-n1",
          diag: "disabled",
          workspaceId: dispatchWorkspaceId,
          relayWorkspaceId: relayWorkspaceId ?? undefined,
          provider: contract.id,
          eventType: input.eventType,
          deliveryId,
          agentId: row.id,
        });
        return "skipped" as const;
      }
      if (!isFactoryBrain && maxTeamMembers !== null && !isTeamLaunch && !teamIssueEnabled) {
        await logger.info("Integration watch teamSolve stand-down", {
          area: "team-issue",
          diag: "disabled",
          workspaceId: dispatchWorkspaceId,
          relayWorkspaceId: relayWorkspaceId ?? undefined,
          provider: contract.id,
          eventType: input.eventType,
          deliveryId,
          agentId: row.id,
          maxMembers: maxTeamMembers,
        });
        return "skipped" as const;
      }

      // PR-context cooldown claims depend on the self-trigger suppression above:
      // bot-authored reviewer events must not reach this point and extend the window.
      const issueDedupe = await claimIssueDispatchDedupe({
        workspaceId: dispatchWorkspaceId,
        agentId: row.id,
        issueKey: issueDedupeKey,
        deliveryId,
        isPrContext,
        provider: contract.id,
        eventType: input.eventType,
        payload,
      });
      if (issueDedupe === "skipped") {
        await logCloudTeamIssueLaunchDiag({
          row,
          isTeamLaunchN1,
          workspaceId: dispatchWorkspaceId,
          relayWorkspaceId,
          provider: contract.id,
          eventType: input.eventType,
          deliveryId,
          stage: "issue-dedupe-skipped",
          issueDedupe,
        });
        return "skipped" as const;
      }

      const dedupe = await claimVfsWatchDedupe({
        workspaceId: dispatchWorkspaceId,
        agentId: row.id,
        writeId: deliveryId,
      });
      if (dedupe === "skipped") {
        if (issueDedupe === "claimed") {
          await releaseIssueDispatchDedupe({
            workspaceId: dispatchWorkspaceId,
            agentId: row.id,
            issueKey: issueDedupeKey,
          });
        }
        await logCloudTeamIssueLaunchDiag({
          row,
          isTeamLaunchN1,
          workspaceId: dispatchWorkspaceId,
          relayWorkspaceId,
          provider: contract.id,
          eventType: input.eventType,
          deliveryId,
          stage: "vfs-dedupe-skipped",
          issueDedupe,
          vfsDedupe: dedupe,
        });
        return "skipped" as const;
      }

      let queued: "queued" | "delivered" | "failed";
      try {
        if (isFactoryBrain) {
          queued = await enqueueIntegrationWatchDelivery({
            workspaceId: dispatchWorkspaceId,
            agentId: row.id,
            deliveryId,
            triggerKey: row.triggerKey,
            payload: markFactoryBrainPayload(payload),
          });
        } else if (isTeamLaunch) {
          await logCloudTeamIssueLaunchDiag({
            row,
            isTeamLaunchN1,
            workspaceId: dispatchWorkspaceId,
            relayWorkspaceId,
            provider: contract.id,
            eventType: input.eventType,
            deliveryId,
            stage: "launch-branch-entered",
            issueDedupe,
            vfsDedupe: dedupe,
          });
          queued = await enqueueIntegrationWatchDelivery({
            workspaceId: dispatchWorkspaceId,
            agentId: row.id,
            deliveryId,
            triggerKey: row.triggerKey,
            payload: {
              ...payload,
              // Marker name kept for payload-shape stability across N=1 and
              // N>1 — the drain re-derives the member cap from the persona
              // spec, so no count rides in the payload.
              teamLaunchN1: true,
            },
          });
        } else {
          queued = await enqueueIntegrationWatchDelivery({
            workspaceId: dispatchWorkspaceId,
            agentId: row.id,
            deliveryId,
            triggerKey: row.triggerKey,
            payload,
          });
        }
      } catch (error) {
        if (issueDedupe === "claimed") {
          await releaseIssueDispatchDedupe({
            workspaceId: dispatchWorkspaceId,
            agentId: row.id,
            issueKey: issueDedupeKey,
          });
        }
        if (dedupe === "claimed") {
          await releaseVfsWatchDedupe({
            workspaceId: dispatchWorkspaceId,
            agentId: row.id,
            writeId: deliveryId,
          });
        }
        throw error;
      }
      if (queued === "queued" && (!isTeamLaunch || isFactoryBrain)) {
        await enqueueIntegrationWatchDeliveryDrain({
          workspaceId: dispatchWorkspaceId,
          agentId: row.id,
          deliveryId,
        });
        scheduleInlineDrain({
          workspaceId: dispatchWorkspaceId,
          agentId: row.id,
          deliveryId,
        });
      }
      return queued;
    }),
  );
  const queued = outcomes.filter((outcome) =>
    outcome.status === "fulfilled" && outcome.value === "queued"
  ).length;
  const deliveredAlready = outcomes.filter((outcome) =>
    outcome.status === "fulfilled" && outcome.value === "delivered"
  ).length;
  const terminalAlready = outcomes.filter((outcome) =>
    outcome.status === "fulfilled" && outcome.value === "failed"
  ).length;
  const deduped = outcomes.filter((outcome) =>
    outcome.status === "fulfilled" && outcome.value === "skipped"
  ).length;
  const accepted = queued + deliveredAlready;
  const failed = outcomes.length - accepted - deduped - terminalAlready;
  if (deduped > 0) {
    await logger.info("Integration watch dispatch deduped", {
      area: "integration-watch-dispatch",
      workspaceId: dispatchWorkspaceId,
      relayWorkspaceId: relayWorkspaceId ?? undefined,
      provider: contract.id,
      eventType: input.eventType,
      deliveryId,
      matched: matched.length,
      deduped,
      dedupe: "skipped",
    });
  }
  if (failed > 0) {
    // Without per-agent reasons, this log just says "1 failure"; the
    // actual Error (e.g. PersonaDeployError from createSandbox, or a
    // relayauth path-token mint failure) gets swallowed. Capture the
    // rejection reason of each failed agent so the next time this
    // path breaks we don't have to bisect blind.
    const failures = outcomes
      .map((outcome, idx) => ({ outcome, agentId: deliverable[idx]?.id }))
      .filter((entry): entry is { outcome: PromiseRejectedResult; agentId: string } =>
        entry.outcome.status === "rejected" && typeof entry.agentId === "string",
      )
      .map(({ outcome, agentId }) => {
        const reason = outcome.reason;
        return {
          agentId,
          error: reason instanceof Error ? reason.message : String(reason),
          errorStack: reason instanceof Error ? reason.stack?.slice(0, 2000) : undefined,
          errorName: reason instanceof Error ? reason.name : undefined,
        };
      });
    await logger.error("Integration watch dispatch had delivery failures", {
      area: "integration-watch-dispatch",
      workspaceId: dispatchWorkspaceId,
      relayWorkspaceId: relayWorkspaceId ?? undefined,
      provider: contract.id,
      eventType: input.eventType,
      deliveryId,
      matched: matched.length,
      failed,
      failures,
    });
  }
  if (matched.length > 0) {
    await logger.info("Integration watch dispatch completed", {
      area: "integration-watch-dispatch",
      workspaceId: dispatchWorkspaceId,
      relayWorkspaceId: relayWorkspaceId ?? undefined,
      provider: contract.id,
      eventType: input.eventType,
      deliveryId,
      matched: matched.length,
      selfTriggered,
      delivered: accepted,
      queued,
      deliveredAlready,
      terminalAlready,
      failed,
      deduped,
    });
  }

  return {
    matched: matched.length,
    delivered: accepted,
    failed,
  };
}
