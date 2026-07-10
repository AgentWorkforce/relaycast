import {
  normalizeRelayfilePath,
  relayfilePathsForTrigger,
  type RelayfileTriggerDescriptor,
} from "../relayfile/path-scopes.js";
import {
  relayfileTriggerMatchesEvent,
} from "../relayfile/provider-contracts.js";
import { providerTriggersFromDeploymentSpec } from "./agent-spec.js";

export type IntegrationWatchAgentRow = {
  id: string;
  deployed_name?: string | null;
  deployed_by_user_id?: string | null;
  organization_id?: string | null;
  watch_globs: string[] | null;
  watch_rules?: unknown[] | null;
  delivery_max_concurrency_by_trigger?: Record<string, number> | null;
  spec: Record<string, unknown> | null;
};

export type AgentMatchesEventInput = {
  row: IntegrationWatchAgentRow;
  provider: string;
  eventType: string;
  eventPaths: readonly string[];
  // The dispatched event payload, used to evaluate watch-rule `conditions`
  // (e.g. a github check_run's `conclusion`). Optional: rules without
  // conditions match exactly as before when this is omitted.
  payload?: unknown;
};

export type AgentMatchesEventOptions = {
  requireTriggerSpec?: boolean;
};

export type IntegrationWatchDeliveryIdInput = {
  workspaceId: string;
  provider: string;
  eventType: string;
  connectionId?: string | null;
  paths?: readonly string[];
  payload?: unknown;
};

// A declarative predicate on the event payload. `field` is a dot-path into the
// dispatched payload (e.g. "conclusion" for a github check_run, or
// "check_run.conclusion" for a nested shape); the condition holds when the
// resolved value equals `equals` or is a member of `in`. Conditions let a
// persona filter beyond event-type + path — the failing-CI persona watches
// `check_run.completed` but only wants `conclusion ∈ {failure, timed_out, …}`,
// so a green check never wakes it (this is also what breaks the fix→re-run
// self-trigger loop: a passing re-run reports conclusion=success and is
// filtered out).
export type WatchRuleCondition = {
  field: string;
  equals?: string;
  in?: string[];
};

