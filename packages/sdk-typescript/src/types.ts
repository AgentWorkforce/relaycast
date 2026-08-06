import type * as Raw from '@relaycast/types';
import type { Camelize } from './casing.js';

/**
 * Any JSON value — scalars, arrays, objects, or `null` — exactly mirroring the
 * runtime wire contract (`FleetWireJsonValue`). Action invocation outputs are
 * unconstrained JSON, so this is intentionally wider than `Record<string, unknown>`.
 */
export type JsonValue = Raw.FleetWireJsonValue;

/**
 * A capability advertised by a fleet node on the roster. The runtime emits and
 * stores structured capability objects (`{ name, kind?, metadata? }`), never bare
 * capability-name strings, so the SDK roster type must match.
 */
export type NodeCapability = Raw.FleetCapability;

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

// === Directory (extended) ===

export interface ListDirectoryQuery {
  status?: string;
  limit?: number;
}

export interface UpdateDirectoryAgentRequest {
  sourceAgentName?: string | null;
  slug?: string;
  name?: string;
  description?: string | null;
  provider?: string | null;
  endpointUrl?: string | null;
  documentationUrl?: string | null;
  version?: string | null;
  tags?: string[];
  capabilities?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  status?: string;
  skills?: DirectorySkillInput[];
}

export interface DirectoryRating {
  id: string;
  score: number;
  review: string | null;
  raterAgentId: string;
  raterAgentName: string;
  createdAt: string;
  updatedAt?: string;
}

export interface RateDirectoryAgentRequest {
  score: number;
  review?: string;
}

// === Routing / Skills (extended) ===

export interface RouteFeedbackRequest {
  agentName: string;
  success: boolean;
  error?: string;
}

export interface RouteFeedbackResult {
  ok: boolean;
}

export interface SkillSearchQuery {
  q?: string;
  limit?: number;
}

export interface SkillSearchResult {
  agentName: string;
  skillName: string;
  description: string | null;
  tags: string[];
  relevanceScore: number;
}

// === Actions ===

export interface ActionDefinition {
  id: string;
  name: string;
  description: string;
  handlerAgent: string | null;
  handlerNode: string | null;
  handlerNodeId: string | null;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  availableTo: string[] | null;
  isActive: boolean;
  createdAt: string;
}

export interface RegisterActionRequest {
  name: string;
  description: string;
  handlerAgent?: string;
  handlerNode?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  availableTo?: string[];
}

export interface InvokeActionResult {
  invocationId: string;
  actionName: string;
  handlerAgentId: string | null;
  handlerNodeId?: string | null;
  dispatchedNodeId?: string | null;
  input: Record<string, unknown>;
  status: string;
  createdAt: string;
}

export interface CompleteInvocationRequest {
  output?: JsonValue;
  error?: string;
  durationMs?: number;
}

export interface ActionInvocation {
  invocationId: string;
  actionName: string;
  callerId: string | null;
  callerName?: string | null;
  input?: Record<string, unknown>;
  output: JsonValue;
  status: string;
  error: string | null;
  durationMs: number | null;
  dispatchedNodeId?: string | null;
  dispatchedAt?: string | null;
  createdAt?: string;
  completedAt: string | null;
}

// === Fleet nodes / triggers ===

export type NodeKind = 'ws' | 'http_push' | 'poll';
export type NodeRole = 'direct' | 'broker';
export type NodeAckMode = 'manual' | 'on_2xx' | 'response';

export type NodeDeliveryAuth =
  | { type: 'none' }
  | { type: 'bearer'; token: string }
  | { type: 'static_headers'; headers: Record<string, string> }
  | {
    type: 'hmac_sha256';
    secret: string;
    signatureHeader?: string;
    timestampHeader?: string;
    signedPayload?: 'body' | 'timestamp.body';
    encoding?: 'hex';
    prefix?: string;
  };

export interface HttpPushNodeDelivery {
  url: string;
  ackMode?: NodeAckMode;
  auth?: NodeDeliveryAuth;
  /**
   * Route this node's webhook POST through the deployment's configured egress
   * proxy (wire field `use_proxy`) instead of hitting `url` directly. For
   * receivers that block the server's network origin; fails if no proxy is
   * configured server-side.
   */
  useProxy?: boolean;
}

