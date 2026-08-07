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
    pub api_key_hash: String,
    pub system_prompt: Option<String>,
    pub plan: String,
    pub created_at: String,
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWorkspaceResponse {
    pub workspace_id: String,
    pub api_key: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateWorkspaceRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemPrompt {
    pub prompt: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SetSystemPromptRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reset: Option<bool>,
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
    #[serde(rename = "type")]
    pub item_type: String,
    pub id: String,
    pub channel_id: Option<String>,
    pub channel_name: Option<String>,
    pub conversation_id: Option<String>,
    pub agent_name: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDmLastMessage {
    pub text: String,
    pub agent_name: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDmConversation {
    pub id: String,
    #[serde(rename = "type")]
    pub dm_type: String,
    pub participants: Vec<String>,
    pub last_message: Option<WorkspaceDmLastMessage>,
    pub message_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceDmMessage {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenRotateResponse {
    pub name: String,
    pub token: String,
}

// === Observer tokens ===

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ObserverScope {
    #[serde(rename = "stream:read")]
    StreamRead,
    #[serde(rename = "messages:read")]
    MessagesRead,
    #[serde(rename = "threads:read")]
    ThreadsRead,
    #[serde(rename = "dms:read")]
    DmsRead,
    #[serde(rename = "channels:read")]
    ChannelsRead,
    #[serde(rename = "search:read")]
    SearchRead,
    #[serde(rename = "agents:read")]
    AgentsRead,
    #[serde(rename = "nodes:read")]
    NodesRead,
    #[serde(rename = "deliveries:read")]
    DeliveriesRead,
    #[serde(rename = "activity:read")]
    ActivityRead,
    #[serde(rename = "files:read")]
    FilesRead,
    #[serde(rename = "reactions:read")]
    ReactionsRead,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ObserverTokenFilters {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channel_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub channel_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_dms: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dm_conversation_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub agent_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub event_types: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_after: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateObserverTokenRequest {
    pub name: String,
    pub scopes: Vec<ObserverScope>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<ObserverTokenFilters>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateObserverTokenRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes: Option<Vec<ObserverScope>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<ObserverTokenFilters>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObserverToken {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub scopes: Vec<ObserverScope>,
    #[serde(default)]
    pub filters: ObserverTokenFilters,
    pub status: String,
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub revoked_at: Option<String>,
    pub last_used_at: Option<String>,
    pub token: Option<String>,
}

// === Agents ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Agent {
    pub id: String,
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub name: String,
    #[serde(rename = "type")]
    pub agent_type: String,
    pub status: String,
    pub persona: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub last_seen: Option<String>,
    #[serde(default)]
    pub channels: Vec<AgentChannelMembership>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentChannelMembership {
    pub id: String,
    pub name: String,
    pub role: String,
    pub joined_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateAgentRequest {
    pub name: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateAgentResponse {
    pub id: String,
    /// Workspace the agent registered into. `None` against engines that predate
    /// this field — callers that joined by workspace key rely on it to avoid an
    /// "unknown workspace" fallback.
    #[serde(default)]
    pub workspace_id: Option<String>,
    pub name: String,
    pub token: String,
    pub status: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateAgentRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persona: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPresenceInfo {
    pub agent_id: String,
    pub agent_name: String,
    pub status: String,
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
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

pub type SpawnAgentResponse = InvokeActionResult;

#[derive(Debug, Clone, Serialize)]
pub struct ReleaseAgentRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delete_agent: Option<bool>,
}

pub type ReleaseAgentResponse = InvokeActionResult;

#[derive(Debug, Clone, Default)]
pub struct AgentListQuery {
    pub status: Option<String>,
}

// === Channels ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Channel {
    pub id: String,
    pub workspace_id: Option<String>,
    pub name: String,
    pub channel_type: Option<i64>,
    pub topic: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    pub created_by: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub is_archived: bool,
    pub member_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateChannelRequest {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct UpdateChannelRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelMemberInfo {
    pub agent_id: String,
    pub agent_name: String,
    pub role: String,
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
pub struct FileAttachment {
    pub file_id: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageBlock {
    #[serde(rename = "type")]
    pub block_type: String,
    #[serde(flatten)]
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionGroup {
    pub emoji: String,
    pub count: i64,
    pub agents: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MessageInjectionMode {
    Wait,
    Steer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageWithMeta {
    pub id: String,
    pub agent_name: String,
    pub agent_id: String,
    pub text: String,
    pub blocks: Option<Vec<MessageBlock>>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub attachments: Vec<FileAttachment>,
    pub created_at: String,
    #[serde(default)]
    pub reply_count: i64,
    #[serde(default)]
    pub reactions: Vec<ReactionGroup>,
    #[serde(default)]
    pub read_by_count: i64,
    #[serde(default)]
    pub injection_mode: Option<MessageInjectionMode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PostMessageRequest {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<MessageInjectionMode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ThreadReplyRequest {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<MessageBlock>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Map<String, serde_json::Value>>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<MessageInjectionMode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateGroupDmRequest {
    pub participants: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmConversationSummary {
    pub id: String,
    #[serde(rename = "type")]
    pub dm_type: String,
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_dm_participants")]
    pub participants: Vec<String>,
    #[serde(default, deserialize_with = "deserialize_dm_last_message")]
    pub last_message: Option<String>,
    pub unread_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmSendResponse {
    pub conversation_id: String,
    pub message: DmEventPayload,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmParticipantRef {
    pub agent_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmConversationResponse {
    pub id: String,
    pub channel_id: String,
    pub dm_type: String,
    pub name: Option<String>,
    pub participants: Vec<GroupDmParticipantRef>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmMessageResponse {
    pub conversation_id: String,
    pub message: DmEventPayload,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmParticipantResponse {
    pub conversation_id: String,
    pub agent: String,
    pub already_member: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum DmParticipantValue {
    Name(String),
    Object {
        agent_name: Option<String>,
        agent_id: Option<String>,
    },
}

fn deserialize_dm_participants<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Vec::<DmParticipantValue>::deserialize(deserializer)?;
    Ok(raw
        .into_iter()
        .filter_map(|item| match item {
            DmParticipantValue::Name(name) if !name.is_empty() => Some(name),
            DmParticipantValue::Object {
                agent_name: Some(name),
                ..
            } if !name.is_empty() => Some(name),
            DmParticipantValue::Object {
                agent_id: Some(id), ..
            } if !id.is_empty() => Some(id),
            _ => None,
        })
        .collect())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
enum DmLastMessageValue {
    Text(String),
    Object {
        text: Option<String>,
        body: Option<String>,
    },
}

fn deserialize_dm_last_message<'de, D>(
    deserializer: D,
) -> std::result::Result<Option<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let raw = Option::<DmLastMessageValue>::deserialize(deserializer)?;
    Ok(match raw {
        Some(DmLastMessageValue::Text(text)) if !text.is_empty() => Some(text),
        Some(DmLastMessageValue::Object {
            text: Some(text), ..
        }) if !text.is_empty() => Some(text),
        Some(DmLastMessageValue::Object {
            body: Some(body), ..
        }) if !body.is_empty() => Some(body),
        _ => None,
    })
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
pub struct UnreadChannel {
    pub channel_name: String,
    pub unread_count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxMention {
    pub id: String,
    pub channel_name: String,
    pub agent_name: String,
    pub text: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnreadDm {
    pub conversation_id: String,
    pub from: String,
    pub unread_count: i64,
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxResponse {
    pub unread_channels: Vec<UnreadChannel>,
    pub mentions: Vec<InboxMention>,
    pub unread_dms: Vec<UnreadDm>,
}

// === Read Receipts ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReaderInfo {
    pub agent_name: String,
    pub agent_id: String,
    pub read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelReadStatus {
    pub agent_name: String,
    pub last_read_id: Option<String>,
    pub last_read_at: Option<String>,
}

// === Durable Delivery ===

/// Status of a per-recipient durable delivery record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryStatus {
    /// Durable row accepted, not yet sent to the current location.
    Queued,
    /// Sent to the current location, awaiting cumulative ack.
    Delivered,
    /// Recipient location acknowledged through the seq cursor.
    Acked,
    /// Explicit failure report (terminal).
    Failed,
    /// TTL-expired / dead-lettered (terminal).
    DeadLettered,
    #[serde(other)]
    Unknown,
}

impl DeliveryStatus {
    /// Return the API query value for this status, or `None` for unknown.
    pub fn as_query_value(self) -> Option<&'static str> {
        match self {
            DeliveryStatus::Queued => Some("queued"),
            DeliveryStatus::Delivered => Some("delivered"),
            DeliveryStatus::Acked => Some("acked"),
            DeliveryStatus::Failed => Some("failed"),
            DeliveryStatus::DeadLettered => Some("dead_lettered"),
            DeliveryStatus::Unknown => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryMessage {
    pub id: String,
    pub channel_id: String,
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub text: String,
    pub thread_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Delivery {
    pub id: String,
    pub message_id: String,
    pub channel_id: String,
    pub agent_id: String,
    pub status: DeliveryStatus,
    #[serde(default)]
    pub seq: Option<i64>,
    #[serde(default)]
    pub location_type: Option<String>,
    #[serde(default)]
    pub location_node_id: Option<String>,
    #[serde(default)]
    pub route_node_id: Option<String>,
    #[serde(default)]
    pub route_node_kind: Option<String>,
    #[serde(default)]
    pub route_node_role: Option<String>,
    #[serde(default)]
    pub delivery_adapter: Option<String>,
    #[serde(default)]
    pub dispatch_attempts: Option<i64>,
    #[serde(default)]
    pub next_attempt_at: Option<String>,
    #[serde(default)]
    pub last_dispatch_error: Option<String>,
    pub mode: String,
    pub reason: Option<String>,
    pub priority: String,
    pub retryable: Option<bool>,
    pub error: Option<String>,
    pub available_at: Option<String>,
    pub deadline: Option<String>,
    #[serde(default)]
    pub expires_at: Option<String>,
    #[serde(default)]
    pub delivered_at: Option<String>,
    #[serde(default)]
    pub acked_at: Option<String>,
    #[serde(default)]
    pub dead_lettered_at: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryItem {
    #[serde(flatten)]
    pub delivery: Delivery,
    pub message: Option<DeliveryMessage>,
}

#[derive(Debug, Clone, Default)]
pub struct ListDeliveriesOptions {
    pub status: Option<DeliveryStatus>,
    pub limit: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct FailDeliveryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeferDeliveryRequest {
    pub available_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

// === Files ===

#[derive(Debug, Clone, Serialize)]
pub struct UploadRequest {
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadResponse {
    pub file_id: String,
    pub upload_url: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileInfo {
    pub file_id: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    pub url: String,
    pub uploaded_by: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateWebhookResponse {
    pub webhook_id: String,
    pub name: String,
    pub channel: String,
    pub url: String,
    pub token: String,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Webhook {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub channel_id: String,
    pub channel_name: String,
    pub url: String,
    pub created_by: Option<String>,
    pub created_at: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct WebhookTriggerRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocks: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookTriggerResponse {
    pub message_id: String,
    pub channel: String,
    pub text: String,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
    pub created_at: String,
}

// === Subscriptions ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubscriptionFilter {
    pub channel: Option<String>,
    pub mentions: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventSubscription {
    pub id: String,
    #[serde(default)]
    pub workspace_id: String,
    pub events: Vec<String>,
    pub filter: Option<SubscriptionFilter>,
    pub url: String,
    #[serde(default)]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub secret: Option<String>,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateSubscriptionRequest {
    pub events: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filter: Option<SubscriptionFilter>,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSubscriptionResponse {
    pub id: String,
    pub events: Vec<String>,
    pub filter: Option<SubscriptionFilter>,
    pub url: String,
    #[serde(default)]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    pub is_active: bool,
    pub created_at: String,
}

// === Commands ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandParameter {
    pub name: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub parameter_type: String,
    pub required: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CreateCommandRequest {
    pub command: String,
    pub description: String,
    pub handler_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<Vec<CommandParameter>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCommandResponse {
    pub id: String,
    pub command: String,
    pub description: String,
    pub handler_agent: String,
    pub parameters: Vec<CommandParameter>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCommand {
    pub id: String,
    pub workspace_id: String,
    pub command: String,
    pub description: String,
    pub handler_agent_id: String,
    pub handler_agent_name: String,
    pub parameters: Vec<CommandParameter>,
    pub created_at: String,
    pub is_active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvokeCommandRequest {
    pub channel: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parameters: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandInvocation {
    pub id: String,
    pub command: String,
    pub channel: String,
    pub invoked_by: String,
    pub args: Option<String>,
    pub parameters: Option<serde_json::Map<String, serde_json::Value>>,
    pub response_message_id: Option<String>,
    pub created_at: String,
}

// === Actions (agent-to-agent RPC) ===

/// Status of an action invocation. `action.completed` always reports
/// [`ActionInvocationStatus::Completed`] and `action.failed` reports
/// [`ActionInvocationStatus::Failed`]; `Unknown` is a forward-compatible fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionInvocationStatus {
    Pending,
    Dispatched,
    Invoked,
    Completed,
    Failed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize)]
pub struct RegisterActionRequest {
    pub name: String,
    pub description: String,
    pub handler_agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_schema: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_to: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionDefinition {
    pub id: String,
    pub name: String,
    pub description: String,
    pub handler_agent: String,
    #[serde(default)]
    pub input_schema: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub output_schema: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub available_to: Option<Vec<String>>,
    pub is_active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InvokeActionRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvokeActionResult {
    pub invocation_id: String,
    pub action_name: String,
    pub handler_agent_id: Option<String>,
    #[serde(default)]
    pub handler_node_id: Option<String>,
    #[serde(default)]
    pub dispatched_node_id: Option<String>,
    #[serde(default)]
    pub input: serde_json::Map<String, serde_json::Value>,
    pub status: ActionInvocationStatus,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CompleteInvocationRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionInvocation {
    pub invocation_id: String,
    pub action_name: String,
    #[serde(default)]
    pub caller_id: Option<String>,
    #[serde(default)]
    pub caller_name: Option<String>,
    #[serde(default)]
    pub input: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub output: Option<serde_json::Map<String, serde_json::Value>>,
    pub status: ActionInvocationStatus,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
}

// === Agent session events ===

#[derive(Debug, Clone, Serialize)]
pub struct EmitSessionEventRequest {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::Map<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionEvent {
    pub id: String,
    pub agent_id: String,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub payload: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub sequence: Option<i64>,
    pub created_at: String,
}

/// Query filters for [`crate::RelayCast::list_agent_events`].
#[derive(Debug, Clone, Default)]
pub struct ListSessionEventsQuery {
    pub event_type: Option<String>,
    pub limit: Option<i32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectNodeToken {
    pub node_id: String,
    pub node_name: String,
    pub token: String,
}

// === WebSocket Events ===

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageEventPayload {
    pub id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub text: String,
    pub attachments: Vec<FileAttachment>,
    #[serde(default)]
    pub injection_mode: Option<MessageInjectionMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageUpdatedPayload {
    pub id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadReplyPayload {
    pub id: String,
    #[serde(default)]
    pub agent_id: Option<String>,
    pub agent_name: String,
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmEventPayload {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub text: String,
    #[serde(default)]
    pub injection_mode: Option<MessageInjectionMode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEventPayload {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelEventPayload {
    pub name: String,
    pub topic: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelArchivedPayload {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEventPayload {
    pub file_id: String,
    pub filename: String,
    pub uploaded_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookMessagePayload {
    pub id: String,
    pub text: String,
    pub source: Option<String>,
    #[serde(default)]
    pub author: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsEvent {
    #[serde(rename = "message.created")]
    MessageCreated(MessageCreatedEvent),
    #[serde(rename = "message.updated")]
    MessageUpdated(MessageUpdatedEvent),
    #[serde(rename = "thread.reply")]
    ThreadReply(ThreadReplyEvent),
    #[serde(rename = "message.reacted")]
    MessageReacted(MessageReactedEvent),
    #[serde(rename = "dm.received")]
    DmReceived(DmReceivedEvent),
    #[serde(rename = "group_dm.received")]
    GroupDmReceived(GroupDmReceivedEvent),
    #[serde(rename = "agent.status.active")]
    AgentStatusActive(AgentStatusEvent),
    #[serde(rename = "agent.status.idle")]
    AgentStatusIdle(AgentStatusEvent),
    #[serde(rename = "agent.status.blocked")]
    AgentStatusBlocked(AgentStatusEvent),
    #[serde(rename = "agent.status.waiting")]
    AgentStatusWaiting(AgentStatusEvent),
    #[serde(rename = "agent.status.offline")]
    AgentStatusOffline(AgentStatusEvent),
    #[serde(rename = "agent.status.changed")]
    AgentStatusChanged(AgentStatusEvent),
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
    #[serde(rename = "message.read")]
    MessageRead(MessageReadEvent),
    #[serde(rename = "file.uploaded")]
    FileUploaded(FileUploadedEvent),
    #[serde(rename = "webhook.received")]
    WebhookReceived(WebhookReceivedEvent),
    #[serde(rename = "command.invoked")]
    CommandInvoked(CommandInvokedEvent),
    #[serde(rename = "action.invoked")]
    ActionInvoked(ActionInvokedEvent),
    #[serde(rename = "action.completed")]
    ActionCompleted(ActionCompletedEvent),
    #[serde(rename = "action.failed")]
    ActionFailed(ActionFailedEvent),
    #[serde(rename = "action.denied")]
    ActionDenied(ActionDeniedEvent),
    #[serde(rename = "delivery.accepted")]
    DeliveryAccepted(DeliveryAcceptedEvent),
    #[serde(rename = "delivery.delivered")]
    DeliveryDelivered(DeliveryDeliveredEvent),
    #[serde(rename = "delivery.deferred")]
    DeliveryDeferred(DeliveryDeferredEvent),
    #[serde(rename = "delivery.failed")]
    DeliveryFailed(DeliveryFailedEvent),
    #[serde(rename = "pong")]
    Pong,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageCreatedEvent {
    pub channel: String,
    pub message: MessageEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageUpdatedEvent {
    pub channel: String,
    pub message: MessageUpdatedPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadReplyEvent {
    #[serde(default)]
    pub channel: Option<String>,
    pub parent_id: String,
    pub message: ThreadReplyPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReactedEvent {
    pub message_id: String,
    pub emoji: String,
    pub agent_name: String,
    #[serde(default)]
    pub action: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DmReceivedEvent {
    pub conversation_id: String,
    pub message: DmEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupDmReceivedEvent {
    pub conversation_id: String,
    pub message: DmEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentStatusEvent {
    pub agent: AgentEventPayload,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelCreatedEvent {
    pub channel: ChannelEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelUpdatedEvent {
    pub channel: ChannelEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelArchivedEvent {
    pub channel: ChannelArchivedPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberJoinedEvent {
    pub channel: String,
    pub agent_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemberLeftEvent {
    pub channel: String,
    pub agent_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageReadEvent {
    pub message_id: String,
    pub agent_name: String,
    pub read_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileUploadedEvent {
    pub file: FileEventPayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookReceivedEvent {
    pub webhook_id: String,
    pub channel: String,
    pub message: WebhookMessagePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandInvokedEvent {
    pub command: String,
    pub channel: String,
    pub invoked_by: String,
    pub handler_agent_id: String,
    pub args: Option<String>,
    pub parameters: Option<serde_json::Map<String, serde_json::Value>>,
}

/// `action.invoked` — delivered to the handler agent when an action is invoked.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionInvokedEvent {
    pub invocation_id: String,
    pub action_name: String,
    pub caller_name: String,
    pub handler_agent_id: String,
    #[serde(default)]
    pub handler_agent_name: Option<String>,
    #[serde(default)]
    pub input: Option<serde_json::Value>,
}

/// Literal `completed` status for [`ActionCompletedEvent`]; deserialization
/// rejects any other value so malformed `action.completed` payloads fail fast.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompletedStatus {
    Completed,
}

/// Literal `failed` status for [`ActionFailedEvent`]; deserialization rejects
/// any other value so malformed `action.failed` payloads fail fast.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FailedStatus {
    Failed,
}

/// `action.completed` — delivered to the caller when an invocation succeeds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionCompletedEvent {
    pub invocation_id: String,
    pub action_name: String,
    pub status: CompletedStatus,
    #[serde(default)]
    pub output: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub error: Option<String>,
}

/// `action.failed` — delivered to the caller when an invocation fails.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionFailedEvent {
    pub invocation_id: String,
    pub action_name: String,
    pub status: FailedStatus,
    #[serde(default)]
    pub output: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default)]
    pub error: Option<String>,
}

/// `action.denied` — delivered to the caller when authorization rejects an invocation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionDeniedEvent {
    pub action_name: String,
    #[serde(default)]
    pub caller_name: Option<String>,
    pub error: String,
}

/// `delivery.accepted` — emitted when a delivery is queued for the recipient.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryAcceptedEvent {
    pub delivery_id: String,
    pub message_id: String,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `delivery.delivered` — emitted when a delivery is acknowledged.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryDeliveredEvent {
    pub delivery_id: String,
    pub message_id: String,
}

/// `delivery.deferred` — emitted when a delivery is deferred for retry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryDeferredEvent {
    pub delivery_id: String,
    pub message_id: String,
    pub available_at: Option<String>,
    #[serde(default)]
    pub reason: Option<String>,
}

/// `delivery.failed` — emitted when a delivery handler reports failure.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeliveryFailedEvent {
    #[serde(default)]
    pub delivery_id: Option<String>,
    pub message_id: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub retryable: Option<bool>,
}

// === Workspace bootstrap (by-name lookup) ===

/// Result of a `GET /v1/workspaces/by-name/{name}` lookup.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkspaceLookup {
    pub id: String,
    pub name: String,
    pub created_at: String,
}

// === A2A (agent-to-agent bridge) ===

/// A skill advertised on an A2A agent card.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aAgentCardSkill {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
}

/// An A2A agent card describing an external agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aAgentCard {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub url: String,
    pub version: String,
    #[serde(default)]
    pub skills: Vec<A2aAgentCardSkill>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_input_modes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_output_modes: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub documentation_url: Option<String>,
}

/// Options for registering an A2A agent bridge.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RegisterA2aOptions {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_card_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_card: Option<A2aAgentCard>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_scheme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_credential: Option<String>,
}

/// Response from registering an A2A agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisterA2aResponse {
    pub relay_name: String,
    pub relay_token: String,
    pub webhook_url: String,
    pub certification: String,
}

/// A registered A2A agent record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct A2aAgentRecord {
    pub id: String,
    pub workspace_id: String,
    pub relay_agent_id: String,
    pub relay_name: String,
    pub relay_status: String,
    #[serde(default)]
    pub relay_persona: Option<String>,
    #[serde(default)]
    pub relay_metadata: Option<serde_json::Map<String, serde_json::Value>>,
    pub agent_card: A2aAgentCard,
    pub external_url: String,
    #[serde(default)]
    pub auth_scheme: Option<String>,
    #[serde(default)]
    pub auth_credential: Option<String>,
    pub status: String,
    pub messages_sent: i64,
    pub messages_recv: i64,
    #[serde(default)]
    pub last_health: Option<String>,
    pub health_failures: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// Response from removing an A2A agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoveA2aAgentResponse {
    pub name: String,
    pub removed: bool,
}

// === Directory ===

/// A skill input when publishing/importing directory agents.
#[derive(Debug, Clone, Serialize)]
pub struct DirectorySkillInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

/// A skill stored on a directory agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectorySkill {
    pub id: String,
    #[serde(default)]
    pub skill_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

/// A directory agent entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryAgent {
    pub id: String,
    #[serde(default)]
    pub source_agent_id: Option<String>,
    pub slug: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub endpoint_url: Option<String>,
    #[serde(default)]
    pub documentation_url: Option<String>,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub capabilities: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    pub status: String,
    pub rating_avg: f64,
    pub rating_count: i64,
    #[serde(default)]
    pub skills: Vec<DirectorySkill>,
    pub created_at: String,
    pub updated_at: String,
}

/// A directory search result (a directory agent plus a relevance score).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectorySearchResult {
    #[serde(flatten)]
    pub agent: DirectoryAgent,
    pub relevance_score: f64,
}

/// Query parameters for searching the directory.
#[derive(Debug, Clone, Default)]
pub struct SearchDirectoryQuery {
    pub q: Option<String>,
    pub tags: Option<Vec<String>>,
    pub status: Option<String>,
    pub limit: Option<i32>,
}

/// Request body for publishing an agent to the directory.
#[derive(Debug, Clone, Serialize)]
pub struct PublishToDirectoryRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<DirectorySkillInput>>,
}

/// Request body for updating a directory agent (all fields optional).
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateDirectoryAgentRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_agent_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slug: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documentation_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<DirectorySkillInput>>,
}

/// Query parameters for listing directory agents.
#[derive(Debug, Clone, Default)]
pub struct ListDirectoryQuery {
    pub status: Option<String>,
    pub limit: Option<i32>,
}

/// A rating left on a directory agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirectoryRating {
    pub id: String,
    pub score: f64,
    #[serde(default)]
    pub review: Option<String>,
    pub rater_agent_id: String,
    pub rater_agent_name: String,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Request body for rating a directory agent.
#[derive(Debug, Clone, Serialize)]
pub struct RateDirectoryAgentRequest {
    pub score: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub review: Option<String>,
}

/// Request body for importing skills onto a directory agent.
#[derive(Debug, Clone, Serialize)]
pub struct ImportSkillsRequest {
    pub agent_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skills: Option<Vec<DirectorySkillInput>>,
}

// === Routing ===

/// Result of routing a message to a candidate agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteResult {
    pub agent_name: String,
    pub score: f64,
    pub fallback: bool,
}

/// Routing scorer weights.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingWeights {
    pub skill_match: f64,
    pub message_match: f64,
    pub tag_match: f64,
    pub rating: f64,
    pub availability: f64,
}

/// Partial routing weights for updates (all fields optional).
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateRoutingWeights {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skill_match: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_match: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tag_match: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub availability: Option<f64>,
}

/// Workspace routing configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RoutingConfig {
    pub weights: RoutingWeights,
    pub circuit_breaker_threshold: f64,
    pub circuit_breaker_cooldown_seconds: f64,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Request body for updating routing configuration.
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateRoutingConfigRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weights: Option<UpdateRoutingWeights>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuit_breaker_threshold: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub circuit_breaker_cooldown_seconds: Option<f64>,
}

/// Request body for reporting route feedback.
#[derive(Debug, Clone, Serialize)]
pub struct RouteFeedbackRequest {
    pub agent_name: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Result of reporting route feedback.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteFeedbackResult {
    pub ok: bool,
}

// === Skills ===

/// Query parameters for searching skills.
#[derive(Debug, Clone, Default)]
pub struct SkillSearchQuery {
    pub q: Option<String>,
    pub limit: Option<i32>,
}

/// A skill search result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillSearchResult {
    pub agent_name: String,
    pub skill_name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub relevance_score: f64,
}

// === Fleet nodes ===

/// A capability advertised by a fleet node on the roster.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeCapability {
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Map<String, serde_json::Value>>,
}

/// A fleet node roster entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeRosterEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub delivery_adapter: Option<String>,
    #[serde(default)]
    pub delivery: Option<NodeDeliveryConfig>,
    #[serde(default)]
    pub capabilities: Vec<NodeCapability>,
    #[serde(default)]
    pub tags: Vec<String>,
    pub version: String,
    pub status: String,
    pub live: bool,
    pub handlers_live: bool,
    pub load: Option<f64>,
    pub active_agents: i64,
    pub max_agents: i64,
    #[serde(default)]
    pub last_heartbeat_at: Option<String>,
    pub created_at: String,
}

/// Query parameters for listing fleet nodes.
#[derive(Debug, Clone, Default)]
pub struct NodeListQuery {
    pub capability: Option<String>,
    pub name: Option<String>,
}

/// Delivery config for a node. HTTP push is typed; raw JSON keeps future adapters usable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum NodeDeliveryConfig {
    HttpPush(Box<HttpPushNodeDelivery>),
    Raw(serde_json::Value),
}

impl From<HttpPushNodeDelivery> for NodeDeliveryConfig {
    fn from(delivery: HttpPushNodeDelivery) -> Self {
        Self::HttpPush(Box::new(delivery))
    }
}

/// HTTP push delivery settings for a node.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpPushNodeDelivery {
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ack_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<NodeDeliveryAuth>,
}

/// HTTP push authentication settings for a node delivery contract.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeDeliveryAuth {
    #[serde(rename = "type")]
    pub auth_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub headers: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signature_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timestamp_header: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signed_payload: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub encoding: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prefix: Option<String>,
}

/// Request to enroll or rotate a node token.
#[derive(Debug, Clone, Serialize)]
pub struct CreateNodeRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery_adapter: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<NodeDeliveryConfig>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_agents: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Response from node enrollment or token rotation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateNodeResponse {
    #[serde(flatten)]
    pub node: NodeRosterEntry,
    pub token: String,
}

/// Agent binding to a node delivery host.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeAgentBinding {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub node_id: String,
    pub node_name: String,
    pub node_kind: String,
    pub node_role: String,
    pub status: String,
    pub session_ref: Option<String>,
    pub priority: i64,
    pub created_at: String,
    pub updated_at: Option<String>,
}

/// Request to bind an agent to a node delivery host.
#[derive(Debug, Clone, Serialize)]
pub struct BindAgentToNodeRequest {
    pub agent_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
}

// === Triggers ===

/// A trigger that fires an action when a message matches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Trigger {
    pub id: String,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub pattern: Option<String>,
    #[serde(default)]
    pub mention: Option<bool>,
    pub action_name: String,
    pub enabled: bool,
    #[serde(default)]
    pub last_triggered_at: Option<String>,
    pub created_at: String,
    #[serde(default)]
    pub updated_at: Option<String>,
}

/// Request body for creating a trigger.
#[derive(Debug, Clone, Serialize)]
pub struct CreateTriggerRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention: Option<bool>,
    pub action_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

/// Request body for updating a trigger (all fields optional).
#[derive(Debug, Clone, Default, Serialize)]
pub struct UpdateTriggerRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mention: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

// === Certification ===

/// A single certification test result.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CertificationTestResult {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub passed: Option<bool>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// A certification run for an external agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CertificationRun {
    pub id: String,
    pub agent_url: String,
    pub level: i64,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    pub passed: bool,
    pub passed_tests: i64,
    pub total_tests: i64,
    #[serde(default)]
    pub monitor_enabled: Option<bool>,
    #[serde(default)]
    pub monitor_interval_minutes: Option<i64>,
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub started_at: Option<String>,
    #[serde(default)]
    pub completed_at: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub tests: Vec<CertificationTestResult>,
}

/// Request body for submitting a certification run.
#[derive(Debug, Clone, Serialize)]
pub struct SubmitCertificationRequest {
    pub agent_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<i32>,
}

/// Request body for enabling certification monitoring.
#[derive(Debug, Clone, Serialize)]
pub struct MonitorCertificationRequest {
    pub agent_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub level: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_minutes: Option<i32>,
}

// === Console / observability ===

/// Query parameters for the console message log.
#[derive(Debug, Clone, Default)]
pub struct ConsoleMessagesQuery {
    pub limit: Option<i32>,
    pub before: Option<String>,
    pub agent_id: Option<String>,
    pub channel_id: Option<String>,
    pub conversation_id: Option<String>,
    pub delivery_kind: Option<String>,
}

/// A console message log entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleMessageLog {
    pub id: String,
    #[serde(default)]
    pub message_id: Option<String>,
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub channel_name: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_name: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
    pub delivery_kind: String,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub content_type: Option<String>,
    #[serde(default)]
    pub metadata: serde_json::Map<String, serde_json::Value>,
    pub attachment_count: i64,
    pub mention_count: i64,
    #[serde(default)]
    pub latency_ms: Option<i64>,
    pub created_at: String,
}

/// Query parameters for windowed console stats.
#[derive(Debug, Clone, Default)]
pub struct ConsoleWindowQuery {
    pub days: Option<i32>,
}

/// Query parameters for console agent stats.
#[derive(Debug, Clone, Default)]
pub struct ConsoleAgentStatsQuery {
    pub days: Option<i32>,
    pub limit: Option<i32>,
}

/// Console overview statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleOverview {
    pub window_days: i64,
    pub since: String,
    pub total_messages: i64,
    pub channel_messages: i64,
    pub dm_messages: i64,
    pub unique_agents: i64,
    pub avg_latency_ms: f64,
    pub max_latency_ms: f64,
    pub attachment_count: i64,
    pub mention_count: i64,
}

/// Per-agent console statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleAgentStat {
    pub agent_id: String,
    pub agent_name: String,
    pub message_count: i64,
    pub channel_count: i64,
    pub dm_count: i64,
    pub avg_latency_ms: f64,
    #[serde(default)]
    pub last_message_at: Option<String>,
}

/// Per-agent cost statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleCostAgent {
    pub agent_id: String,
    pub agent_name: String,
    pub message_count: i64,
    pub total_cost_usd: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

/// Aggregate cost totals across the window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleCostTotals {
    pub total_cost_usd: f64,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub total_tokens: i64,
}

/// Console cost statistics for the window.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleCostStats {
    pub window_days: i64,
    pub totals: ConsoleCostTotals,
    #[serde(default)]
    pub agents: Vec<ConsoleCostAgent>,
}
