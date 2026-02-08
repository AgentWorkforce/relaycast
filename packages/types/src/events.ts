// WebSocket client -> server
export interface SubscribeEvent {
  type: 'subscribe';
  channels: string[];
}

export interface UnsubscribeEvent {
  type: 'unsubscribe';
  channels: string[];
}

export interface PingEvent {
  type: 'ping';
}

export type ClientEvent = SubscribeEvent | UnsubscribeEvent | PingEvent;

// WebSocket server -> client
export interface MessageCreatedEvent {
  type: 'message.created';
  channel: string;
  message: {
    id: string;
    agent_name: string;
    text: string;
    attachments: Array<{
      file_id: string;
      filename: string;
      url: string;
      size: number;
    }>;
  };
}

export interface MessageUpdatedEvent {
  type: 'message.updated';
  channel: string;
  message: { id: string; agent_name: string; text: string };
}

export interface ThreadReplyEvent {
  type: 'thread.reply';
  parent_id: string;
  message: { id: string; agent_name: string; text: string };
}

export interface ReactionAddedEvent {
  type: 'reaction.added';
  message_id: string;
  emoji: string;
  agent_name: string;
}

export interface ReactionRemovedEvent {
  type: 'reaction.removed';
  message_id: string;
  emoji: string;
  agent_name: string;
}

export interface DmReceivedEvent {
  type: 'dm.received';
  conversation_id: string;
  message: { id: string; agent_name: string; text: string };
}

export interface GroupDmReceivedEvent {
  type: 'group_dm.received';
  conversation_id: string;
  message: { id: string; agent_name: string; text: string };
}

export interface AgentOnlineEvent {
  type: 'agent.online';
  agent: { name: string };
}

export interface AgentOfflineEvent {
  type: 'agent.offline';
  agent: { name: string };
}

export interface ChannelCreatedEvent {
  type: 'channel.created';
  channel: { name: string; topic: string | null };
}

export interface ChannelArchivedEvent {
  type: 'channel.archived';
  channel: { name: string };
}

export interface MessageReadEvent {
  type: 'message.read';
  message_id: string;
  agent_name: string;
  read_at: string;
}

export interface FileUploadedEvent {
  type: 'file.uploaded';
  file: { file_id: string; filename: string; uploaded_by: string };
}

export interface PongEvent {
  type: 'pong';
}

export interface WebhookReceivedEvent {
  type: 'webhook.received';
  webhook_id: string;
  channel: string;
  message: { id: string; text: string; source: string | null };
}

export interface CommandInvokedEvent {
  type: 'command.invoked';
  command: string;
  channel: string;
  invoked_by: string;
  args: string | null;
}

export type ServerEvent =
  | MessageCreatedEvent
  | MessageUpdatedEvent
  | ThreadReplyEvent
  | ReactionAddedEvent
  | ReactionRemovedEvent
  | DmReceivedEvent
  | GroupDmReceivedEvent
  | AgentOnlineEvent
  | AgentOfflineEvent
  | ChannelCreatedEvent
  | ChannelArchivedEvent
  | MessageReadEvent
  | FileUploadedEvent
  | WebhookReceivedEvent
  | CommandInvokedEvent
  | PongEvent;

export type ServerEventType = ServerEvent['type'];
export type ClientEventType = ClientEvent['type'];
