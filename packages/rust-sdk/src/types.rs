//! Type definitions for the RelayCast SDK.

use serde::{Deserialize, Serialize};

// === API Response Envelope ===

#[derive(Debug, Deserialize)]
pub struct ApiResponse<T> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<ApiErrorInfo>,
    pub cursor: Option<Cursor>,
}

#[derive(Debug, Deserialize)]
pub struct ApiErrorInfo {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
pub struct Cursor {
    pub next: Option<String>,
    pub has_more: bool,
}

// === Workspace ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkspaceResponse {
    pub id: String,
    pub name: String,
    pub api_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateWorkspaceRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemPrompt {
    pub prompt: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStreamConfig {
    pub enabled: bool,
    pub default_enabled: bool,
    #[serde(rename = "override")]
    pub override_value: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SetSystemPromptRequest {
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceStats {
    pub agents: AgentStats,
    pub messages: MessageStats,
    pub channels: ChannelStats,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStats {
    pub total: i64,
    pub online: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageStats {
    pub total: i64,
    pub today: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStats {
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityItem {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    pub agent: Option<String>,
    pub channel: Option<String>,
    pub message_id: Option<String>,
    pub created_at: String,
}

// === Agents ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub status: String,
    pub description: Option<String>,
    pub created_at: String,
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateAgentRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentResponse {
    pub id: String,
    pub name: String,
    pub token: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateAgentRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPresenceInfo {
    pub name: String,
    pub status: String,
    pub last_seen: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpawnAgentRequest {
    pub name: String,
    pub cli: String,
    pub task: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnAgentResponse {
    pub id: String,
    pub name: String,
    pub token: String,
    pub cli: String,
    pub task: String,
    pub channel: Option<String>,
    pub status: String,
    pub created_at: String,
    pub already_existed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseAgentRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_agent: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseAgentResponse {
    pub name: String,
    pub released: bool,
    pub deleted: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRotateResponse {
    pub token: String,
}

#[derive(Debug, Clone, Default)]
pub struct AgentListQuery {
    pub status: Option<String>,
}

// === Channels ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub name: String,
    pub topic: Option<String>,
    pub is_private: bool,
    pub is_archived: bool,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_private: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpdateChannelRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_private: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMemberInfo {
    pub agent: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelWithMembers {
    #[serde(flatten)]
    pub channel: Channel,
    pub members: Vec<ChannelMemberInfo>,
}

// === Messages ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageWithMeta {
    pub id: String,
    pub channel: String,
    pub sender: String,
    pub text: String,
    pub thread_ts: Option<String>,
    pub reply_count: Option<i32>,
    pub attachments: Option<Vec<String>>,
    pub blocks: Option<Vec<MessageBlock>>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct PostMessageRequest {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadReplyRequest {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,
}

#[derive(Debug, Clone, Default)]
pub struct MessageListQuery {
    pub limit: Option<i32>,
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadResponse {
    pub parent: MessageWithMeta,
    pub replies: Vec<MessageWithMeta>,
}

// === DMs ===

#[derive(Debug, Clone, Serialize)]
pub struct SendDmRequest {
    pub to: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateGroupDmRequest {
    pub participants: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmConversationSummary {
    pub id: String,
    pub participants: Vec<String>,
    pub name: Option<String>,
    pub is_group: bool,
    pub last_message_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDmConversation {
    pub id: String,
    pub participants: Vec<String>,
    pub name: Option<String>,
    pub is_group: bool,
    pub created_at: String,
    pub last_message_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDmMessage {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub text: String,
    pub created_at: String,
}

// === Reactions ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionGroup {
    pub emoji: String,
    pub count: i32,
    pub users: Vec<String>,
}

// === Search ===

#[derive(Debug, Clone, Default)]
pub struct SearchOptions {
    pub channel: Option<String>,
    pub from: Option<String>,
    pub limit: Option<i32>,
    pub before: Option<String>,
    pub after: Option<String>,
}

// === Inbox ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxResponse {
    pub unread_channels: Vec<UnreadChannel>,
    pub unread_dms: Vec<UnreadDm>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnreadChannel {
    pub channel: String,
    pub unread_count: i32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnreadDm {
    pub conversation_id: String,
    pub unread_count: i32,
}

// === Read Receipts ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderInfo {
    pub agent: String,
    pub read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelReadStatus {
    pub agent: String,
    pub last_read_message_id: Option<String>,
    pub last_read_at: Option<String>,
}

// === Files ===

#[derive(Debug, Clone, Serialize)]
pub struct UploadRequest {
    pub filename: String,
    pub content_type: String,
    pub size: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadResponse {
    pub file_id: String,
    pub upload_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub uploaded_by: String,
    pub url: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Default)]
pub struct FileListOptions {
    pub uploaded_by: Option<String>,
    pub limit: Option<i32>,
}

// === Webhooks ===

#[derive(Debug, Clone, Serialize)]
pub struct CreateWebhookRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWebhookResponse {
    pub id: String,
    pub name: String,
    pub url: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Webhook {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub url: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct WebhookTriggerRequest {
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookTriggerResponse {
    pub received: bool,
}

// === Subscriptions ===

#[derive(Debug, Clone, Serialize)]
pub struct CreateSubscriptionRequest {
    pub url: String,
    pub events: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSubscriptionResponse {
    pub id: String,
    pub url: String,
    pub events: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubscription {
    pub id: String,
    pub url: String,
    pub events: Vec<String>,
    pub created_at: String,
}

// === Commands ===

#[derive(Debug, Clone, Serialize)]
pub struct CreateCommandRequest {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCommandResponse {
    pub command: String,
    pub description: Option<String>,
    pub usage: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommand {
    pub command: String,
    pub description: Option<String>,
    pub usage: Option<String>,
    pub agent: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvokeCommandRequest {
    pub args: Option<String>,
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandInvocation {
    pub id: String,
    pub command: String,
    pub args: Option<String>,
    pub invoked_by: String,
    pub channel: Option<String>,
    pub created_at: String,
}

// === Billing ===

#[derive(Debug, Clone, Serialize)]
pub struct SubscribeRequest {
    pub plan: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment_method_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BillingSubscription {
    pub plan: String,
    pub status: String,
    pub current_period_start: Option<String>,
    pub current_period_end: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageInfo {
    pub messages: i64,
    pub agents: i64,
    pub storage_bytes: i64,
    pub period_start: String,
    pub period_end: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortalResponse {
    pub url: String,
}

// === WebSocket Events ===

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsEvent {
    #[serde(rename = "message.created")]
    MessageCreated(MessageCreatedEvent),
    #[serde(rename = "message.updated")]
    MessageUpdated(MessageUpdatedEvent),
    #[serde(rename = "thread.reply")]
    ThreadReply(ThreadReplyEvent),
    #[serde(rename = "message.read")]
    MessageRead(MessageReadEvent),
    #[serde(rename = "reaction.added")]
    ReactionAdded(ReactionAddedEvent),
    #[serde(rename = "reaction.removed")]
    ReactionRemoved(ReactionRemovedEvent),
    #[serde(rename = "dm.received")]
    DmReceived(DmReceivedEvent),
    #[serde(rename = "group_dm.received")]
    GroupDmReceived(GroupDmReceivedEvent),
    #[serde(rename = "agent.online")]
    AgentOnline(AgentOnlineEvent),
    #[serde(rename = "agent.offline")]
    AgentOffline(AgentOfflineEvent),
    #[serde(rename = "channel.created")]
    ChannelCreated(ChannelCreatedEvent),
    #[serde(rename = "channel.updated")]
    ChannelUpdated(ChannelUpdatedEvent),
    #[serde(rename = "channel.archived")]
    ChannelArchived(ChannelArchivedEvent),
    #[serde(rename = "member.joined")]
    MemberJoined(MemberJoinedEvent),
    #[serde(rename = "member.left")]
    MemberLeft(MemberLeftEvent),
    #[serde(rename = "file.uploaded")]
    FileUploaded(FileUploadedEvent),
    #[serde(rename = "webhook.received")]
    WebhookReceived(WebhookReceivedEvent),
    #[serde(rename = "command.invoked")]
    CommandInvoked(CommandInvokedEvent),
    #[serde(rename = "pong")]
    Pong,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageCreatedEvent {
    pub message: MessageWithMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageUpdatedEvent {
    pub message: MessageWithMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadReplyEvent {
    pub parent_id: String,
    pub reply: MessageWithMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReadEvent {
    pub message_id: String,
    pub reader: String,
    pub read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionAddedEvent {
    pub message_id: String,
    pub emoji: String,
    pub user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionRemovedEvent {
    pub message_id: String,
    pub emoji: String,
    pub user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmReceivedEvent {
    pub conversation_id: String,
    pub message: MessageWithMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmReceivedEvent {
    pub conversation_id: String,
    pub message: MessageWithMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOnlineEvent {
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentOfflineEvent {
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelCreatedEvent {
    pub channel: Channel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelUpdatedEvent {
    pub channel: Channel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelArchivedEvent {
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberJoinedEvent {
    pub channel: String,
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberLeftEvent {
    pub channel: String,
    pub agent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUploadedEvent {
    pub file: FileInfo,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookReceivedEvent {
    pub webhook_id: String,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandInvokedEvent {
    pub invocation: CommandInvocation,
}
