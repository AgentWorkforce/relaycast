export type SlackRelayDirection = "slack_to_relay" | "relay_to_slack";

export interface SlackInboundMessage {
  workspaceId: string;
  slackChannelId: string;
  slackTs: string;
  text: string;
  slackUserId?: string;
  slackUserName?: string;
}

export interface SlackRelayLink {
  id: string;
  workspaceId: string;
  slackChannelId: string;
  relayChannelId: string;
}

export interface RelayPostInput {
  workspaceId: string;
  relayChannelId: string;
  text: string;
  fromName?: string;
  idempotencyKey?: string;
}

export interface RelayPostResult {
  messageId: string;
}

export interface SlackRelayStore {
  findLink(
    workspaceId: string,
    slackChannelId: string,
  ): Promise<SlackRelayLink | null>;

  findMapping(input: {
    linkId: string;
    slackTs: string;
    direction: SlackRelayDirection;
  }): Promise<{ relayMessageId: string } | null>;

  recordMapping(input: {
    linkId: string;
    slackTs: string;
    relayMessageId: string;
    direction: SlackRelayDirection;
  }): Promise<{ inserted: boolean }>;
}

export interface RelayPoster {
  post(input: RelayPostInput): Promise<RelayPostResult>;
}

export type BridgeOutcome =
  | { status: "skipped"; reason: "no_link" | "duplicate" }
  | { status: "posted"; relayMessageId: string; linkId: string };
