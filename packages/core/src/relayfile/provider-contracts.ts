import {
  CONFLUENCE_OBJECT_TYPES,
  resources as confluenceResources,
} from "@relayfile/adapter-confluence";
import {
  DEFAULT_GITHUB_EVENTS,
  resources as githubResources,
} from "@relayfile/adapter-github";
import {
  EVENT_MAP as gitLabEventMap,
  resources as gitLabResources,
} from "@relayfile/adapter-gitlab";
import { resources as jiraResources } from "@relayfile/adapter-jira";
import {
  linearAgentWebhookTriggerGlob,
  LINEAR_AGENT_WEBHOOK_EVENTS,
  LINEAR_WEBHOOK_OBJECT_TYPES,
  resources as linearResources,
} from "@relayfile/adapter-linear";
import { resources as notionResources } from "@relayfile/adapter-notion";
import {
  SlackAdapter,
  resources as slackResources,
} from "@relayfile/adapter-slack";
import {
  GCP_WEBHOOK_EVENTS,
  resources as gcpResources,
} from "@relayfile/adapter-gcp";
import { resources as cloudflareResources } from "@relayfile/adapter-cloudflare/resources";
import { KNOWN_TRIGGER_CATALOG } from "@relayfile/adapter-core/triggers";
import { readOnlyResources as neonResources } from "@relayfile/adapter-neon/resources";

export type RelayfileProviderResource = {
  readonly name: string;
  readonly path: string;
  readonly sampleIndexPath?: string;
};

export type RelayfileProviderContract = {
  readonly id: string;
  readonly root: string;
  readonly resources: readonly RelayfileProviderResource[];
  readonly triggerEvents?: readonly string[];
  readonly triggerGlobs?: (trigger: string) => readonly string[];
};

type ProviderEntry = RelayfileProviderContract & {
  readonly aliases?: readonly string[];
  readonly matches?: (provider: string) => boolean;
};

function webhookObjectEvents(
  objectTypes: readonly string[],
  actions: readonly string[],
): string[] {
  return objectTypes.flatMap((objectType) =>
    actions.map((action) => `${objectType}.${action}`),
  );
}

const GOOGLE_MAIL_RESOURCES: readonly RelayfileProviderResource[] = [
  { name: "labels", path: "/google-mail/labels" },
  { name: "filters", path: "/google-mail/filters" },
  { name: "send-as", path: "/google-mail/send-as" },
  { name: "messages", path: "/google-mail/messages" },
  { name: "threads", path: "/google-mail/threads" },
  { name: "watch-renewals", path: "/google-mail/watch-renewals" },
];

const GOOGLE_CALENDAR_RESOURCES: readonly RelayfileProviderResource[] = [
  { name: "calendars", path: "/google-calendar/calendars" },
  { name: "settings", path: "/google-calendar/settings" },
  {
    name: "colors",
    path: "/google-calendar/colors/{colorType}",
    sampleIndexPath: "/google-calendar/colors",
  },
  {
    name: "events",
    path: "/google-calendar/calendars/{calendarId}/events",
    sampleIndexPath: "/google-calendar/events",
  },
  {
    name: "acls",
    path: "/google-calendar/calendars/{calendarId}/acls",
    sampleIndexPath: "/google-calendar/acls",
  },
  { name: "watch-renewals", path: "/google-calendar/watch-renewals" },
];

const DAYTONA_TRIGGER_EVENTS = [
  "sandbox.created",
  "sandbox.state.updated",
  "snapshot.created",
  "snapshot.state.updated",
  "snapshot.removed",
  "volume.created",
  "volume.state.updated",
  "incident",
] as const;

const CLOUDFLARE_TRIGGER_EVENTS = (
  KNOWN_TRIGGER_CATALOG.cloudflare ?? [
    "workers_alert",
    "workers_observability_alert",
    "advanced_http_alert_error",
    "http_alert_origin_error",
    "billing_usage_alert",
    "health_check_status_notification",
    "dedicated_ssl_certificate_event_type",
    "access_custom_certificate_expiration_type",
  ]
) as readonly string[];

