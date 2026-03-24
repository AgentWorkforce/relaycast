import type * as Raw from '@relaycast/types';
import type { Camelize } from './casing.js';

export interface A2aAgentCardSkill {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
}

export interface A2aAgentCard {
  name: string;
  description?: string;
  url: string;
  version: string;
  skills: A2aAgentCardSkill[];
  provider?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  documentationUrl?: string;
}

export interface RegisterA2aOptions {
  agentCardUrl?: string;
  agentCard?: A2aAgentCard;
  authScheme?: string;
  authCredential?: string;
}

export interface RegisterA2aResponse {
  relayName: string;
  relayToken: string;
  webhookUrl: string;
  certification: 'level_0' | 'level_1';
}

export interface A2aAgentRecord {
  id: string;
  workspaceId: string;
  relayAgentId: string;
  relayName: string;
  relayStatus: string;
  relayPersona: string | null;
  relayMetadata: Record<string, unknown> | null;
  agentCard: A2aAgentCard;
  externalUrl: string;
  authScheme: string | null;
  authCredential: string | null;
  status: string;
  messagesSent: number;
  messagesRecv: number;
  lastHealth: string | null;
  healthFailures: number;
  createdAt: string;
  updatedAt: string;
}

export interface RemoveA2aAgentResponse {
  name: string;
  removed: true;
}

