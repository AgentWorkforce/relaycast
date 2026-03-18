import { z } from 'zod';
import { CoreMessagePayloadSchema } from './message.js';
import { FileAttachmentSchema } from './file.js';

// WebSocket client -> server
export const SubscribeEventSchema = z.object({
  type: z.literal('subscribe'),
  channels: z.array(z.string()),
});
export type SubscribeEvent = z.infer<typeof SubscribeEventSchema>;

export const UnsubscribeEventSchema = z.object({
  type: z.literal('unsubscribe'),
  channels: z.array(z.string()),
});
export type UnsubscribeEvent = z.infer<typeof UnsubscribeEventSchema>;

export const PingEventSchema = z.object({
  type: z.literal('ping'),
});
export type PingEvent = z.infer<typeof PingEventSchema>;

export const ClientEventSchema = z.discriminatedUnion('type', [
  SubscribeEventSchema,
  UnsubscribeEventSchema,
  PingEventSchema,
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

// WebSocket server -> client
export const ChannelMessagePayloadSchema = CoreMessagePayloadSchema.extend({
  attachments: z.array(FileAttachmentSchema),
});
export type ChannelMessagePayload = z.infer<typeof ChannelMessagePayloadSchema>;

export const MessageCreatedEventSchema = z.object({
  type: z.literal('message.created'),
  channel: z.string(),
  message: ChannelMessagePayloadSchema,
});
export type MessageCreatedEvent = z.infer<typeof MessageCreatedEventSchema>;

export const MessageUpdatedEventSchema = z.object({
  type: z.literal('message.updated'),
  channel: z.string(),
  message: CoreMessagePayloadSchema,
});
export type MessageUpdatedEvent = z.infer<typeof MessageUpdatedEventSchema>;

export const ThreadReplyEventSchema = z.object({
  type: z.literal('thread.reply'),
  channel: z.string(),
  parent_id: z.string(),
  message: CoreMessagePayloadSchema,
});
export type ThreadReplyEvent = z.infer<typeof ThreadReplyEventSchema>;

export const ReactionAddedEventSchema = z.object({
  type: z.literal('reaction.added'),
  message_id: z.string(),
  emoji: z.string(),
  agent_name: z.string(),
});
export type ReactionAddedEvent = z.infer<typeof ReactionAddedEventSchema>;

export const ReactionRemovedEventSchema = z.object({
  type: z.literal('reaction.removed'),
  message_id: z.string(),
  emoji: z.string(),
  agent_name: z.string(),
});
export type ReactionRemovedEvent = z.infer<typeof ReactionRemovedEventSchema>;

export const DmReceivedEventSchema = z.object({
  type: z.literal('dm.received'),
  conversation_id: z.string(),
  message: CoreMessagePayloadSchema,
});
export type DmReceivedEvent = z.infer<typeof DmReceivedEventSchema>;

export const GroupDmReceivedEventSchema = z.object({
  type: z.literal('group_dm.received'),
  conversation_id: z.string(),
  message: CoreMessagePayloadSchema,
});
export type GroupDmReceivedEvent = z.infer<typeof GroupDmReceivedEventSchema>;

export const AgentOnlineEventSchema = z.object({
  type: z.literal('agent.online'),
  agent: z.object({ name: z.string() }),
});
export type AgentOnlineEvent = z.infer<typeof AgentOnlineEventSchema>;

export const AgentOfflineEventSchema = z.object({
  type: z.literal('agent.offline'),
  agent: z.object({ name: z.string() }),
});
export type AgentOfflineEvent = z.infer<typeof AgentOfflineEventSchema>;

export const AgentSpawnRequestedEventSchema = z.object({
  type: z.literal('agent.spawn_requested'),
  agent: z.object({
    name: z.string(),
    cli: z.string(),
    task: z.string(),
    channel: z.string().nullable(),
    already_existed: z.boolean(),
  }),
});
export type AgentSpawnRequestedEvent = z.infer<typeof AgentSpawnRequestedEventSchema>;

export const AgentReleaseRequestedEventSchema = z.object({
  type: z.literal('agent.release_requested'),
  agent: z.object({ name: z.string() }),
  reason: z.string().nullable(),
  deleted: z.boolean(),
});
export type AgentReleaseRequestedEvent = z.infer<typeof AgentReleaseRequestedEventSchema>;

export const ChannelCreatedEventSchema = z.object({
  type: z.literal('channel.created'),
  channel: z.object({ name: z.string(), topic: z.string().nullable() }),
});
export type ChannelCreatedEvent = z.infer<typeof ChannelCreatedEventSchema>;

export const ChannelUpdatedEventSchema = z.object({
  type: z.literal('channel.updated'),
  channel: z.object({ name: z.string(), topic: z.string().nullable() }),
});
export type ChannelUpdatedEvent = z.infer<typeof ChannelUpdatedEventSchema>;

export const ChannelArchivedEventSchema = z.object({
  type: z.literal('channel.archived'),
  channel: z.object({ name: z.string() }),
});
export type ChannelArchivedEvent = z.infer<typeof ChannelArchivedEventSchema>;

export const MemberJoinedEventSchema = z.object({
  type: z.literal('member.joined'),
  channel: z.string(),
  agent_name: z.string(),
});
export type MemberJoinedEvent = z.infer<typeof MemberJoinedEventSchema>;

export const MemberLeftEventSchema = z.object({
  type: z.literal('member.left'),
  channel: z.string(),
  agent_name: z.string(),
});
export type MemberLeftEvent = z.infer<typeof MemberLeftEventSchema>;

export const MessageReadEventSchema = z.object({
  type: z.literal('message.read'),
  message_id: z.string(),
  agent_name: z.string(),
  read_at: z.string(),
});
export type MessageReadEvent = z.infer<typeof MessageReadEventSchema>;

export const FileUploadedEventSchema = z.object({
  type: z.literal('file.uploaded'),
  file: z.object({ file_id: z.string(), filename: z.string(), uploaded_by: z.string() }),
});
export type FileUploadedEvent = z.infer<typeof FileUploadedEventSchema>;

export const PongEventSchema = z.object({
  type: z.literal('pong'),
});
export type PongEvent = z.infer<typeof PongEventSchema>;

export const WebhookReceivedEventSchema = z.object({
  type: z.literal('webhook.received'),
  webhook_id: z.string(),
  channel: z.string(),
  message: z.object({ id: z.string(), text: z.string(), source: z.string().nullable() }),
});
export type WebhookReceivedEvent = z.infer<typeof WebhookReceivedEventSchema>;

export const CommandInvokedEventSchema = z.object({
  type: z.literal('command.invoked'),
  command: z.string(),
  channel: z.string(),
  invoked_by: z.string(),
  handler_agent_id: z.string(),
  args: z.string().nullable(),
  parameters: z.record(z.string(), z.unknown()).nullable(),
});
export type CommandInvokedEvent = z.infer<typeof CommandInvokedEventSchema>;

// WebSocket client events (emitted by WsClient, not from server)
export const WsOpenEventSchema = z.object({
  type: z.literal('open'),
});
export type WsOpenEvent = z.infer<typeof WsOpenEventSchema>;

export const WsErrorEventSchema = z.object({
  type: z.literal('error'),
});
export type WsErrorEvent = z.infer<typeof WsErrorEventSchema>;

export const WsReconnectingEventSchema = z.object({
  type: z.literal('reconnecting'),
  attempt: z.number(),
});
export type WsReconnectingEvent = z.infer<typeof WsReconnectingEventSchema>;

export const WsPermanentlyDisconnectedEventSchema = z.object({
  type: z.literal('permanently_disconnected'),
  attempt: z.number(),
});
export type WsPermanentlyDisconnectedEvent = z.infer<typeof WsPermanentlyDisconnectedEventSchema>;

export const WsCloseEventSchema = z.object({
  type: z.literal('close'),
});
export type WsCloseEvent = z.infer<typeof WsCloseEventSchema>;

export const ServerEventSchema = z.discriminatedUnion('type', [
  MessageCreatedEventSchema,
  MessageUpdatedEventSchema,
  ThreadReplyEventSchema,
  ReactionAddedEventSchema,
  ReactionRemovedEventSchema,
  DmReceivedEventSchema,
  GroupDmReceivedEventSchema,
  AgentOnlineEventSchema,
  AgentOfflineEventSchema,
  AgentSpawnRequestedEventSchema,
  AgentReleaseRequestedEventSchema,
  ChannelCreatedEventSchema,
  ChannelUpdatedEventSchema,
  ChannelArchivedEventSchema,
  MemberJoinedEventSchema,
  MemberLeftEventSchema,
  MessageReadEventSchema,
  FileUploadedEventSchema,
  WebhookReceivedEventSchema,
  CommandInvokedEventSchema,
  PongEventSchema,
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];
export type ClientEventType = ClientEvent['type'];

// Union of all events that WsClient can emit (includes server events + client-only events)
export const WsClientEventSchema = z.discriminatedUnion('type', [
  // Server events
  MessageCreatedEventSchema,
  MessageUpdatedEventSchema,
  ThreadReplyEventSchema,
  ReactionAddedEventSchema,
  ReactionRemovedEventSchema,
  DmReceivedEventSchema,
  GroupDmReceivedEventSchema,
  AgentOnlineEventSchema,
  AgentOfflineEventSchema,
  AgentSpawnRequestedEventSchema,
  AgentReleaseRequestedEventSchema,
  ChannelCreatedEventSchema,
  ChannelUpdatedEventSchema,
  ChannelArchivedEventSchema,
  MemberJoinedEventSchema,
  MemberLeftEventSchema,
  MessageReadEventSchema,
  FileUploadedEventSchema,
  WebhookReceivedEventSchema,
  CommandInvokedEventSchema,
  PongEventSchema,
  // Client-only events
  WsOpenEventSchema,
  WsErrorEventSchema,
  WsReconnectingEventSchema,
  WsPermanentlyDisconnectedEventSchema,
  WsCloseEventSchema,
]);
export type WsClientEvent = z.infer<typeof WsClientEventSchema>;
export type WsClientEventType = WsClientEvent['type'];