// Adapter-slack's static SLACK_SUPPORTED_EVENTS export is pending release
// (relayfile-adapters branch codex/slack-supported-events-export); consume the
// current public adapter method so Cloud does not hand-copy the event catalog.
export const SLACK_SUPPORTED_EVENTS = new SlackAdapter(
  { writeFile: async () => ({}) } as never,
  "slack" as never,
  undefined as never,
).supportedEvents();

const PROVIDERS: readonly ProviderEntry[] = [
  {
    id: "github",
    root: "/github",
    aliases: ["github-relay", "github-sage"],
    resources: githubResources as readonly RelayfileProviderResource[],
    triggerEvents: DEFAULT_GITHUB_EVENTS,
  },
  {
    id: "gitlab",
    root: "/gitlab",
    aliases: ["gitlab-relay"],
    resources: gitLabResources as readonly RelayfileProviderResource[],
    triggerEvents: Object.keys(gitLabEventMap),
  },
  {
    id: "linear",
    root: "/linear",
    aliases: ["linear-relay", "linear-sage"],
    resources: linearResources as readonly RelayfileProviderResource[],
    triggerEvents: [
      ...webhookObjectEvents(LINEAR_WEBHOOK_OBJECT_TYPES, ["create", "update", "remove"]),
      ...LINEAR_AGENT_WEBHOOK_EVENTS,
    ],
    triggerGlobs: (trigger) => {
      const glob = linearAgentWebhookTriggerGlob(trigger);
      return glob ? [glob] : [];
    },
  },
  {
    id: "notion",
    root: "/notion",
    aliases: ["notion-relay", "notion-sage"],
    resources: notionResources as readonly RelayfileProviderResource[],
  },
  {
    id: "confluence",
    root: "/confluence",
    aliases: ["confluence-relay"],
    resources: confluenceResources as readonly RelayfileProviderResource[],
    triggerEvents: webhookObjectEvents(
      CONFLUENCE_OBJECT_TYPES,
      ["created", "updated", "deleted"],
    ),
  },
  {
    id: "jira",
    root: "/jira",
    aliases: ["jira-relay", "jira-sage"],
    resources: jiraResources as readonly RelayfileProviderResource[],
  },
  {
    id: "slack",
    root: "/slack",
    aliases: ["slack-relay", "slack-sage", "slack-sage-preview"],
    matches: (provider) => provider === "slack" || provider.startsWith("slack-"),
    resources: slackResources as readonly RelayfileProviderResource[],
    triggerEvents: SLACK_SUPPORTED_EVENTS,
  },
  {
    id: "telegram",
    root: "/telegram",
    aliases: ["telegram-relay"],
    resources: [],
    triggerEvents: ["message", "message.text"],
  },
  {
    id: "google-mail",
    root: "/google-mail",
    aliases: ["google-mail-relay", "gmail"],
    resources: GOOGLE_MAIL_RESOURCES,
  },
  {
    id: "google-calendar",
    root: "/google-calendar",
    aliases: ["google-calendar-relay"],
    resources: GOOGLE_CALENDAR_RESOURCES,
  },
  {
    id: "daytona",
    root: "/daytona",
    aliases: ["daytona-relay"],
    resources: [],
    triggerEvents: DAYTONA_TRIGGER_EVENTS,
  },
  {
    id: "gcp",
    root: "/gcp",
    aliases: ["gcp-relay"],
    resources: gcpResources as readonly RelayfileProviderResource[],
    triggerEvents: GCP_WEBHOOK_EVENTS,
  },
  {
    id: "cloudflare",
    root: "/cloudflare",
    aliases: ["cloudflare-relay"],
    resources: cloudflareResources as readonly RelayfileProviderResource[],
    triggerEvents: CLOUDFLARE_TRIGGER_EVENTS,
  },
  {
    id: "neon",
    root: "/neon",
    aliases: ["neon-relay", "neon-composio-relay"],
    resources: neonResources as readonly RelayfileProviderResource[],
    triggerEvents: KNOWN_TRIGGER_CATALOG.neon,
  },
  {
    id: "x",
    root: "/x",
    aliases: ["twitter", "x-relay"],
    resources: [],
  },
];