export interface DirectorySkillInput {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface DirectorySkill {
  id: string;
  skillId: string | null;
  name: string;
  description: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface DirectoryAgent {
  id: string;
  sourceAgentId: string | null;
  slug: string;
  name: string;
  description: string | null;
  provider: string | null;
  endpointUrl: string | null;
  documentationUrl: string | null;
  version: string | null;
  tags: string[];
  capabilities: Record<string, unknown>;
  metadata: Record<string, unknown>;
  status: string;
  ratingAvg: number;
  ratingCount: number;
  skills: DirectorySkill[];
  createdAt: string;
  updatedAt: string;
}

export interface SearchDirectoryQuery {
  q?: string;
  tags?: string[];
  status?: string;
  limit?: number;
}

export interface DirectorySearchResult extends DirectoryAgent {
  relevanceScore: number;
}

export interface PublishToDirectoryRequest {
  sourceAgentName?: string;
  slug?: string;
  name: string;
  description?: string;
  provider?: string;
  endpointUrl?: string;
  documentationUrl?: string;
  version?: string;
  tags?: string[];
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: string;
  skills?: DirectorySkillInput[];
}

export interface ImportSkillsRequest {
  agentName: string;
  metadata?: Record<string, unknown>;
  status?: string;
  skills?: DirectorySkillInput[];
}

export interface RouteResult {
  agentName: string;
  score: number;
  fallback: boolean;
}

export interface RoutingWeights {
  skillMatch: number;
  messageMatch: number;
  tagMatch: number;
  rating: number;
  availability: number;
}

export interface RoutingConfig {
  weights: RoutingWeights;
  circuitBreakerThreshold: number;
  circuitBreakerCooldownSeconds: number;
  updatedAt: string | null;
}

export interface UpdateRoutingConfigRequest {
  weights?: Partial<RoutingWeights>;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownSeconds?: number;
}

export type ActivityItem = Camelize<Raw.ActivityItem>;
export type Agent = Camelize<Raw.Agent>;
export type AgentCommand = Camelize<Raw.AgentCommand>;
export type AgentListQuery = Camelize<Raw.AgentListQuery>;
export type AgentOfflineEvent = Camelize<Raw.AgentOfflineEvent>;
export type AgentOnlineEvent = Camelize<Raw.AgentOnlineEvent>;
export type AgentPresenceInfo = Camelize<Raw.AgentPresenceInfo>;
export type Channel = Camelize<Raw.Channel>;
export type ChannelArchivedEvent = Camelize<Raw.ChannelArchivedEvent>;
export type ChannelCreatedEvent = Camelize<Raw.ChannelCreatedEvent>;
export type ChannelMemberInfo = Camelize<Raw.ChannelMemberInfo>;
export type JoinChannelResponse = Camelize<Raw.JoinChannelResponse>;
export type InviteChannelResponse = Camelize<Raw.InviteChannelResponse>;
export type ChannelReadStatus = Camelize<Raw.ChannelReadStatus>;
export type ChannelUpdatedEvent = Camelize<Raw.ChannelUpdatedEvent>;
export type CommandInvocation = Camelize<Raw.CommandInvocation>;
export type CommandInvokeResult = CommandInvocation;
export type CommandInvokedEvent = Camelize<Raw.CommandInvokedEvent>;
export type CreateAgentRequest = Camelize<Raw.CreateAgentRequest>;
export type CreateAgentResponse = Camelize<Raw.CreateAgentResponse>;
export type CreateChannelRequest = Camelize<Raw.CreateChannelRequest>;
export type CreateCommandRequest = Camelize<Raw.CreateCommandRequest>;
export type CreateCommandResponse = Camelize<Raw.CreateCommandResponse>;
export type CreateGroupDmRequest = Camelize<Raw.CreateGroupDmRequest>;
export type DmConversation = Camelize<Raw.DmConversation>;
export type CreateGroupDmResponse = Camelize<Raw.CreateGroupDmResponse>;
export type CreateSubscriptionRequest = Camelize<Raw.CreateSubscriptionRequest>;
export type CreateSubscriptionResponse = Camelize<Raw.CreateSubscriptionResponse>;
export type CreateWebhookRequest = Camelize<Raw.CreateWebhookRequest>;
export type CreateWebhookResponse = Camelize<Raw.CreateWebhookResponse>;
export type CreateWorkspaceResponse = Camelize<Raw.CreateWorkspaceResponse>;
export type WorkspaceLookup = Camelize<Raw.WorkspaceLookup>;
export type SendDmResponse = Camelize<Raw.SendDmResponse>;
export type DmMessage = Camelize<Raw.DmMessage>;
export type DmConversationSummary = Camelize<Raw.DmConversationSummary>;
export type DmConversationParticipant = Camelize<Raw.DmConversationParticipant>;
export type DmLastMessage = Camelize<Raw.DmLastMessage>;
export type DmReceivedEvent = Camelize<Raw.DmReceivedEvent>;
export type EventSubscription = Camelize<Raw.EventSubscription>;
export type FileInfo = Camelize<Raw.FileInfo>;
export type CompleteUploadResponse = Camelize<Raw.CompleteUploadResponse>;
export type FileUploadedEvent = Camelize<Raw.FileUploadedEvent>;
export type GroupDmMessageResponse = Camelize<Raw.GroupDmMessageResponse>;
export type GroupDmParticipantResponse = Camelize<Raw.GroupDmParticipantResponse>;
export type GroupDmReceivedEvent = Camelize<Raw.GroupDmReceivedEvent>;
export type InboxResponse = Camelize<Raw.InboxResponse>;
export type InvokeCommandRequest = Camelize<Raw.InvokeCommandRequest>;
export type MemberJoinedEvent = Camelize<Raw.MemberJoinedEvent>;
export type MemberLeftEvent = Camelize<Raw.MemberLeftEvent>;
export type ChannelMutedEvent = Camelize<Raw.ChannelMutedEvent>;
export type ChannelUnmutedEvent = Camelize<Raw.ChannelUnmutedEvent>;
export type MuteChannelResponse = Camelize<Raw.MuteChannelResponse>;
export type MessageBlock = Camelize<Raw.MessageBlock>;
export type MessageCreatedEvent = Camelize<Raw.MessageCreatedEvent>;
export type MessageListQuery = Camelize<Raw.MessageListQuery>;
export type MessageReadEvent = Camelize<Raw.MessageReadEvent>;
export type SearchMessageResult = Camelize<Raw.SearchMessageResult>;
export type MessageUpdatedEvent = Camelize<Raw.MessageUpdatedEvent>;
export type MessageWithMeta = Camelize<Raw.MessageWithMeta>;
export type PostMessageRequest = Camelize<Raw.PostMessageRequest>;
export type AddedReaction = Camelize<Raw.AddedReaction>;
export type ReactionAddedEvent = Camelize<Raw.ReactionAddedEvent>;
export type ReactionGroup = Camelize<Raw.ReactionGroup>;
export type ReactionRemovedEvent = Camelize<Raw.ReactionRemovedEvent>;
export type ReadReceipt = Camelize<Raw.ReadReceipt>;
export type ReaderInfo = Camelize<Raw.ReaderInfo>;
export type ReleaseAgentRequest = Camelize<Raw.ReleaseAgentRequest>;
export type ReleaseAgentResponse = Camelize<Raw.ReleaseAgentResponse>;
export type SendDmRequest = Camelize<Raw.SendDmRequest>;
export type SetSystemPromptRequest = Camelize<Raw.SetSystemPromptRequest>;
export type SpawnAgentRequest = Camelize<Raw.SpawnAgentRequest>;
export type SpawnAgentResponse = Camelize<Raw.SpawnAgentResponse>;
export type SystemPrompt = Camelize<Raw.SystemPrompt>;
export type ThreadReplyEvent = Camelize<Raw.ThreadReplyEvent>;
export type ThreadReplyRequest = Camelize<Raw.ThreadReplyRequest>;
export type TokenRotateResponse = Camelize<Raw.TokenRotateResponse>;
export type UpdateAgentRequest = Camelize<Raw.UpdateAgentRequest>;
export type UpdateChannelRequest = Camelize<Raw.UpdateChannelRequest>;
export type UpdateWorkspaceRequest = Camelize<Raw.UpdateWorkspaceRequest>;
export type UploadRequest = Camelize<Raw.UploadRequest>;
export type UploadResponse = Camelize<Raw.UploadResponse>;
export type Webhook = Camelize<Raw.Webhook>;
export type WebhookReceivedEvent = Camelize<Raw.WebhookReceivedEvent>;
export type WebhookTriggerRequest = Camelize<Raw.WebhookTriggerRequest>;
export type WebhookTriggerResponse = Camelize<Raw.WebhookTriggerResponse>;
export type Workspace = Camelize<Raw.Workspace>;
export type WorkspaceDmConversation = Camelize<Raw.WorkspaceDmConversation>;
export type SearchResult = SearchMessageResult;
export type WsClientEvent = Camelize<Raw.WsClientEvent>;
export type WsCloseEvent = Camelize<Raw.WsCloseEvent>;
export type WsErrorEvent = Camelize<Raw.WsErrorEvent>;
export type WsOpenEvent = Camelize<Raw.WsOpenEvent>;
export type WsPermanentlyDisconnectedEvent = Camelize<Raw.WsPermanentlyDisconnectedEvent>;
export type WsReconnectingEvent = Camelize<Raw.WsReconnectingEvent>;
