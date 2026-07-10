import {
  buildSummary,
  type AgentEventSummary,
} from "./summary-builder.js";

export type AgentEventResource = {
  path: string;
  kind: string;
  id: string;
  provider: string;
};

export type AgentEvent = {
  id: string;
  workspace: string;
  type: string;
  occurredAt: string;
  attempt: number;
  resource: AgentEventResource;
  summary: AgentEventSummary;
  digest?: string;
};

export type CronTickEvent = AgentEvent & {
  type: "cron.tick";
  schedule: string;
  scheduleType: "cron" | "once";
  scheduledFor: string;
};

export type StartupEvent = AgentEvent & {
  type: "startup";
  reason: "cold-start" | "redeploy" | "manual";
};

export type RelayfileChangedEvent = AgentEvent & {
  type: "relayfile.changed";
  path: string;
  watch?: string;
  action?: "created" | "updated" | "deleted";
};

export type RelaycastMessageEvent = AgentEvent & {
  type: "relaycast.message";
  channel: string;
  messageId: string;
  threadId?: string;
};

export type CronEventSource = {
  workspace: string;
  scheduleId: string;
  schedule: string;
  scheduleType?: "cron" | "once";
  scheduledFor: string;
  occurredAt?: string;
  attempt?: number;
  executionId?: string;
};

export type RelayfileChangedSource = {
  workspace: string;
  path: string;
  watch?: string;
  provider?: string;
  occurredAt?: string;
  timestamp?: string;
  eventId?: string;
  revision?: string;
  digest?: string;
  contentHash?: string;
  summary?: Partial<AgentEventSummary>;
  action?: "created" | "updated" | "deleted";
  type?: string;
};

export type RelaycastMessageSource = {
  workspace: string;
  eventId?: string;
  channel: string;
  messageId: string;
  text?: string;
  threadId?: string;
  occurredAt?: string;
  digest?: string;
  from?: {
    id?: string;
    displayName?: string;
  };
};

export async function buildCronTickEnvelope(
  source: CronEventSource,
): Promise<CronTickEvent> {
  const occurredAt = normalizeIsoString(source.occurredAt) ?? new Date().toISOString();
  const scheduledFor =
    normalizeIsoString(source.scheduledFor) ?? occurredAt;
  const eventId =
    readString(source.executionId)
    ?? `cron:${source.workspace}:${source.scheduleId}:${scheduledFor}`;

  const resource = {
    path: `/_cron/${source.scheduleId}`,
    kind: "cron.tick",
    id: source.scheduleId,
    provider: "internal",
  } satisfies AgentEventResource;

  const digest = await sha256Hex(
    JSON.stringify({
      workspace: source.workspace,
      resource,
      schedule: source.schedule,
      scheduledFor,
    }),
  );

  return {
    id: eventId,
    workspace: source.workspace,
    type: "cron.tick",
    occurredAt,
    attempt: clampAttempt(source.attempt),
    resource,
    summary: buildSummary({
      provider: "internal",
      type: "cron.tick",
      schedule: source.schedule,
    }),
    digest,
    schedule: source.schedule,
    scheduleType: source.scheduleType ?? inferCronScheduleType(source.schedule),
    scheduledFor,
  };
}

function inferCronScheduleType(schedule: string): "cron" | "once" {
  return schedule.startsWith("oneshot:") ? "once" : "cron";
}

export async function buildStartupEnvelope(source: {
  workspace: string;
  agentId: string;
  reason?: "cold-start" | "redeploy" | "manual";
  occurredAt?: string;
}): Promise<StartupEvent> {
  const occurredAt = normalizeIsoString(source.occurredAt) ?? new Date().toISOString();
  const eventId = `startup:${source.workspace}:${source.agentId}:${occurredAt}`;
  const resource = {
    path: "/_system/startup",
    kind: "startup",
    id: source.agentId,
    provider: "internal",
  } satisfies AgentEventResource;
  const digest = await sha256Hex(
    JSON.stringify({
      workspace: source.workspace,
      agentId: source.agentId,
      reason: source.reason ?? "manual",
      occurredAt,
    }),
  );

  return {
    id: eventId,
    workspace: source.workspace,
    type: "startup",
    occurredAt,
    attempt: 1,
    resource,
    summary: buildSummary({
      provider: "internal",
      type: "startup",
      schedule: source.reason ?? "manual",
    }),
    digest,
    reason: source.reason ?? "manual",
  };
}

export async function buildRelayfileChangedEnvelope(
  source: RelayfileChangedSource,
): Promise<RelayfileChangedEvent> {
  const occurredAt =
    normalizeIsoString(source.occurredAt ?? source.timestamp) ?? new Date().toISOString();
  const provider = inferProvider(source.path, source.provider);
  const action = normalizeRelayfileAction(source.action, source.type);
  const eventId =
    readString(source.eventId)
    ?? `relayfile:${source.workspace}:${source.path}:${source.revision ?? occurredAt}`;
  const resource = {
    path: source.path,
    kind: inferResourceKind(source.path, provider),
    id: inferResourceId(source.path),
    provider,
  } satisfies AgentEventResource;
  const digest =
    readString(source.digest)
    ?? readString(source.contentHash)
    ?? readString(source.revision)
    ?? await sha256Hex(
      JSON.stringify({
        workspace: source.workspace,
        path: source.path,
        provider,
        action,
        occurredAt,
      }),
    );

  return {
    id: eventId,
    workspace: source.workspace,
    type: "relayfile.changed",
    occurredAt,
    attempt: 1,
    resource,
    summary: buildSummary({
      provider,
      type: `${provider}.changed`,
      raw: source,
      path: source.path,
      action,
      revision: source.revision,
      summary: mergeRelayfileSummary(provider, source.path, action, source.summary),
    }),
    digest,
    path: source.path,
    watch: readString(source.watch),
    action,
  };
}

