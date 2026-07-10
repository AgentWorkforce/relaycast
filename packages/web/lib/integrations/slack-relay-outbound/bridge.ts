import { isSlackRelayBridgeOutboundEnabled } from "@/lib/integrations/nango-service";
import { rickySlackEgress } from "@/lib/ricky/slack/egress";

export type RelaycastOutboundEventType =
  | "message.created"
  | "message.updated"
  | "message.deleted"
  | "stream.started"
  | "stream.appended"
  | "stream.stopped";

export interface RelaycastOutboundEvent {
  type: RelaycastOutboundEventType;
  workspaceId: string;
  relayChannelId: string;
  messageId: string;
  text?: string;
  markdownText?: string;
  authorName?: string;
}

export interface SlackRelayOutboundLink {
  id: string;
  workspaceId: string;
  slackChannelId: string;
  relayChannelId: string;
}

export interface SlackRelayOutboundMapping {
  linkId: string;
  slackTs: string;
  relayMessageId: string;
  direction: "relay_to_slack";
}

export interface SlackRelayOutboundStore {
  findLinkByRelayChannel(input: {
    workspaceId: string;
    relayChannelId: string;
  }): Promise<SlackRelayOutboundLink | null>;
  findMappingByRelayMessage(input: {
    linkId: string;
    relayMessageId: string;
    direction: "relay_to_slack";
  }): Promise<SlackRelayOutboundMapping | null>;
  recordMapping(input: {
    linkId: string;
    slackTs: string;
    relayMessageId: string;
    direction: "relay_to_slack";
  }): Promise<{ inserted: boolean }>;
}

export interface SlackRelayOutboundEgress {
  postMessage(input: {
    workspaceId: string;
    channel: string;
    text: string;
    unfurlLinks?: boolean;
  }): Promise<{ ok: boolean; ts?: string; error?: string }>;
  updateMessage(input: {
    workspaceId: string;
    channel: string;
    ts: string;
    text: string;
  }): Promise<{ ok: boolean; error?: string }>;
  deleteMessage(input: {
    workspaceId: string;
    channel: string;
    ts: string;
  }): Promise<{ ok: boolean; error?: string }>;
  startStream(input: {
    workspaceId: string;
    channel: string;
    threadTs?: string;
    markdownText?: string;
  }): Promise<{ ok: boolean; ts?: string; error?: string }>;
  appendStream(input: {
    workspaceId: string;
    channel: string;
    ts: string;
    markdownText: string;
  }): Promise<{ ok: boolean; error?: string }>;
  stopStream(input: {
    workspaceId: string;
    channel: string;
    ts: string;
    markdownText?: string;
  }): Promise<{ ok: boolean; error?: string }>;
}

export type SlackRelayOutboundOutcome =
  | { status: "disabled" }
  | { status: "skipped"; reason: "no_link" | "duplicate" | "missing_mapping" | "empty_text" }
  | { status: "posted"; slackTs: string; linkId: string }
  | { status: "updated"; slackTs: string; linkId: string }
  | { status: "deleted"; slackTs: string; linkId: string }
  | { status: "stream_started"; slackTs: string; linkId: string }
  | { status: "stream_appended"; slackTs: string; linkId: string }
  | { status: "stream_stopped"; slackTs: string; linkId: string }
  | { status: "error"; error: string };

export interface SlackRelayOutboundDeps {
  store: SlackRelayOutboundStore;
  egress?: SlackRelayOutboundEgress;
  isEnabled?: () => boolean;
}

function getText(event: RelaycastOutboundEvent): string {
  return (event.markdownText ?? event.text ?? "").trim();
}

function formatPostText(event: RelaycastOutboundEvent): string {
  const text = getText(event);
  const author = event.authorName?.trim();
  return author ? `*${author}:* ${text}` : text;
}