export type WatchRule = {
  paths: string[];
  events?: string[];
  conditions?: WatchRuleCondition[];
  // A content filter on the event's human-readable text, carried from the
  // persona-kit trigger `match` sugar. Two forms:
  //  - the literal token `@mention` — the event text addresses an agent, i.e.
  //    it contains a Slack mention token (`<@…>`). The exact bot user id is not
  //    reliably available on the agent row at match time, so v1 fires on ANY
  //    `<@…>` mention; this is intentionally permissive (see PR description).
  //  - any other string — a case-insensitive substring test against the text.
  // Absent `match` ⇒ no content gate (today's behavior, unchanged).
  match?: string;
  triggerKey?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deriveIntegrationWatchDeliveryId(
  input: IntegrationWatchDeliveryIdInput,
): string {
  const paths = input.paths?.length ? [...input.paths].sort() : [];
  const keyParts = [
    "integration-watch",
    input.workspaceId,
    input.provider,
    input.eventType,
    input.connectionId?.trim() || "no-connection",
    paths.join(",") || stableJson(input.payload),
  ];
  const version = deriveDeliveryVersion(input.eventType, input.payload);
  if (version) {
    keyParts.push(version);
  }
  return keyParts.join(":");
}

// VFS event path is the primary per-event distinctness mechanism (review/comment id
// in the path); this version key is a defense-in-depth backstop for PR events
// and the sole discriminator for pull_request.synchronize, which shares the
// PR-number path.
export function deriveDeliveryVersion(eventType: string, payload: unknown): string {
  if (eventType.startsWith("AgentSessionEvent.")) {
    const activityId = linearAgentSessionActivityId(payload);
    return activityId ? `activity:${activityId}` : "";
  }
  if (!eventType.startsWith("pull_request") && !eventType.startsWith("issue_comment.")) {
    return "";
  }
  if (!isRecord(payload)) {
    return eventType.startsWith("pull_request") ? ":" : "";
  }

  if (eventType.startsWith("pull_request_review_comment.")) {
    const commentId = recordId(payload.comment);
    if (commentId) {
      return `comment:${commentId}`;
    }
  }

  if (eventType.startsWith("pull_request_review.")) {
    const reviewId = recordId(payload.review);
    if (reviewId) {
      return `review:${reviewId}`;
    }
  }

  if (eventType.startsWith("issue_comment.")) {
    const issue = payload.issue;
    if (!isRecord(issue) || !isRecord(issue.pull_request)) {
      return "";
    }
    const commentId = recordId(payload.comment);
    return commentId ? `comment:${commentId}` : "";
  }

  const pullRequest = payload.pull_request;
  if (!isRecord(pullRequest)) {
    return ":";
  }
  return derivePullRequestShaVersion(pullRequest);
}

function linearAgentSessionActivityId(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }
  const activity = recordValue(payload.agentActivity);
  const prompt = recordValue(payload.prompt);
  const promptContext = recordValue(payload.promptContext);
  return firstString(
    activity?.id,
    activity?.activityId,
    activity?.uuid,
    prompt?.id,
    prompt?.promptId,
    promptContext?.id,
    payload.agentActivityId,
    payload.promptId,
    payload.activityId,
    payload.webhookId,
    payload.id,
  );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
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

function recordId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = value.id;
  if (typeof id === "string" && id.trim()) {
    return id.trim();
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  return null;
}

function derivePullRequestShaVersion(pullRequest: Record<string, unknown>): string {
  const head = pullRequest.head;
  const base = pullRequest.base;
  const headSha = isRecord(head) && typeof head.sha === "string" ? head.sha : "";
  const baseSha = isRecord(base) && typeof base.sha === "string" ? base.sha : "";
  return `${headSha}:${baseSha}`;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function triggerName(trigger: RelayfileTriggerDescriptor): string | null {
  if (typeof trigger === "string") {
    const trimmed = trigger.trim();
    return trimmed || null;
  }
  for (const key of ["on", "event", "type", "name"]) {
    const value = trigger[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  const nested = trigger.trigger;
  return typeof nested === "string" || isRecord(nested)
    ? triggerName(nested as RelayfileTriggerDescriptor)
    : null;
}

export function providerTriggers(
  spec: Record<string, unknown>,
  provider: string,
): RelayfileTriggerDescriptor[] {
  return providerTriggersFromDeploymentSpec(spec, provider);
}

export function globPrefix(glob: string): string {
  const normalized = normalizeRelayfilePath(glob);
  const markerIndex = normalized.search(/[*{]/u);
  const prefix = markerIndex >= 0 ? normalized.slice(0, markerIndex) : normalized;
  return prefix.replace(/\/+$/u, "");
}

export function pathCouldIntersect(left: string, right: string): boolean {
  const leftPath = normalizeRelayfilePath(left);
  const rightPath = normalizeRelayfilePath(right);
  if (!leftPath || !rightPath) {
    return false;
  }
  if (leftPath === rightPath) {
    return true;
  }
  const leftPrefix = globPrefix(leftPath);
  const rightPrefix = globPrefix(rightPath);
  return (
    leftPath.startsWith(`${rightPrefix}/`) ||
    rightPath.startsWith(`${leftPrefix}/`) ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  );
}

export function pathsMatchAgent(
  watchGlobs: readonly string[],
  eventPaths: readonly string[],
): boolean {
  return watchGlobs.some((glob) =>
    eventPaths.some((path) => pathCouldIntersect(glob, path)),
  );
}

export function triggerMatchesPath(
  provider: string,
  trigger: RelayfileTriggerDescriptor,
  eventPaths: readonly string[],
): boolean {
  try {
    return pathsMatchAgent(relayfilePathsForTrigger(provider, trigger), eventPaths);
  } catch {
    return true;
  }
}

export function parseWatchRules(raw: unknown): WatchRule[] {
  if (!Array.isArray(raw)) return [];
  const out: WatchRule[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const paths = Array.isArray(entry.paths)
      ? entry.paths.filter(
          (path): path is string => typeof path === "string" && path.length > 0,
        )
      : [];
    if (paths.length === 0) continue;
    const events = Array.isArray(entry.events)
      ? entry.events.filter(
          (event): event is string => typeof event === "string" && event.length > 0,
        )
      : undefined;
    const conditions = parseWatchRuleConditions(entry.conditions);
    const triggerKey = typeof entry.triggerKey === "string" && entry.triggerKey.trim().length > 0
      ? entry.triggerKey.trim()
      : undefined;
    const match = typeof entry.match === "string" && entry.match.trim().length > 0
      ? entry.match.trim()
      : undefined;
    out.push({
      paths,
      events,
      conditions,
      ...(match ? { match } : {}),
      ...(triggerKey ? { triggerKey } : {}),
    });
  }
  return out;
}

function parseWatchRuleConditions(raw: unknown): WatchRuleCondition[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: WatchRuleCondition[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const field = typeof entry.field === "string" ? entry.field.trim() : "";
    if (!field) continue;
    const equals = typeof entry.equals === "string" ? entry.equals : undefined;
    const inValues = Array.isArray(entry.in)
      ? entry.in.filter((v): v is string => typeof v === "string" && v.length > 0)
      : undefined;
    if (equals === undefined && (!inValues || inValues.length === 0)) continue;
    out.push({ field, equals, in: inValues });
  }
  return out.length > 0 ? out : undefined;
}

function resolveFieldValues(payload: unknown, field: string): unknown[] {
  return resolveFieldValuesFrom(payload, field.split("."));
}

function resolveFieldValuesFrom(value: unknown, segments: string[]): unknown[] {
  const [segment, ...rest] = segments;
  if (segment === undefined) {
    return Array.isArray(value) ? value : [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => resolveFieldValuesFrom(entry, segments));
  }
  if (!isRecord(value)) {
    return [undefined];
  }
  return resolveFieldValuesFrom(value[segment], rest);
}

function conditionMatches(condition: WatchRuleCondition, payload: unknown): boolean {
  const values = resolveFieldValues(payload, condition.field);
  return values.some((value) => {
    const asString = typeof value === "string" ? value : value == null ? "" : String(value);
    if (condition.equals !== undefined && asString !== condition.equals) {
      return false;
    }
    if (condition.in && condition.in.length > 0 && !condition.in.includes(asString)) {
      return false;
    }
    return true;
  });
}

export function watchRuleConditionsMatch(
  conditions: readonly WatchRuleCondition[] | undefined,
  payload: unknown,
): boolean {
  if (!conditions || conditions.length === 0) return true;
  return conditions.every((condition) => conditionMatches(condition, payload));
}

// The literal `match` token meaning "this event addresses an agent". Resolving
// the agent's EXACT Slack bot user id is ideal, but that identity is not
// reliably present on the agent row/payload at dispatch time, so v1 treats the
// presence of ANY Slack mention token as the gate (see WatchRule.match).
const MENTION_MATCH_TOKEN = "@mention";
// Slack renders a user mention as `<@U…>` and a usergroup mention as
// `<!subteam^S…>`; either is a cheap signal that a message addresses someone
// (a person or a group the agent may belong to).
const SLACK_MENTION_RE = /<@[^>]+>|<!subteam\^[^>]+>/u;

// The human-readable text of an event, used by `match`. For Slack message
// events the dispatcher hands us the normalized record whose `text` field holds
// the message body (see nango-webhook-router's slack normalizer). We also read
// a nested `message.text`/`record.text` so the same gate works if a caller
// passes the raw envelope. Returns "" when no text is present.
function eventMatchText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return "";
  const candidates = [
    payload.text,
    isRecord(payload.message) ? payload.message.text : undefined,
    isRecord(payload.record) ? payload.record.text : undefined,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return "";
}

// Evaluate a watch rule's `match` content filter against the event payload.
// Absent `match` ⇒ always true (no gate). `@mention` ⇒ text contains a Slack
// mention token. Any other value ⇒ case-insensitive substring test.
export function watchRuleMatchMatches(match: string | undefined, payload: unknown): boolean {
  if (!match) return true;
  const text = eventMatchText(payload);
  if (match === MENTION_MATCH_TOKEN) {
    return SLACK_MENTION_RE.test(text);
  }
  return text.toLowerCase().includes(match.toLowerCase());
}

export function watchRulesMatchEvent(
  rules: readonly WatchRule[],
  eventType: string,
  eventPaths: readonly string[],
  payload?: unknown,
): boolean {
  return rules.some((rule) => {
    if (rule.events && rule.events.length > 0 && !rule.events.includes(eventType)) {
      return false;
    }
    if (!watchRuleConditionsMatch(rule.conditions, payload)) {
      return false;
    }
    if (!watchRuleMatchMatches(rule.match, payload)) {
      return false;
    }
    return pathsMatchAgent(rule.paths, eventPaths);
  });
}

export function agentMatchesEvent(
  input: AgentMatchesEventInput,
  options: AgentMatchesEventOptions = {},
): boolean {
  const rules = parseWatchRules(input.row.watch_rules);
  if (rules.length > 0) {
    return watchRulesMatchEvent(rules, input.eventType, input.eventPaths, input.payload);
  }

  const watchGlobs = Array.isArray(input.row.watch_globs) ? input.row.watch_globs : [];
  if (watchGlobs.length === 0) {
    return false;
  }
  if (!pathsMatchAgent(watchGlobs, input.eventPaths)) {
    return false;
  }

  const requireTriggerSpec = options.requireTriggerSpec ?? true;
  if (!input.row.spec) {
    return !requireTriggerSpec;
  }

  const triggers = providerTriggers(input.row.spec, input.provider);
  return triggers.some((trigger) => {
    const name = triggerName(trigger);
    return Boolean(
      name &&
        relayfileTriggerMatchesEvent({ trigger: name, eventType: input.eventType }) &&
        triggerMatchesPath(input.provider, trigger, input.eventPaths) &&
        triggerContentMatches(trigger, input.payload),
    );
  });
}

// Enforce a raw trigger descriptor's `match`/`where` content filters in the
// watch_globs fallback path (the canonical path is watch_rules, which is gated
// in watchRulesMatchEvent). Mirrors the same semantics so behavior is identical
// regardless of which matching path a row takes. Absent both ⇒ true (unchanged).
function triggerContentMatches(
  trigger: RelayfileTriggerDescriptor,
  payload: unknown,
): boolean {
  if (typeof trigger === "string") return true;
  const match = typeof trigger.match === "string" && trigger.match.trim().length > 0
    ? trigger.match.trim()
    : undefined;
  if (!watchRuleMatchMatches(match, payload)) {
    return false;
  }
  const where = typeof trigger.where === "string" ? trigger.where : "";
  const conditions = parseWhereConditions(where);
  return watchRuleConditionsMatch(conditions, payload);
}

// Parse a trigger `where` string ("field=value", comma-separated, ANDed) into
// the same WatchRuleCondition predicate the deploy-side translation produces
// (see persona-deploy `parseTriggerWhere`). Malformed pairs are skipped so the
// fallback path stays permissive rather than throwing during dispatch.
function parseWhereConditions(where: string): WatchRuleCondition[] | undefined {
  if (!where.trim()) return undefined;
  const out: WatchRuleCondition[] = [];
  for (const pair of where.split(",")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const field = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!field || !value) continue;
    out.push({ field, equals: value });
  }
  return out.length > 0 ? out : undefined;
}