export async function buildRelaycastMessageEnvelope(
  source: RelaycastMessageSource,
): Promise<RelaycastMessageEvent> {
  const occurredAt = normalizeIsoString(source.occurredAt) ?? new Date().toISOString();
  const channel = readString(source.channel) ?? "unknown";
  const messageId = readString(source.messageId) ?? crypto.randomUUID();
  const resource = {
    path: `/_relaycast/${encodeURIComponent(channel)}/${encodeURIComponent(messageId)}`,
    kind: "relaycast.message",
    id: messageId,
    provider: "relaycast",
  } satisfies AgentEventResource;
  const digest =
    readString(source.digest)
    ?? await sha256Hex(
      JSON.stringify({
        workspace: source.workspace,
        channel,
        messageId,
        text: source.text ?? "",
        threadId: source.threadId ?? "",
        occurredAt,
      }),
    );

  const title = buildRelaycastTitle(source.text);
  const actor = normalizeActor(source.from);
  const eventId =
    readString(source.eventId)
    ?? `relaycast:${source.workspace}:${channel}:${messageId}`;

  return {
    id: eventId,
    workspace: source.workspace,
    type: "relaycast.message",
    occurredAt,
    attempt: 1,
    resource,
    summary: buildSummary({
      provider: "relaycast",
      type: "relaycast.message",
      raw: source,
      summary: {
        ...(title ? { title } : {}),
        ...(actor ? { actor } : {}),
      },
    }),
    digest,
    channel,
    messageId,
    threadId: readString(source.threadId),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const payload = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function clampAttempt(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.floor(value);
}

function normalizeIsoString(value: string | undefined): string | undefined {
  const trimmed = readString(value);
  if (!trimmed) {
    return undefined;
  }
  try {
    const timestamp = new Date(trimmed).toISOString();
    return timestamp;
  } catch {
    return undefined;
  }
}

function readString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function buildRelaycastTitle(text: string | undefined): string | undefined {
  const normalized = readString(text?.replace(/\s+/g, " "));
  return normalized ? normalized.slice(0, 80) : undefined;
}

function normalizeActor(input: RelaycastMessageSource["from"]) {
  const id = readString(input?.id);
  const displayName = readString(input?.displayName);
  if (!id && !displayName) {
    return undefined;
  }
  return {
    id: id ?? displayName ?? "unknown",
    ...(displayName ? { displayName } : {}),
  };
}

function normalizeRelayfileAction(
  action: RelayfileChangedSource["action"],
  type: string | undefined,
): RelayfileChangedEvent["action"] {
  if (action === "created" || action === "updated" || action === "deleted") {
    return action;
  }

  switch (type?.trim()) {
    case "file.created":
    case "dir.created":
      return "created";
    case "file.updated":
      return "updated";
    case "file.deleted":
    case "dir.deleted":
      return "deleted";
    default:
      return undefined;
  }
}

function inferProvider(path: string, fallback: string | undefined): string {
  const preferred = readString(fallback)?.toLowerCase();
  if (preferred) {
    return preferred;
  }

  const segments = path.split("/").filter(Boolean);
  const first = segments[0]?.toLowerCase();
  if (!first || first.startsWith("_")) {
    return "relayfile";
  }
  if (first === "insights" && segments[1]) {
    return segments[1].toLowerCase();
  }
  return first;
}

function inferResourceKind(path: string, provider: string): string {
  if (provider === "relayfile") {
    return "relayfile.file";
  }

  const segments = path.split("/").filter(Boolean);
  const collection = segments.length > 1 ? segments.at(-2) : undefined;
  const normalized = normalizeCollection(collection);
  return normalized ? `${provider}.${normalized}` : `${provider}.resource`;
}

function inferResourceId(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const leaf = segments.at(-1) ?? path;
  return leaf.replace(/\.(json|md|txt|yaml|yml)$/i, "") || leaf;
}

function normalizeCollection(segment: string | undefined): string | undefined {
  const normalized = segment?.trim().replace(/^_+/, "").toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const aliases: Record<string, string> = {
    notifications: "notification",
    prs: "pull_request",
    pulls: "pull_request",
    merge_requests: "merge_request",
    "merge-requests": "merge_request",
    issues: "issue",
    comments: "comment",
    tickets: "ticket",
    records: "record",
    tables: "table",
    bases: "base",
    messages: "message",
    threads: "thread",
    files: "file",
    pages: "page",
    tasks: "task",
    projects: "project",
  };

  if (aliases[normalized]) {
    return aliases[normalized];
  }
  if (normalized.endsWith("ies")) {
    return `${normalized.slice(0, -3)}y`;
  }
  if (normalized.endsWith("s") && normalized.length > 1) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function describePath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments.at(-1) || path || "relayfile change";
}

function mergeRelayfileSummary(
  provider: string,
  path: string,
  action: RelayfileChangedEvent["action"],
  summary: Partial<AgentEventSummary> | undefined,
): AgentEventSummary {
  const providerTags = provider !== "relayfile" ? [provider] : [];
  const summaryTags = summary?.tags ?? [];
  const tags = [...new Set([...providerTags, ...summaryTags])];

  return {
    title: summary?.title ?? describePath(path),
    status: summary?.status ?? action,
    priority: summary?.priority,
    labels: summary?.labels,
    actor: summary?.actor,
    fieldsChanged: summary?.fieldsChanged,
    ...(tags.length > 0 ? { tags } : {}),
  };
}