export async function handleSlackRelayOutboundEvent(
  event: RelaycastOutboundEvent,
  deps: SlackRelayOutboundDeps,
): Promise<SlackRelayOutboundOutcome> {
  if (!(deps.isEnabled ?? isSlackRelayBridgeOutboundEnabled)()) {
    return { status: "disabled" };
  }

  const link = await deps.store.findLinkByRelayChannel({
    workspaceId: event.workspaceId,
    relayChannelId: event.relayChannelId,
  });
  if (!link) {
    return { status: "skipped", reason: "no_link" };
  }

  const egress = deps.egress ?? rickySlackEgress;
  if (event.type === "message.created") {
    const text = formatPostText(event);
    if (!text) {
      return { status: "skipped", reason: "empty_text" };
    }

    const existing = await deps.store.findMappingByRelayMessage({
      linkId: link.id,
      relayMessageId: event.messageId,
      direction: "relay_to_slack",
    });
    if (existing) {
      return { status: "skipped", reason: "duplicate" };
    }

    const posted = await egress.postMessage({
      workspaceId: event.workspaceId,
      channel: link.slackChannelId,
      text,
      unfurlLinks: false,
    });
    if (!posted.ok || !posted.ts) {
      return { status: "error", error: posted.error ?? "Slack postMessage did not return ts" };
    }

    const mapping = await deps.store.recordMapping({
      linkId: link.id,
      slackTs: posted.ts,
      relayMessageId: event.messageId,
      direction: "relay_to_slack",
    });
    if (!mapping.inserted) {
      return { status: "skipped", reason: "duplicate" };
    }

    return { status: "posted", slackTs: posted.ts, linkId: link.id };
  }

  if (event.type === "stream.started") {
    const text = getText(event);
    if (!text) {
      return { status: "skipped", reason: "empty_text" };
    }

    const stream = await egress.startStream({
      workspaceId: event.workspaceId,
      channel: link.slackChannelId,
      markdownText: text,
    });
    if (!stream.ok || !stream.ts) {
      return { status: "error", error: stream.error ?? "Slack startStream did not return ts" };
    }

    await deps.store.recordMapping({
      linkId: link.id,
      slackTs: stream.ts,
      relayMessageId: event.messageId,
      direction: "relay_to_slack",
    });

    return { status: "stream_started", slackTs: stream.ts, linkId: link.id };
  }

  const mapping = await deps.store.findMappingByRelayMessage({
    linkId: link.id,
    relayMessageId: event.messageId,
    direction: "relay_to_slack",
  });
  if (!mapping) {
    return { status: "skipped", reason: "missing_mapping" };
  }

  if (event.type === "message.updated") {
    const text = formatPostText(event);
    if (!text) {
      return { status: "skipped", reason: "empty_text" };
    }
    const updated = await egress.updateMessage({
      workspaceId: event.workspaceId,
      channel: link.slackChannelId,
      ts: mapping.slackTs,
      text,
    });
    return updated.ok
      ? { status: "updated", slackTs: mapping.slackTs, linkId: link.id }
      : { status: "error", error: updated.error ?? "Slack update failed" };
  }

  if (event.type === "message.deleted") {
    const deleted = await egress.deleteMessage({
      workspaceId: event.workspaceId,
      channel: link.slackChannelId,
      ts: mapping.slackTs,
    });
    return deleted.ok
      ? { status: "deleted", slackTs: mapping.slackTs, linkId: link.id }
      : { status: "error", error: deleted.error ?? "Slack delete failed" };
  }

  if (event.type === "stream.appended") {
    const text = getText(event);
    if (!text) {
      return { status: "skipped", reason: "empty_text" };
    }
    const appended = await egress.appendStream({
      workspaceId: event.workspaceId,
      channel: link.slackChannelId,
      ts: mapping.slackTs,
      markdownText: text,
    });
    return appended.ok
      ? { status: "stream_appended", slackTs: mapping.slackTs, linkId: link.id }
      : { status: "error", error: appended.error ?? "Slack appendStream failed" };
  }

  const stopped = await egress.stopStream({
    workspaceId: event.workspaceId,
    channel: link.slackChannelId,
    ts: mapping.slackTs,
    markdownText: getText(event) || undefined,
  });
  return stopped.ok
    ? { status: "stream_stopped", slackTs: mapping.slackTs, linkId: link.id }
    : { status: "error", error: stopped.error ?? "Slack stopStream failed" };
}