export interface NodeRosterEntry {
  id: string;
  name: string;
  kind: NodeKind | string;
  role: NodeRole | string;
  deliveryAdapter: string;
  delivery: Record<string, unknown> | null;
  capabilities: NodeCapability[];
  tags: string[];
  version: string;
  status: 'online' | 'offline' | string;
  live: boolean;
  handlersLive: boolean;
  /** Managed-agent capacity utilization in [0,1], or null when unreported. */
  load: number | null;
  activeAgents: number;
  maxAgents: number;
  lastHeartbeatAt: string | null;
  createdAt: string;
}

export interface CreateNodeRequest {
  nodeId?: string;
  name: string;
  kind?: NodeKind;
  role?: NodeRole;
  deliveryAdapter?: string;
  delivery?: HttpPushNodeDelivery | Record<string, unknown> | null;
  capabilities?: string[];
  maxAgents?: number;
  tags?: string[];
  version?: string;
}

export interface CreateNodeResponse extends NodeRosterEntry {
  token: string;
}

export interface NodeAgentBinding {
  id: string;
  agentId: string;
  agentName: string;
  nodeId: string;
  nodeName: string;
  nodeKind: NodeKind | string;
  nodeRole: NodeRole | string;
  status: string;
  sessionRef: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string | null;
}

export interface BindAgentToNodeRequest {
  agentName: string;
  sessionRef?: string | null;
  priority?: number;
}

export interface NodeListQuery {
  capability?: string;
  name?: string;
}

