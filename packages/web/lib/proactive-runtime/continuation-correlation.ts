import { normalizeSlackChannelId } from "@/lib/integrations/slack-channel-id";

export type SlackUserReplyParts = {
  channel: string;
  thread: string;
  user: string;
};

export function slackUserReplyCorrelationKey(
  parts: SlackUserReplyParts,
): string {
  return `slack:channel:${normalizeSlackChannelId(parts.channel)}:thread:${parts.thread}:user:${parts.user}`;
}

export function slackUserReplyCorrelationKeyFromPayload(
  payload: unknown,
): string | null {
  const parts = slackUserReplyPartsFromPayload(payload);
  return parts ? slackUserReplyCorrelationKey(parts) : null;
}

export function slackUserReplyPartsFromPayload(
  payload: unknown,
): SlackUserReplyParts | null {
  if (!isRecord(payload)) return null;
  const resource = isRecord(payload.resource) ? payload.resource : payload;
  const message = isRecord(resource.message) ? resource.message : null;
  const source = message ?? resource;
  const channel = firstNonEmptyString(
    source.channel,
    source.channel_id,
    source.channelId,
    resource.channel,
    resource.channel_id,
    resource.channelId,
  );
  const thread = firstNonEmptyString(
    source.thread_ts,
    source.threadTs,
    source.thread,
    source.ts,
    resource.thread_ts,
    resource.threadTs,
    resource.thread,
    resource.ts,
  );
  const user = firstNonEmptyString(
    source.user,
    source.user_id,
    source.userId,
    resource.user,
    resource.user_id,
    resource.userId,
  );
  if (!channel || !thread || !user) {
    return null;
  }
  return { channel: normalizeSlackChannelId(channel), thread, user };
}

export function parseSlackReplyMessagePath(path: string): {
  channel: string;
  thread: string;
  replyTs: string;
} | null {
  const trimmed = path.trim();
  const match = trimmed.match(
    /^\/slack\/channels\/([^/]+)\/messages\/([^/]+)\/replies\/([^/]+)\.json$/u,
  );
  if (!match) {
    return null;
  }
  try {
    return {
      channel: normalizeSlackChannelId(decodeURIComponent(match[1])),
      thread: decodeURIComponent(match[2]),
      replyTs: decodeURIComponent(match[3]),
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}