const RESOURCE_TOKEN_ALIASES: Readonly<Record<string, readonly string[]>> = {
  acl: ["acl", "acls"],
  app_mention: ["messages", "message", "app_mention", "mention", "channels"],
  branch: ["branches", "branch", "repos", "repositories", "repository"],
  build: ["build", "builds", "job", "jobs", "pipelines", "pipeline"],
  calendar: ["calendar", "calendars"],
  channel: ["channel", "channels"],
  color: ["color", "colors"],
  comment: ["comment", "comments", "issue-comments", "discussion", "discussions", "replies"],
  commit: ["commit", "commits", "push"],
  content: ["content", "page", "pages"],
  database: ["database", "databases", "page", "pages"],
  deployment: ["deployment", "deployments"],
  direct_message: ["direct-messages", "messages"],
  draft: ["draft", "drafts"],
  event: ["event", "events"],
  filter: ["filter", "filters"],
  group: ["group", "groups", "channel", "channels"],
  issue: ["issue", "issues", "issue-comments", "comment", "comments"],
  job: ["job", "jobs", "build", "builds", "pipeline", "pipelines"],
  label: ["label", "labels"],
  merge_request: ["merge_request", "merge_requests", "pull_request", "pulls", "reviews", "discussions"],
  message: ["message", "messages", "direct-messages", "replies"],
  page: ["page", "pages", "content", "comments", "properties"],
  pipeline: ["pipeline", "pipelines", "job", "jobs"],
  project: ["project", "projects"],
  property: ["property", "properties"],
  pull: ["pull", "pulls", "pull_request", "reviews"],
  pull_request: ["pull_request", "pull", "pulls", "reviews"],
  pull_request_review: ["pull_request_review", "review", "reviews"],
  pull_request_review_comment: [
    "pull_request_review_comment",
    "comment",
    "comments",
  ],
  pull_request_review_thread: [
    "pull_request_review_thread",
    "review",
    "reviews",
  ],
  push: ["push", "commit", "commits", "repository", "repo", "repos"],
  reaction: ["reaction", "reactions"],
  repo: ["repo", "repos", "repository", "repositories", "push"],
  repository: ["repository", "repositories", "repo", "repos", "push"],
  review: ["review", "reviews", "pull_request", "pulls"],
  send_as: ["send-as", "send_as"],
  setting: ["setting", "settings"],
  space: ["space", "spaces", "pages"],
  tag: ["tag", "tags", "tag_push"],
  thread: ["thread", "threads"],
  transition: ["transition", "transitions"],
  user: ["user", "users", "direct-messages"],
  watch: ["watch", "watches", "watch-renewals"],
  watch_renewal: ["watch-renewal", "watch-renewals", "watch", "watches"],
  worklog: ["worklog", "worklogs", "issue", "issues"],
};

const ACTION_ALIASES: Readonly<Record<string, readonly string[]>> = {
  add: ["add", "added", "create", "created"],
  archive: ["archive", "archived"],
  close: ["close", "closed"],
  create: ["create", "created", "open", "opened", "add", "added"],
  delete: ["delete", "deleted", "remove", "removed", "destroy", "destroyed"],
  destroy: ["destroy", "destroyed", "delete", "deleted"],
  join: ["join", "joined"],
  leave: ["leave", "left"],
  merge: ["merge", "merged"],
  open: ["open", "opened", "create", "created", "reopen", "reopened"],
  remove: ["remove", "removed", "delete", "deleted"],
  reopen: ["reopen", "reopened", "open", "opened"],
  restore: ["restore", "restored"],
  sync: ["sync", "changed", "change", "updated", "update"],
  trash: ["trash", "trashed"],
  update: ["update", "updated", "change", "changed", "sync", "synchronize", "synchronized"],
};

function normalizeProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-:\s/]+/gu, "_")
    .replace(/_+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

function normalizePath(path: string): string {
  const trimmed = path.trim().replace(/\\/g, "/");
  const leading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return leading.replace(/\/+/gu, "/").replace(/\/$/u, "");
}

function pathToGlob(path: string): string {
  const withWildcards = normalizePath(path)
    .replace(/\{[^/}]+\}/gu, "**")
    .replace(/\/[^/]*(?:\.(?:json|md|txt))$/u, "");
  return withWildcards.endsWith("/**") ? withWildcards : `${withWildcards}/**`;
}

function expandToken(token: string): Set<string> {
  const normalized = normalizeToken(token);
  const aliases = RESOURCE_TOKEN_ALIASES[normalized] ?? [];
  return new Set([normalized, ...aliases.map(normalizeToken)]);
}

function resourceTokens(resource: RelayfileProviderResource): Set<string> {
  const tokens = new Set<string>();
  for (const token of [
    resource.name,
    ...resource.path.split("/"),
    ...(resource.sampleIndexPath?.split("/") ?? []),
  ]) {
    const normalized = normalizeToken(token.replace(/[{}]/gu, ""));
    if (normalized && !normalized.endsWith("id") && normalized !== "**") {
      tokens.add(normalized);
    }
  }
  return tokens;
}

function firstEventToken(event: string): string | null {
  const [token] = normalizeRelayfileTriggerEventName(event).split(".");
  return token || null;
}

function eventAction(event: string): string | null {
  const parts = normalizeRelayfileTriggerEventName(event).split(".").filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] ?? null : null;
}

function triggerEventsMatch(expected: string, actual: string): boolean {
  return (
    normalizeRelayfileTriggerEventName(expected) ===
    normalizeRelayfileTriggerEventName(actual)
  );
}

function actionMatches(expected: string | null, actual: string | null): boolean {
  if (!expected || !actual) {
    return true;
  }
  if (expected === actual) {
    return true;
  }
  const expectedAliases = new Set([
    expected,
    ...(ACTION_ALIASES[expected] ?? []).map(normalizeToken),
  ]);
  const actualAliases = new Set([
    actual,
    ...(ACTION_ALIASES[actual] ?? []).map(normalizeToken),
  ]);
  for (const alias of expectedAliases) {
    if (actualAliases.has(alias)) {
      return true;
    }
  }
  return false;
}

function resourceMatchesTrigger(resource: RelayfileProviderResource, trigger: string): boolean {
  const triggerToken = firstEventToken(trigger);
  if (!triggerToken) {
    return false;
  }
  const accepted = expandToken(triggerToken);
  const actual = resourceTokens(resource);
  for (const token of accepted) {
    if (actual.has(token)) {
      return true;
    }
  }
  return false;
}

function globsForResourceTrigger(
  resource: RelayfileProviderResource,
  trigger: string,
): string[] {
  const triggerToken = firstEventToken(trigger);
  if (!triggerToken) {
    return [pathToGlob(resource.path)];
  }
  const accepted = expandToken(triggerToken);
  const segments = normalizePath(resource.path).split("/").filter(Boolean);
  const matchedIndex = segments.findIndex((segment) =>
    accepted.has(normalizeToken(segment.replace(/[{}]/gu, ""))),
  );
  const primary =
    matchedIndex >= 0
      ? `/${segments
          .slice(0, matchedIndex + 1)
          .map((segment) => (segment.startsWith("{") ? "**" : segment))
          .join("/")}/**`
      : pathToGlob(resource.path);
  return [
    primary,
    ...(resource.sampleIndexPath ? [pathToGlob(resource.sampleIndexPath)] : []),
  ];
}

export function resolveRelayfileProviderContract(
  provider: string,
): RelayfileProviderContract | null {
  const normalized = normalizeProviderName(provider);
  const entry = PROVIDERS.find((candidate) => (
    candidate.id === normalized ||
    candidate.aliases?.includes(normalized) ||
    candidate.matches?.(normalized)
  ));
  if (!entry) {
    return null;
  }
  return {
    id: entry.id,
    root: entry.root,
    resources: entry.resources,
    triggerEvents: entry.triggerEvents,
    triggerGlobs: entry.triggerGlobs,
  };
}

