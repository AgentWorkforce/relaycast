import type { IntegrationWatchAgentRow } from "@cloud/core/proactive-runtime/match.js";
import { logger } from "@/lib/logger";
import { isSlackConversationRoutingEnabled } from "@/lib/integrations/slack-conversation/flag";
import {
  lookupSlackConversationThreadOwner,
  recordSlackConversationThreadOwner,
} from "@/lib/integrations/slack-conversation/threads";
import { normalizeSlackChannelId } from "@/lib/integrations/slack-channel-id";
import {
  selectConversationalAgent,
  type ConversationalCandidate,
} from "@/lib/integrations/slack-conversation/router";

export type SlackConversationDispatchResult = {
  matched: number;
  delivered: number;
  failed: number;
};

type MergeOnGreenTarget = {
  owner: string;
  repo: string;
  number: number;
};

type SlackConversationMarker = {
  channel: string;
  threadTs?: string;
  ackTs?: string;
  selectedVia: "thread" | "prefix" | "channel" | "default";
};

export type SlackConversationDispatchDeps = {
  routingEnabled?: () => boolean;
  threadOwnerLookup?: (input: {
    workspaceId: string;
    channel: string;
    threadTs: string;
  }) => Promise<string | null>;
  recordThreadOwner?: (input: {
    workspaceId: string;
    channel: string;
    threadTs: string;
    deployedName: string;
    agentId: string;
  }) => Promise<void>;
  isConversationalPersona?: (spec: unknown) => boolean;
  conversationalConfig?: (spec: unknown) => {
    channels: string[];
    defaultResponder: boolean;
    identity?: {
      username?: string;
      iconUrl?: string;
    };
  };
  startStream?: (input: {
    workspaceId: string;
    channel: string;
    threadTs?: string;
    markdownText?: string;
    identity?: {
      username?: string;
      iconUrl?: string;
    };
  }) => Promise<{
    // Mirrors @agent-assistant/surfaces SlackProgressResult plus the cloud
    // egress's structured errorDetail (see slack-conversation/egress.ts).
    ok: boolean;
    ts?: string;
    error?: string;
    errorDetail?: { code: string; message: string };
  }>;
  enqueueDelivery?: (input: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
    triggerKey?: string | null;
    payload: Record<string, unknown>;
  }) => Promise<"queued" | "delivered" | "failed">;
  isPullRequestReviewerPersona?: (spec: unknown) => boolean;
  applyPullRequestLabel?: (input: {
    workspaceId: string;
    deliveryId: string;
    target: MergeOnGreenTarget;
    label: string;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  // Injectable warn sink. Tests must inject this instead of mock.method on the
  // logger module: the test files and this module can resolve @/lib/logger to
  // different module instances under tsx in CI, so a module-level mock is not
  // guaranteed to observe these calls.
  logWarn?: (message: string, fields: Record<string, unknown>) => Promise<void> | void;
};

type RoutedConversationalCandidate = ConversationalCandidate & {
  row: IntegrationWatchAgentRow;
};

const MERGE_ON_GREEN_LABEL = "merge-on-green";
const MERGE_ON_GREEN_RECENT_TTL_MS = 5 * 60 * 1000;
const mergeOnGreenPending = new Map<string, Promise<SlackConversationDispatchResult>>();
const mergeOnGreenRecent = new Map<string, number>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readSlackConversationEvent(
  payload: unknown,
): {
  channel: string;
  threadTs?: string;
  ts?: string;
  eventId?: string;
  text: string;
} | null {
  const record = isRecord(payload) ? payload : null;
  const event = isRecord(record?.event) ? record.event : record;
  const channel = readString(event?.channel);
  if (!channel) {
    return null;
  }

  const threadTs = readString(event?.thread_ts);
  const ts = readString(event?.ts);
  const eventId = readString(record?.event_id) ?? readString(record?.eventId) ??
    readString(event?.event_id) ?? readString(event?.eventId) ?? readString(event?.client_msg_id);
  return {
    channel: normalizeSlackChannelId(channel),
    ...(threadTs ? { threadTs } : {}),
    ...(ts ? { ts } : {}),
    ...(eventId ? { eventId } : {}),
    text: readString(event?.text) ?? "",
  };
}

function conversationalCandidateFromRow(
  row: IntegrationWatchAgentRow,
  readConfig: NonNullable<SlackConversationDispatchDeps["conversationalConfig"]>,
): RoutedConversationalCandidate {
  const config = readConfig(row.spec);
  return {
    row,
    deployedName: row.deployed_name ?? row.id,
    channels: config.channels.map((channel) => normalizeSlackChannelId(channel)),
    defaultResponder: config.defaultResponder,
    identity: config.identity,
  };
}

function selectedSlackConversationMarker(input: {
  event: { channel: string; threadTs?: string };
  ackTs?: string;
  selectedVia: "thread" | "prefix" | "channel" | "default";
}): SlackConversationMarker {
  return {
    channel: input.event.channel,
    ...(input.event.threadTs ?? input.ackTs ? { threadTs: input.event.threadTs ?? input.ackTs } : {}),
    ...(input.ackTs ? { ackTs: input.ackTs } : {}),
    selectedVia: input.selectedVia,
  };
}

function slackReplyThreadTs(event: { threadTs?: string; ts?: string }): string | undefined {
  return event.threadTs ?? event.ts;
}

function normalizeAgentName(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function isMergeOnGreenIntent(text: string): boolean {
  return /\bmerge[-\s]?on[-\s]?green\b/iu.test(text) ||
    /\bmerge\s+(?:when|once)\s+green\b/iu.test(text) ||
    /\bauto[-\s]?merge\b/iu.test(text);
}

function unwrapSlackLinks(text: string): string {
  return text.replace(/<((?:https?:\/\/|github\.com\/)[^>|]+)(?:\|[^>]+)?>/giu, "$1");
}

function parseMergeOnGreenTarget(text: string): MergeOnGreenTarget | null {
  const normalized = unwrapSlackLinks(text);
  const urlMatch = normalized.match(
    /(?:https?:\/\/)?github\.com\/([^/\s>|]+)\/([^/\s>|]+)\/pull\/([1-9]\d*)\b/iu,
  );
  const shorthandMatch = normalized.match(
    /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d*)\b/u,
  );
  const match = urlMatch ?? shorthandMatch;
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }
  if (match[1].toLowerCase() !== "agentworkforce") {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2],
    number: Number(match[3]),
  };
}

