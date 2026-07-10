import { sql } from "drizzle-orm";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import {
  isSlackConversationRoutingEnabled,
} from "@/lib/integrations/slack-conversation/flag";
import { normalizeSlackChannelId } from "@/lib/integrations/slack-channel-id";
import {
  slackConversationEgress,
  type SlackConversationProgressStreamEgress,
} from "@/lib/integrations/slack-conversation/egress";

const SLACK_TERMINAL_REPLY_MAX_CHARS = 3900;
const SLACK_TERMINAL_REPLY_TRUNCATED_SUFFIX = "... (truncated)";
const SLACK_TERMINAL_REPLY_STALE_POSTING_MINUTES = 10;

type SlackConversationMarker = {
  channel: string;
  threadTs?: string;
  ackTs?: string;
};

type SlackConversationTerminalOutcome =
  | { kind: "completed"; output: string }
  | { kind: "failed"; reason: string };

type SlackConversationTerminalReplyDelivery = {
  agentId: string;
  deliveryId?: string;
};

type SlackConversationTerminalReplyStore = {
  claim: (input: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
  }) => Promise<boolean>;
  markPosted: (input: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
  }) => Promise<void>;
  markFailed: (input: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
    error: string;
  }) => Promise<void>;
};

export async function postSlackConversationTerminalReply(input: {
  workspaceId: string;
  payload: unknown;
  outcome: SlackConversationTerminalOutcome;
  delivery?: SlackConversationTerminalReplyDelivery;
  deps?: {
    egress?: Pick<SlackConversationProgressStreamEgress, "startStream">;
    routingEnabled?: () => boolean;
    store?: SlackConversationTerminalReplyStore;
    // Injectable warn sink (see SlackConversationDispatchDeps.logWarn for why
    // tests must inject rather than mock the logger module).
    logWarn?: (message: string, fields: Record<string, unknown>) => Promise<void> | void;
  };
}): Promise<void> {
  const logWarn = input.deps?.logWarn ??
    ((message: string, fields: Record<string, unknown>) => logger.warn(message, fields));
  // Extract marker first — pure, cannot throw. Early-exit before entering the
  // try/catch so that missing-marker returns don't need channel/threadTs context.
  const marker = slackConversationMarkerFromPayload(input.payload);
  const threadTs = marker?.threadTs ?? marker?.ackTs ?? null;
  if (!marker || !threadTs) {
    return;
  }

  // Everything from here — including the routingEnabled() call — is wrapped in a
  // single try/catch so a future change to the flag helper cannot propagate an
  // exception into the poll/drain path. logTerminalReplyFailure is reachable for
  // any throw because marker and threadTs are already bound above.
  let claimedDelivery: {
    workspaceId: string;
    agentId: string;
    deliveryId: string;
  } | null = null;
  let slackPostSucceeded = false;
  try {
    const routingEnabled = input.deps?.routingEnabled ?? isSlackConversationRoutingEnabled;
    if (!routingEnabled()) {
      return;
    }

    const delivery = slackConversationTerminalReplyDeliveryFromInput(input);
    const store = input.deps?.store ?? slackConversationTerminalReplyStore;
    if (delivery) {
      const claimed = await store.claim(delivery);
      if (!claimed) {
        return;
      }
      claimedDelivery = delivery;
    }

    const egress = input.deps?.egress ?? slackConversationEgress;
    const markdownText = input.outcome.kind === "completed"
      ? buildCompletedMessage(input.outcome.output)
      : buildFailureMessage(input.outcome.reason);

    const result = await egress.startStream({
      workspaceId: input.workspaceId,
      channel: marker.channel,
      threadTs,
      markdownText,
    });
    if (!result.ok) {
      if (claimedDelivery) {
        await store.markFailed({
          ...claimedDelivery,
          error: result.errorDetail?.message ?? result.error ?? "Slack egress call failed.",
        });
      }
      await logTerminalReplyFailure({
        logWarn,
        workspaceId: input.workspaceId,
        channel: marker.channel,
        threadTs,
        error: result.errorDetail?.message ?? result.error ?? "Slack egress call failed.",
        ...(result.errorDetail?.code ? { errorCode: result.errorDetail.code } : {}),
      });
      return;
    }

    slackPostSucceeded = true;
    if (claimedDelivery) {
      await store.markPosted(claimedDelivery);
    }
  } catch (error) {
    if (claimedDelivery && !slackPostSucceeded) {
      await (input.deps?.store ?? slackConversationTerminalReplyStore).markFailed({
        ...claimedDelivery,
        error: error instanceof Error ? error.message : String(error),
      }).catch(async (markError) => {
        await logWarn("Slack conversation terminal reply failed to mark retryable", {
          area: "integration-watch-dispatch",
          diag: "slack-conversation-terminal-reply-mark-failed-failed",
          workspaceId: input.workspaceId,
          channel: marker.channel,
          threadTs,
          deliveryId: claimedDelivery?.deliveryId,
          error: markError instanceof Error ? markError.message : String(markError),
        });
      });
    }
    await logTerminalReplyFailure({
      logWarn,
      workspaceId: input.workspaceId,
      channel: marker.channel,
      threadTs,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const candidate = result as { rows?: T[] };
  return Array.isArray(candidate?.rows) ? candidate.rows : [];
}

function slackConversationMarkerFromPayload(payload: unknown): SlackConversationMarker | null {
  if (!isRecord(payload)) {
    return null;
  }

  const marker = isRecord(payload.slackConversation) ? payload.slackConversation : null;
  const channel = readString(marker?.channel);
  if (!channel) {
    return null;
  }

  const threadTs = readString(marker?.threadTs);
  const ackTs = readString(marker?.ackTs);
  return {
    channel: normalizeSlackChannelId(channel),
    ...(threadTs ? { threadTs } : {}),
    ...(ackTs ? { ackTs } : {}),
  };
}

function slackConversationTerminalReplyDeliveryFromInput(input: {
  workspaceId: string;
  payload: unknown;
  delivery?: SlackConversationTerminalReplyDelivery;
}): { workspaceId: string; agentId: string; deliveryId: string } | null {
  const agentId = readString(input.delivery?.agentId);
  if (!agentId) {
    return null;
  }

  const payload = isRecord(input.payload) ? input.payload : null;
  const deliveryId = readString(input.delivery?.deliveryId, payload?.deliveryId, payload?.id);
  if (!deliveryId) {
    return null;
  }

  return {
    workspaceId: input.workspaceId,
    agentId,
    deliveryId,
  };
}

function buildCompletedMessage(output: string): string {
  const normalized = output.replace(/\r\n/g, "\n").trim();
  if (countCodePoints(normalized) === 0) {
    return "Run completed with no output.";
  }
  return truncateSlackTerminalReply(normalized);
}

function buildFailureMessage(reason: string): string {
  switch (reason) {
    case "timeout":
      return "Run failed (timeout).";
    case "sandbox_terminal":
      return "Run failed (sandbox terminal).";
    default:
      return "Run failed (error).";
  }
}

function truncateSlackTerminalReply(text: string): string {
  if (countCodePoints(text) <= SLACK_TERMINAL_REPLY_MAX_CHARS) {
    return text;
  }

  const maxBodyChars = SLACK_TERMINAL_REPLY_MAX_CHARS -
    countCodePoints(SLACK_TERMINAL_REPLY_TRUNCATED_SUFFIX);
  const lines = text.split("\n");
  const kept: string[] = [];
  let keptChars = 0;

  for (const line of lines) {
    const lineChars = countCodePoints(line);
    const candidateChars = kept.length === 0 ? lineChars : keptChars + 1 + lineChars;
    if (candidateChars > maxBodyChars) {
      break;
    }
    kept.push(line);
    keptChars = candidateChars;
  }

  if (kept.length > 0) {
    return `${kept.join("\n")}${SLACK_TERMINAL_REPLY_TRUNCATED_SUFFIX}`;
  }

  return `${sliceCodePoints(text, maxBodyChars)}${SLACK_TERMINAL_REPLY_TRUNCATED_SUFFIX}`;
}

function countCodePoints(text: string): number {
  return Array.from(text).length;
}

function sliceCodePoints(text: string, length: number): string {
  return Array.from(text).slice(0, length).join("");
}

async function logTerminalReplyFailure(input: {
  workspaceId: string;
  channel: string;
  threadTs: string;
  error: string;
  errorCode?: string;
  logWarn: (message: string, fields: Record<string, unknown>) => Promise<void> | void;
}): Promise<void> {
  await input.logWarn("Slack conversation terminal reply failed", {
    area: "integration-watch-dispatch",
    diag: "slack-conversation-terminal-reply-failed",
    workspaceId: input.workspaceId,
    channel: input.channel,
    threadTs: input.threadTs,
    error: input.error,
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
}

const slackConversationTerminalReplyStore: SlackConversationTerminalReplyStore = {
  async claim(input) {
    const result = await getDb().execute(sql`
      UPDATE integration_watch_deliveries
      SET slack_terminal_reply_status = 'posting',
          slack_terminal_reply_error = NULL,
          updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND agent_id = ${input.agentId}
        AND delivery_id = ${input.deliveryId}
        AND (
          slack_terminal_reply_status IS NULL
          OR slack_terminal_reply_status = 'failed'
          OR (
            slack_terminal_reply_status = 'posting'
            AND updated_at < NOW() - (${SLACK_TERMINAL_REPLY_STALE_POSTING_MINUTES}::text || ' minutes')::interval
          )
        )
      RETURNING id
    `);
    return rowsOf(result).length > 0;
  },
  async markPosted(input) {
    await getDb().execute(sql`
      UPDATE integration_watch_deliveries
      SET slack_terminal_reply_status = 'posted',
          slack_terminal_reply_posted_at = NOW(),
          slack_terminal_reply_error = NULL,
          updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND agent_id = ${input.agentId}
        AND delivery_id = ${input.deliveryId}
        AND slack_terminal_reply_status = 'posting'
    `);
  },
  async markFailed(input) {
    await getDb().execute(sql`
      UPDATE integration_watch_deliveries
      SET slack_terminal_reply_status = 'failed',
          slack_terminal_reply_error = ${input.error.slice(0, 4000)},
          updated_at = NOW()
      WHERE workspace_id = ${input.workspaceId}
        AND agent_id = ${input.agentId}
        AND delivery_id = ${input.deliveryId}
        AND slack_terminal_reply_status = 'posting'
    `);
  },
};