export function relayfileProviderRoot(provider: string): string | null {
  return resolveRelayfileProviderContract(provider)?.root ?? null;
}

export function relayfileProviderResourceGlobs(provider: string): string[] {
  const contract = resolveRelayfileProviderContract(provider);
  if (!contract) {
    return [];
  }
  const paths = contract.resources.flatMap((resource) => [
    pathToGlob(resource.path),
    ...(resource.sampleIndexPath ? [pathToGlob(resource.sampleIndexPath)] : []),
  ]);
  return [...new Set(paths.length > 0 ? paths : [`${contract.root}/**`])]
    .sort((left, right) => left.localeCompare(right));
}

export function relayfilePathsForProviderTrigger(
  provider: string,
  trigger: string,
): string[] {
  const contract = resolveRelayfileProviderContract(provider);
  if (!contract) {
    return [];
  }
  const direct = contract.triggerGlobs?.(trigger) ?? [];
  if (direct.length > 0) {
    return [...new Set(direct)].sort((left, right) => left.localeCompare(right));
  }
  const matched = contract.resources
    .filter((resource) => resourceMatchesTrigger(resource, trigger))
    .flatMap((resource) => globsForResourceTrigger(resource, trigger));
  if (matched.length === 0 && contract.resources.length > 0) {
    if (contract.triggerEvents?.some((event) => triggerEventsMatch(event, trigger))) {
      return [`${contract.root}/**`];
    }
    return [];
  }
  return [...new Set(matched.length > 0 ? matched : [`${contract.root}/**`])]
    .sort((left, right) => left.localeCompare(right));
}

export function relayfileProviderEventPaths(input: {
  provider: string;
  eventType?: string | null;
  paths?: readonly string[];
}): string[] {
  const explicit = (input.paths ?? [])
    .filter((path) => typeof path === "string" && path.trim())
    .map((path) => normalizePath(path));
  const contract = resolveRelayfileProviderContract(input.provider);
  if (!contract) {
    return [...new Set(explicit)].sort((left, right) => left.localeCompare(right));
  }
  const inferred = input.eventType
    ? relayfilePathsForProviderTrigger(contract.id, input.eventType)
    : [`${contract.root}/**`];
  return [...new Set([...explicit, ...inferred])]
    .sort((left, right) => left.localeCompare(right));
}

export function normalizeRelayfileTriggerEventName(event: string): string {
  const cleaned = event
    .trim()
    .replace(/^jira:/u, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[:\s/-]+/gu, ".")
    .replace(/\.+/gu, ".")
    .replace(/^\.+|\.+$/gu, "")
    .toLowerCase();
  if (cleaned.includes(".") || !cleaned.includes("_")) {
    return cleaned;
  }
  const parts = cleaned.split("_").filter(Boolean);
  const maybeAction = parts.at(-1);
  if (!maybeAction || !ACTION_ALIASES[maybeAction]) {
    return cleaned;
  }
  return `${parts.slice(0, -1).join("_")}.${maybeAction}`;
}

export function relayfileTriggerMatchesEvent(input: {
  trigger: string;
  eventType: string;
}): boolean {
  const trigger = normalizeRelayfileTriggerEventName(input.trigger);
  const eventType = normalizeRelayfileTriggerEventName(input.eventType);
  if (!trigger || !eventType) {
    return false;
  }
  if (trigger === eventType || eventType.startsWith(`${trigger}.`)) {
    return true;
  }
  if (trigger === "app_mention" || eventType === "app_mention") {
    return false;
  }
  const triggerResource = firstEventToken(trigger);
  const eventResource = firstEventToken(eventType);
  if (!triggerResource || !eventResource) {
    return false;
  }
  const acceptedResources = expandToken(triggerResource);
  const eventResources = expandToken(eventResource);
  const resourceMatch = [...acceptedResources].some((token) => eventResources.has(token));
  return resourceMatch && actionMatches(eventAction(trigger), eventAction(eventType));
}