function mergeOnGreenKey(input: {
  workspaceId: string;
  deliveryId: string;
  event: { channel: string; threadTs?: string; ts?: string; eventId?: string; text: string };
  target: MergeOnGreenTarget;
}): { key: string; hasStableEventIdentity: boolean } {
  const prKey = `${input.target.owner}/${input.target.repo}#${input.target.number}`.toLowerCase();
  const eventIdentity = input.event.eventId ??
    (input.event.ts ? `ts:${input.event.channel}:${input.event.threadTs ?? ""}:${input.event.ts}` : null);
  if (eventIdentity) {
    return {
      key: `${input.workspaceId}:slack:${eventIdentity}:${prKey}`,
      hasStableEventIdentity: true,
    };
  }
  return {
    key: `${input.workspaceId}:fallback:${input.event.channel}:${input.event.threadTs ?? ""}:${input.event.text.trim().toLowerCase()}:${prKey}`,
    hasStableEventIdentity: false,
  };
}

function pruneMergeOnGreenRecent(now: number): void {
  for (const [key, expiresAt] of mergeOnGreenRecent) {
    if (expiresAt <= now) {
      mergeOnGreenRecent.delete(key);
    }
  }
}

async function handleMergeOnGreenActivation(input: {
  workspaceId: string;
  deliveryId: string;
  matchedCount: number;
  event: NonNullable<ReturnType<typeof readSlackConversationEvent>>;
  selectedAgent: RoutedConversationalCandidate;
  target: MergeOnGreenTarget;
  startStream: NonNullable<SlackConversationDispatchDeps["startStream"]>;
  applyPullRequestLabel: NonNullable<SlackConversationDispatchDeps["applyPullRequestLabel"]>;
  logWarn: NonNullable<SlackConversationDispatchDeps["logWarn"]>;
}): Promise<SlackConversationDispatchResult> {
  const { key, hasStableEventIdentity } = mergeOnGreenKey({
    workspaceId: input.workspaceId,
    deliveryId: input.deliveryId,
    event: input.event,
    target: input.target,
  });
  const now = Date.now();
  pruneMergeOnGreenRecent(now);
  if (mergeOnGreenRecent.has(key)) {
    return { matched: input.matchedCount, delivered: 1, failed: 0 };
  }

  const pending = mergeOnGreenPending.get(key);
  if (pending) {
    return pending;
  }

  const run = (async () => {
    if (!hasStableEventIdentity) {
      await input.logWarn("Slack merge-on-green activation missing stable event identity", {
        area: "integration-watch-dispatch",
        diag: "slack-merge-on-green-missing-event-identity",
        workspaceId: input.workspaceId,
        deliveryId: input.deliveryId,
        channel: input.event.channel,
      });
    }

    const labelResult = await input.applyPullRequestLabel({
      workspaceId: input.workspaceId,
      deliveryId: input.deliveryId,
      target: input.target,
      label: MERGE_ON_GREEN_LABEL,
    });
    const threadTs = slackReplyThreadTs(input.event);
    if (!labelResult.ok) {
      await input.logWarn("Slack merge-on-green label write failed", {
        area: "integration-watch-dispatch",
        diag: "slack-merge-on-green-label-failed",
        workspaceId: input.workspaceId,
        deliveryId: input.deliveryId,
        owner: input.target.owner,
        repo: input.target.repo,
        number: input.target.number,
        error: labelResult.error,
      });
      const ack = await input.startStream({
        workspaceId: input.workspaceId,
        channel: input.event.channel,
        ...(threadTs ? { threadTs } : {}),
        markdownText: `I couldn't enable merge-on-green for ${input.target.owner}/${input.target.repo}#${input.target.number}: ${labelResult.error}`,
        ...(input.selectedAgent.identity ? { identity: input.selectedAgent.identity } : {}),
      });
      if (!ack.ok) {
        await input.logWarn("Slack merge-on-green failure confirmation failed", {
          area: "integration-watch-dispatch",
          diag: "slack-merge-on-green-confirmation-failed",
          workspaceId: input.workspaceId,
          deliveryId: input.deliveryId,
          errorCode: ack.errorDetail?.code ?? "unknown",
          errorMessage: ack.errorDetail?.message ?? ack.error ?? "Slack egress call failed.",
        });
      }
      return { matched: input.matchedCount, delivered: 0, failed: 1 };
    }

    const ack = await input.startStream({
      workspaceId: input.workspaceId,
      channel: input.event.channel,
      ...(threadTs ? { threadTs } : {}),
      markdownText: `Enabled merge-on-green for ${input.target.owner}/${input.target.repo}#${input.target.number}.`,
      ...(input.selectedAgent.identity ? { identity: input.selectedAgent.identity } : {}),
    });
    if (!ack.ok) {
      await input.logWarn("Slack merge-on-green confirmation failed", {
        area: "integration-watch-dispatch",
        diag: "slack-merge-on-green-confirmation-failed",
        workspaceId: input.workspaceId,
        deliveryId: input.deliveryId,
        owner: input.target.owner,
        repo: input.target.repo,
        number: input.target.number,
        errorCode: ack.errorDetail?.code ?? "unknown",
        errorMessage: ack.errorDetail?.message ?? ack.error ?? "Slack egress call failed.",
      });
      return { matched: input.matchedCount, delivered: 0, failed: 1 };
    }

    mergeOnGreenRecent.set(key, Date.now() + MERGE_ON_GREEN_RECENT_TTL_MS);
    return { matched: input.matchedCount, delivered: 1, failed: 0 };
  })();

  mergeOnGreenPending.set(key, run);
  try {
    return await run;
  } finally {
    mergeOnGreenPending.delete(key);
  }
}