export interface Trigger {
  id: string;
  channel: string | null;
  pattern: string | null;
  mention: boolean | null;
  actionName: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface CreateTriggerRequest {
  channel?: string | null;
  pattern?: string | null;
  mention?: boolean | null;
  actionName: string;
  enabled?: boolean;
}

export type UpdateTriggerRequest = Partial<CreateTriggerRequest>;

// === Agent session events ===

export interface SessionEvent {
  id: string;
  agentId: string;
  type: string;
  payload: Record<string, unknown>;
  sequence?: number;
  createdAt: string;
}

export interface EmitSessionEventRequest {
  type: string;
  payload?: Record<string, unknown>;
}

export interface ListSessionEventsQuery {
  type?: string;
  limit?: number;
}

// === Certification ===

export interface CertificationTestResult {
  name?: string;
  passed?: boolean;
  [key: string]: unknown;
}

export interface CertificationRun {
  id: string;
  agentUrl: string;
  level: number;
  source?: string;
  status?: string;
  passed: boolean;
  passedTests: number;
  totalTests: number;
  monitorEnabled?: boolean;
  monitorIntervalMinutes?: number | null;
  lastRunAt?: string | null;
  startedAt?: string;
  completedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  tests: CertificationTestResult[];
}

export interface SubmitCertificationRequest {
  agentUrl: string;
  level?: 1 | 2 | 3;
}

export interface MonitorCertificationRequest {
  agentUrl: string;
  level?: 1 | 2 | 3;
  intervalMinutes?: number;
}

// === Console / observability ===

export interface ConsoleMessagesQuery {
  limit?: number;
  before?: string;
  agentId?: string;
  channelId?: string;
  conversationId?: string;
  deliveryKind?: 'channel' | 'dm';
}

export interface ConsoleMessageLog {
  id: string;
  messageId: string | null;
  channelId: string | null;
  channelName: string | null;
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  deliveryKind: string;
  text: string | null;
  contentType: string | null;
  metadata: Record<string, unknown>;
  attachmentCount: number;
  mentionCount: number;
  latencyMs: number | null;
  createdAt: string;
}

export interface ConsoleWindowQuery {
  days?: number;
}

export interface ConsoleAgentStatsQuery {
  days?: number;
  limit?: number;
}

export interface ConsoleOverview {
  windowDays: number;
  since: string;
  totalMessages: number;
  channelMessages: number;
  dmMessages: number;
  uniqueAgents: number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  attachmentCount: number;
  mentionCount: number;
}

export interface ConsoleAgentStat {
  agentId: string;
  agentName: string;
  messageCount: number;
  channelCount: number;
  dmCount: number;
  avgLatencyMs: number;
  lastMessageAt: string | null;
}

export interface ConsoleCostAgent {
  agentId: string;
  agentName: string;
  messageCount: number;
  totalCostUsd: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ConsoleCostStats {
  windowDays: number;
  totals: {
    totalCostUsd: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  agents: ConsoleCostAgent[];
}

export type ActivityItem = Camelize<Raw.ActivityItem>;
export type Agent = Camelize<Raw.Agent>;
export type AgentListQuery = Camelize<Raw.AgentListQuery>;
export type AgentStatusActiveEvent = Camelize<Raw.AgentStatusActiveEvent>;
export type AgentStatusBlockedEvent = Camelize<Raw.AgentStatusBlockedEvent>;
export type AgentStatusChangedEvent = Camelize<Raw.AgentStatusChangedEvent>;
export type AgentStatusEvent = Camelize<Raw.AgentStatusEvent>;
export type AgentStatusIdleEvent = Camelize<Raw.AgentStatusIdleEvent>;
export type AgentStatusOfflineEvent = Camelize<Raw.AgentStatusOfflineEvent>;
export type AgentStatusWaitingEvent = Camelize<Raw.AgentStatusWaitingEvent>;
export type AgentPresenceInfo = Camelize<Raw.AgentPresenceInfo>;
export type Channel = Camelize<Raw.Channel>;
export type ChannelArchivedEvent = Camelize<Raw.ChannelArchivedEvent>;
export type ChannelCreatedEvent = Camelize<Raw.ChannelCreatedEvent>;
export type ChannelMemberInfo = Camelize<Raw.ChannelMemberInfo>;
export type JoinChannelResponse = Camelize<Raw.JoinChannelResponse>;
export type InviteChannelResponse = Camelize<Raw.InviteChannelResponse>;
export type ChannelReadStatus = Camelize<Raw.ChannelReadStatus>;
export type ChannelUpdatedEvent = Camelize<Raw.ChannelUpdatedEvent>;
export type CreateAgentRequest = Camelize<Raw.CreateAgentRequest>;
export type CreateAgentResponse = Camelize<Raw.CreateAgentResponse>;
export type CreateChannelRequest = Camelize<Raw.CreateChannelRequest>;
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
export type MemberJoinedEvent = Camelize<Raw.MemberJoinedEvent>;
export type MemberLeftEvent = Camelize<Raw.MemberLeftEvent>;
export type ChannelMutedEvent = Camelize<Raw.ChannelMutedEvent>;
export type ChannelUnmutedEvent = Camelize<Raw.ChannelUnmutedEvent>;
export type MuteChannelResponse = Camelize<Raw.MuteChannelResponse>;
export type MessageBlock = Camelize<Raw.MessageBlock>;
export type MessageCreatedEvent = Camelize<Raw.MessageCreatedEvent>;
export type MessageListQuery = Camelize<Raw.MessageListQuery>;
export type MessageReadEvent = Camelize<Raw.MessageReadEvent>;
export type MessageReactedEvent = Camelize<Raw.MessageReactedEvent>;
export type SearchMessageResult = Camelize<Raw.SearchMessageResult>;
export type MessageUpdatedEvent = Camelize<Raw.MessageUpdatedEvent>;
export type MessageWithMeta = Camelize<Raw.MessageWithMeta>;
export type PostMessageRequest = Camelize<Raw.PostMessageRequest>;
export type AddedReaction = Camelize<Raw.AddedReaction>;
export type ReactionGroup = Camelize<Raw.ReactionGroup>;
export type ReadReceipt = Camelize<Raw.ReadReceipt>;
export type ReaderInfo = Camelize<Raw.ReaderInfo>;
export type RelaycastMessageEvent = Camelize<Raw.RelaycastMessageEvent>;
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

export type ObserverScope = Raw.ObserverScope;
export type ObserverTokenFilters = Camelize<Raw.ObserverTokenFilters>;
export type CreateObserverTokenRequest = Camelize<Raw.CreateObserverTokenRequest>;
export type UpdateObserverTokenRequest = Camelize<Raw.UpdateObserverTokenRequest>;
export type ObserverToken = Camelize<Raw.ObserverToken>;

export type ActionInvokedEvent = Camelize<Raw.ActionInvokedEvent>;
export type ActionCompletedEvent = Camelize<Raw.ActionCompletedEvent>;
export type ActionDeniedEvent = Camelize<Raw.ActionDeniedEvent>;
export type ActionFailedEvent = Camelize<Raw.ActionFailedEvent>;
export type Delivery = Camelize<Raw.Delivery>;
export type DeliveryItem = Camelize<Raw.DeliveryItem>;
export type DeliveryMessage = Camelize<Raw.DeliveryMessage>;
export type DeliveryStatus = Raw.DeliveryStatus;
export type FailDeliveryRequest = Camelize<Raw.FailDeliveryRequest>;
export type DeferDeliveryRequest = Camelize<Raw.DeferDeliveryRequest>;
export type DeliveryAcceptedEvent = Camelize<Raw.DeliveryAcceptedEvent>;
export type DeliveryDeliveredEvent = Camelize<Raw.DeliveryDeliveredEvent>;
export type DeliveryDeferredEvent = Camelize<Raw.DeliveryDeferredEvent>;
export type DeliveryFailedEvent = Camelize<Raw.DeliveryFailedEvent>;
export type Webhook = Camelize<Raw.Webhook>;
export type WebhookReceivedEvent = Camelize<Raw.WebhookReceivedEvent>;
export type WebhookTriggerRequest = Camelize<Raw.WebhookTriggerRequest>;
export type WebhookTriggerResponse = Camelize<Raw.WebhookTriggerResponse>;
export type Workspace = Camelize<Raw.Workspace>;
export type WorkspaceDmConversation = Camelize<Raw.WorkspaceDmConversation>;
export type ResyncAckEvent = Camelize<Raw.ResyncAckEvent>;
export type SearchResult = SearchMessageResult;
export type WsClientEvent = Camelize<Raw.WsClientEvent>;
export type WsCloseEvent = Camelize<Raw.WsCloseEvent>;
export type WsErrorEvent = Camelize<Raw.WsErrorEvent>;
export type WsOpenEvent = Camelize<Raw.WsOpenEvent>;
export type WsPermanentlyDisconnectedEvent = Camelize<Raw.WsPermanentlyDisconnectedEvent>;
export type WsReconnectingEvent = Camelize<Raw.WsReconnectingEvent>;
export type WsResyncedEvent = Camelize<Raw.WsResyncedEvent>;

// === Compile-level contract assertions =====================================
// These are type-only checks (zero JS emit) enforced on every `tsc` build, so
// the fleet node + action SDK types can never silently drift from the runtime
// wire contract again. A mismatch fails the build with `Type 'false' does not
// satisfy the constraint 'true'`. (`src/__tests__` is excluded from the build,
// so the matching `expectTypeOf` checks there are documentation, not enforcement.)
type Assert<T extends true> = T;
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;

// Node roster capabilities are structured objects, not capability-name strings.
type _AssertRosterCapabilities = Assert<Equals<NodeRosterEntry['capabilities'], Raw.FleetCapability[]>>;
type _AssertNodeCapability = Assert<Equals<NodeCapability, Raw.FleetCapability>>;
// Action output is any JSON value (scalars/arrays/null legal), not object-only.
type _AssertInvocationOutput = Assert<Equals<ActionInvocation['output'], Raw.FleetWireJsonValue>>;
type _AssertCompletionOutput = Assert<Equals<CompleteInvocationRequest['output'], Raw.FleetWireJsonValue | undefined>>;
type _AssertObserverScope = Assert<Equals<ObserverScope, Raw.ObserverScope>>;
type _AssertObserverTokenFilters = Assert<Equals<ObserverTokenFilters, Camelize<Raw.ObserverTokenFilters>>>;
type _AssertCreateObserverTokenRequest = Assert<Equals<CreateObserverTokenRequest, Camelize<Raw.CreateObserverTokenRequest>>>;
type _AssertUpdateObserverTokenRequest = Assert<Equals<UpdateObserverTokenRequest, Camelize<Raw.UpdateObserverTokenRequest>>>;
type _AssertObserverToken = Assert<Equals<ObserverToken, Camelize<Raw.ObserverToken>>>;
