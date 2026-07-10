import type {
  BridgeOutcome,
  RelayPoster,
  SlackInboundMessage,
  SlackRelayStore,
} from "./types";

export interface ForwardSlackToRelayDeps {
  store: SlackRelayStore;
  poster: RelayPoster;
}

function formatSlackAuthor(message: SlackInboundMessage): string {
  const name = message.slackUserName?.trim();
  if (name) {
    return name;
  }

  return message.slackUserId ? `slack:${message.slackUserId}` : "slack";
}

export async function forwardSlackToRelay(
  message: SlackInboundMessage,
  deps: ForwardSlackToRelayDeps,
): Promise<BridgeOutcome> {
  const link = await deps.store.findLink(
    message.workspaceId,
    message.slackChannelId,
  );

  if (!link) {
    return { status: "skipped", reason: "no_link" };
  }

  const existing = await deps.store.findMapping({
    linkId: link.id,
    slackTs: message.slackTs,
    direction: "slack_to_relay",
  });
  if (existing) {
    return { status: "skipped", reason: "duplicate" };
  }

  const posted = await deps.poster.post({
    workspaceId: message.workspaceId,
    relayChannelId: link.relayChannelId,
    text: message.text,
    fromName: formatSlackAuthor(message),
    idempotencyKey: `slack:${link.id}:${message.slackTs}`,
  });

  const mapping = await deps.store.recordMapping({
    linkId: link.id,
    slackTs: message.slackTs,
    relayMessageId: posted.messageId,
    direction: "slack_to_relay",
  });

  if (!mapping.inserted) {
    return { status: "skipped", reason: "duplicate" };
  }

  return { status: "posted", relayMessageId: posted.messageId, linkId: link.id };
}