export async function maybeDispatchSlackConversationalAppMention(input: {
  workspaceId: string;
  deliveryId: string;
  provider: string;
  eventType: string;
  matched: IntegrationWatchAgentRow[];
  payload: unknown;
  enqueuePayload: Record<string, unknown>;
}, deps: SlackConversationDispatchDeps = {}): Promise<SlackConversationDispatchResult | null> {
  const routingEnabled = deps.routingEnabled ?? isSlackConversationRoutingEnabled;
  const logWarn = deps.logWarn ??
    ((message: string, fields: Record<string, unknown>) => logger.warn(message, fields));
  if (!routingEnabled() || input.provider !== "slack" || input.eventType !== "app_mention") {
    return null;
  }

  const event = readSlackConversationEvent(input.payload);
  if (!event) {
    return null;
  }

  const isConversational = deps.isConversationalPersona;
  const readConfig = deps.conversationalConfig;
  if (!isConversational || !readConfig) {
    throw new Error(
      "Slack conversational dispatch requires isConversationalPersona and conversationalConfig dependencies.",
    );
  }

  const conversationalRows = input.matched.filter((row) => isConversational(row.spec));
  if (conversationalRows.length === 0) return null;

  const candidates = conversationalRows.map((row) => conversationalCandidateFromRow(row, readConfig));
  const threadOwner = event.threadTs
    ? await (deps.threadOwnerLookup ?? lookupSlackConversationThreadOwner)({
      workspaceId: input.workspaceId,
      channel: event.channel,
      threadTs: event.threadTs,
    })
    : null;
  const selection = selectConversationalAgent({
    candidates,
    event,
    threadOwner,
  });
  const selectedAgent = selection.kind === "selected"
    ? selection.agent as RoutedConversationalCandidate
    : null;
  const startStream = deps.startStream;
  const enqueueDelivery = deps.enqueueDelivery;
  if (!startStream || !enqueueDelivery) {
    throw new Error(
      "Slack conversational dispatch requires startStream and enqueueDelivery dependencies.",
    );
  }

  if (selection.kind === "none") {
    return null;
  }

  if (selection.kind === "ambiguous") {
    const ack = await startStream({
      workspaceId: input.workspaceId,
      channel: event.channel,
      threadTs: event.threadTs,
      markdownText: `Please specify one of: ${selection.candidates.map((candidate) => candidate.deployedName).join(", ")}`,
    });
    if (!ack.ok) {
      await logWarn("Slack conversational routing disambiguation failed", {
        area: "integration-watch-dispatch",
        diag: "slack-conversation-disambiguation-failed",
        workspaceId: input.workspaceId,
        provider: input.provider,
        eventType: input.eventType,
        deliveryId: input.deliveryId,
        errorCode: ack.errorDetail?.code ?? "unknown",
        errorMessage: ack.errorDetail?.message ?? ack.error ?? "Slack egress call failed.",
      });
      return { matched: input.matched.length, delivered: 0, failed: 1 };
    }
    return { matched: input.matched.length, delivered: 0, failed: 0 };
  }

  const mergeOnGreenTarget = parseMergeOnGreenTarget(event.text);
  const isReviewer = selectedAgent &&
    ((deps.isPullRequestReviewerPersona?.(selectedAgent.row.spec) ?? false) ||
      normalizeAgentName(selectedAgent.deployedName) === "pr-reviewer");
  if (selectedAgent && isReviewer && isMergeOnGreenIntent(event.text) && mergeOnGreenTarget) {
    const applyPullRequestLabel = deps.applyPullRequestLabel;
    if (!applyPullRequestLabel) {
      throw new Error(
        "Slack merge-on-green activation requires applyPullRequestLabel dependency.",
      );
    }
    return handleMergeOnGreenActivation({
      workspaceId: input.workspaceId,
      deliveryId: input.deliveryId,
      matchedCount: input.matched.length,
      event,
      selectedAgent,
      target: mergeOnGreenTarget,
      startStream,
      applyPullRequestLabel,
      logWarn,
    });
  }

  const ack = await startStream({
    workspaceId: input.workspaceId,
    channel: event.channel,
    threadTs: event.threadTs,
    markdownText: `Routing to ${selectedAgent?.deployedName}.`,
    ...(selectedAgent?.identity ? { identity: selectedAgent.identity } : {}),
  });
  if (!ack.ok) {
    await logWarn("Slack conversational routing ack failed", {
      area: "integration-watch-dispatch",
      diag: "slack-conversation-ack-failed",
      workspaceId: input.workspaceId,
      provider: input.provider,
      eventType: input.eventType,
      deliveryId: input.deliveryId,
      agentId: selectedAgent?.row.id,
      errorCode: ack.errorDetail?.code ?? "unknown",
      errorMessage: ack.errorDetail?.message ?? ack.error ?? "Slack egress call failed.",
    });
    return { matched: input.matched.length, delivered: 0, failed: 1 };
  }

  const triggerKey = "triggerKey" in selectedAgent!.row
    ? (selectedAgent!.row as IntegrationWatchAgentRow & { triggerKey?: string | null }).triggerKey ?? null
    : null;
  const queued = await enqueueDelivery({
    workspaceId: input.workspaceId,
    agentId: selectedAgent!.row.id,
    deliveryId: input.deliveryId,
    ...(triggerKey ? { triggerKey } : {}),
    payload: {
      ...input.enqueuePayload,
      slackConversation: selectedSlackConversationMarker({
        event,
        ackTs: ack.ts,
        selectedVia: selection.via,
      }),
    },
  });

  if ((queued === "queued" || queued === "delivered") && (event.threadTs ?? ack.ts)) {
    const threadTs = event.threadTs ?? ack.ts!;
    try {
      await (deps.recordThreadOwner ?? recordSlackConversationThreadOwner)({
        workspaceId: input.workspaceId,
        channel: event.channel,
        threadTs,
        deployedName: selectedAgent!.deployedName,
        agentId: selectedAgent!.row.id,
      });
    } catch (error) {
      await logWarn("Slack conversational thread owner record dispatch failed", {
        area: "integration-watch-dispatch",
        diag: "slack-conversation-thread-owner-record-dispatch-failed",
        workspaceId: input.workspaceId,
        provider: input.provider,
        eventType: input.eventType,
        deliveryId: input.deliveryId,
        channel: event.channel,
        threadTs,
        agentId: selectedAgent!.row.id,
        deployedName: selectedAgent!.deployedName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    matched: input.matched.length,
    delivered: queued === "queued" || queued === "delivered" ? 1 : 0,
    failed: queued === "failed" ? 1 : 0,
  };
}
