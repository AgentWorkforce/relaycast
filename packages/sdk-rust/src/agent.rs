//! Agent client for message and channel operations.

use crate::client::{ClientOptions, HttpClient, RequestOptions};
use crate::error::{RelayError, Result};
use crate::types::*;
use crate::ws::{EventReceiver, LifecycleReceiver, WsClient, WsClientOptions};

/// Strip leading '#' from channel names.
fn strip_hash(channel: &str) -> &str {
    channel.strip_prefix('#').unwrap_or(channel)
}

/// Client for agent-level operations.
pub struct AgentClient {
    client: HttpClient,
    ws: Option<WsClient>,
}

/// Send options for DM operations.
#[derive(Debug, Clone)]
pub struct DmOptions {
    pub mode: MessageInjectionMode,
    pub attachments: Option<Vec<String>>,
    pub idempotency_key: Option<String>,
}

impl Default for DmOptions {
    fn default() -> Self {
        Self {
            mode: MessageInjectionMode::Wait,
            attachments: None,
            idempotency_key: None,
        }
    }
}

/// Result of ensuring a channel exists and is joined.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnsureChannelOutcome {
    /// Channel name that was ensured.
    pub name: String,
    /// Whether the channel was created by this call.
    pub created: bool,
    /// Whether the agent joined the channel during this call.
    pub joined: bool,
}

impl AgentClient {
    /// Create a new agent client with the given token.
    pub fn new(token: impl Into<String>, base_url: Option<String>) -> Result<Self> {
        let mut options = ClientOptions::new(token);
        if let Some(url) = base_url {
            options = options.with_base_url(url);
        }
        let client = HttpClient::new(options)?;
        Ok(Self { client, ws: None })
    }

    /// Create a new agent client from an existing HTTP client.
    pub(crate) fn from_client(client: HttpClient) -> Self {
        Self { client, ws: None }
    }

    /// Get a reference to the underlying HTTP client.
    pub fn http_client(&self) -> &HttpClient {
        &self.client
    }

    /// Replace the agent token for HTTP and WebSocket operations.
    pub async fn set_token(&mut self, token: impl Into<String>) -> Result<()> {
        let token = token.into();
        self.client = self.client.with_api_key(token.clone())?;
        if let Some(ws) = self.ws.as_ref() {
            ws.set_token(token).await;
        }
        Ok(())
    }

    /// Resolve this agent token to its authenticated agent identity.
    pub async fn me(&self) -> Result<Agent> {
        self.client.get("/v1/agent", None, None).await
    }

    // === WebSocket ===

    /// Connect to the WebSocket server for real-time events.
    pub async fn connect(&mut self) -> Result<()> {
        if self.ws.is_some() {
            return Ok(());
        }

        let mut options = WsClientOptions::new(self.client.api_key())
            .with_base_url(self.client.base_url())
            .with_origin(
                self.client.origin_surface(),
                self.client.origin_client(),
                self.client.origin_version(),
            );
        if let Some(origin_actor) = self.client.origin_actor() {
            options = options.with_origin_actor(origin_actor);
        }
        if let Some(id) = self.client.agent_relay_distinct_id() {
            options = options.with_agent_relay_distinct_id(id);
        }
        let mut ws = WsClient::new(options);
        ws.connect().await?;
        self.ws = Some(ws);
        Ok(())
    }

    /// Send a REST heartbeat to keep this agent online without a WebSocket ping.
    pub async fn heartbeat(&self) -> Result<()> {
        self.client
            .post::<serde_json::Value>("/v1/agents/heartbeat", Some(serde_json::json!({})), None)
            .await?;
        Ok(())
    }

    /// Disconnect from the WebSocket server.
    pub async fn disconnect(&mut self) {
        if self.ws.is_some() {
            // Keep parity with TypeScript SDK: best-effort REST disconnect before socket close.
            let _ = self
                .client
                .post::<serde_json::Value>(
                    "/v1/agents/disconnect",
                    Some(serde_json::json!({})),
                    None,
                )
                .await;
        }

        if let Some(ref mut ws) = self.ws {
            ws.disconnect().await;
        }
        self.ws = None;
    }

    /// Subscribe to receive WebSocket events.
    pub fn subscribe_events(&self) -> Result<EventReceiver> {
        self.ws
            .as_ref()
            .map(|ws| ws.subscribe_events())
            .ok_or(crate::error::RelayError::NotConnected)
    }

    /// Subscribe to lifecycle events such as connect/reconnect/close.
    pub fn subscribe_lifecycle(&self) -> Result<LifecycleReceiver> {
        self.ws
            .as_ref()
            .map(|ws| ws.subscribe_lifecycle())
            .ok_or(crate::error::RelayError::NotConnected)
    }

    /// Subscribe to channels for real-time updates.
    pub async fn subscribe_channels(&self, channels: Vec<String>) -> Result<()> {
        if let Some(ref ws) = self.ws {
            ws.subscribe(channels).await
        } else {
            Err(crate::error::RelayError::NotConnected)
        }
    }

    /// Unsubscribe from channels.
    pub async fn unsubscribe_channels(&self, channels: Vec<String>) -> Result<()> {
        if let Some(ref ws) = self.ws {
            ws.unsubscribe(channels).await
        } else {
            Err(crate::error::RelayError::NotConnected)
        }
    }

    // === Messages ===

    /// Send a message to a channel (defaults mode to `wait`).
    pub async fn send(
        &self,
        channel: &str,
        text: &str,
        attachments: Option<Vec<String>>,
        blocks: Option<Vec<MessageBlock>>,
        idempotency_key: Option<String>,
    ) -> Result<MessageWithMeta> {
        self.send_with_mode(
            channel,
            text,
            attachments,
            blocks,
            MessageInjectionMode::Wait,
            idempotency_key,
        )
        .await
    }

    /// Send a message to a channel with explicit injection mode.
    pub async fn send_with_mode(
        &self,
        channel: &str,
        text: &str,
        attachments: Option<Vec<String>>,
        blocks: Option<Vec<MessageBlock>>,
        mode: MessageInjectionMode,
        idempotency_key: Option<String>,
    ) -> Result<MessageWithMeta> {
        let name = strip_hash(channel);
        let body = PostMessageRequest {
            text: text.to_string(),
            attachments,
            blocks,
            data: None,
            mode: Some(mode),
        };
        let options = idempotency_key.map(RequestOptions::with_idempotency_key);
        self.client
            .post(
                &format!("/v1/channels/{}/messages", urlencoding::encode(name)),
                Some(body),
                options,
            )
            .await
    }

    /// Get messages from a channel.
    pub async fn messages(
        &self,
        channel: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<Vec<MessageWithMeta>> {
        let name = strip_hash(channel);
        let opts = opts.unwrap_or_default();

        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = opts.before {
            query_params.push(("before".to_string(), before));
        }
        if let Some(after) = opts.after {
            query_params.push(("after".to_string(), after));
        }

        let query: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client
            .get(
                &format!("/v1/channels/{}/messages", urlencoding::encode(name)),
                query_ref,
                None,
            )
            .await
    }

    /// Get a single message by ID.
    pub async fn message(&self, id: &str) -> Result<MessageWithMeta> {
        self.client
            .get(
                &format!("/v1/messages/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Reply to a message thread.
    pub async fn reply(
        &self,
        message_id: &str,
        text: &str,
        blocks: Option<Vec<MessageBlock>>,
        idempotency_key: Option<String>,
    ) -> Result<MessageWithMeta> {
        let body = ThreadReplyRequest {
            text: text.to_string(),
            blocks,
            data: None,
        };
        let options = idempotency_key.map(RequestOptions::with_idempotency_key);
        self.client
            .post(
                &format!("/v1/messages/{}/replies", urlencoding::encode(message_id)),
                Some(body),
                options,
            )
            .await
    }

    /// Get a thread (parent message and replies).
    pub async fn thread(
        &self,
        message_id: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<ThreadResponse> {
        let opts = opts.unwrap_or_default();

        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = opts.before {
            query_params.push(("before".to_string(), before));
        }
        if let Some(after) = opts.after {
            query_params.push(("after".to_string(), after));
        }

        let query: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client
            .get(
                &format!("/v1/messages/{}/replies", urlencoding::encode(message_id)),
                query_ref,
                None,
            )
            .await
    }

    // === DMs ===

    /// Send a direct message to another agent.
    pub async fn dm(
        &self,
        agent: &str,
        text: &str,
        opts: Option<DmOptions>,
    ) -> Result<serde_json::Value> {
        let opts = opts.unwrap_or_default();
        let body = SendDmRequest {
            to: agent.to_string(),
            text: text.to_string(),
            attachments: opts.attachments,
            mode: Some(opts.mode),
        };
        let options = opts
            .idempotency_key
            .map(RequestOptions::with_idempotency_key);
        self.client.post("/v1/dm", Some(body), options).await
    }

    /// Send a direct message to another agent (typed response).
    pub async fn dm_typed(
        &self,
        agent: &str,
        text: &str,
        opts: Option<DmOptions>,
    ) -> Result<DmSendResponse> {
        let opts = opts.unwrap_or_default();
        let body = SendDmRequest {
            to: agent.to_string(),
            text: text.to_string(),
            attachments: opts.attachments,
            mode: Some(opts.mode),
        };
        let options = opts
            .idempotency_key
            .map(RequestOptions::with_idempotency_key);
        self.client.post("/v1/dm", Some(body), options).await
    }

    /// Get DM conversations.
    pub async fn dm_conversations(&self) -> Result<Vec<DmConversationSummary>> {
        self.client.get("/v1/dm/conversations", None, None).await
    }

    /// Get messages from a DM conversation.
    pub async fn dm_messages(
        &self,
        conversation_id: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<Vec<MessageWithMeta>> {
        let opts = opts.unwrap_or_default();

        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = opts.before {
            query_params.push(("before".to_string(), before));
        }
        if let Some(after) = opts.after {
            query_params.push(("after".to_string(), after));
        }

        let query: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client
            .get(
                &format!("/v1/dm/{}/messages", urlencoding::encode(conversation_id)),
                query_ref,
                None,
            )
            .await
    }

    /// Get DM history for a conversation with a specific agent participant.
    ///
    /// Returns an empty vector when no matching conversation exists.
    pub async fn dm_messages_with_agent(
        &self,
        agent: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<Vec<MessageWithMeta>> {
        let target = agent.trim();
        if target.is_empty() {
            return Ok(vec![]);
        }

        let conversations = self.dm_conversations().await?;
        let Some(conversation) = conversations.into_iter().find(|conversation| {
            conversation
                .participants
                .iter()
                .any(|participant| participant.eq_ignore_ascii_case(target))
        }) else {
            return Ok(vec![]);
        };

        self.dm_messages(&conversation.id, opts).await
    }

    /// Create a group DM.
    pub async fn create_group_dm(
        &self,
        request: CreateGroupDmRequest,
    ) -> Result<serde_json::Value> {
        self.client.post("/v1/dm/group", Some(request), None).await
    }

    /// Create a group DM (typed response).
    pub async fn create_group_dm_typed(
        &self,
        request: CreateGroupDmRequest,
    ) -> Result<GroupDmConversationResponse> {
        self.client.post("/v1/dm/group", Some(request), None).await
    }

    /// Send a message to a DM conversation.
    pub async fn send_dm_message(
        &self,
        conversation_id: &str,
        text: &str,
        opts: Option<DmOptions>,
    ) -> Result<serde_json::Value> {
        let opts = opts.unwrap_or_default();
        let mut body = serde_json::Map::new();
        body.insert(
            "text".to_string(),
            serde_json::Value::String(text.to_string()),
        );
        body.insert(
            "mode".to_string(),
            serde_json::Value::String(match opts.mode {
                MessageInjectionMode::Wait => "wait".to_string(),
                MessageInjectionMode::Steer => "steer".to_string(),
            }),
        );
        if let Some(attachments) = opts.attachments {
            body.insert(
                "attachments".to_string(),
                serde_json::to_value(attachments)?,
            );
        }
        let options = opts
            .idempotency_key
            .map(RequestOptions::with_idempotency_key);
        self.client
            .post(
                &format!("/v1/dm/{}/messages", urlencoding::encode(conversation_id)),
                Some(body),
                options,
            )
            .await
    }

    /// Send a message to a DM conversation (typed response).
    pub async fn send_dm_message_typed(
        &self,
        conversation_id: &str,
        text: &str,
        opts: Option<DmOptions>,
    ) -> Result<GroupDmMessageResponse> {
        let opts = opts.unwrap_or_default();
        let mut body = serde_json::Map::new();
        body.insert(
            "text".to_string(),
            serde_json::Value::String(text.to_string()),
        );
        body.insert(
            "mode".to_string(),
            serde_json::Value::String(match opts.mode {
                MessageInjectionMode::Wait => "wait".to_string(),
                MessageInjectionMode::Steer => "steer".to_string(),
            }),
        );
        if let Some(attachments) = opts.attachments {
            body.insert(
                "attachments".to_string(),
                serde_json::to_value(attachments)?,
            );
        }
        let options = opts
            .idempotency_key
            .map(RequestOptions::with_idempotency_key);
        self.client
            .post(
                &format!("/v1/dm/{}/messages", urlencoding::encode(conversation_id)),
                Some(body),
                options,
            )
            .await
    }

    /// Add a participant to a group DM.
    pub async fn add_dm_participant(
        &self,
        conversation_id: &str,
        agent: &str,
    ) -> Result<serde_json::Value> {
        let body = serde_json::json!({ "agent_name": agent });
        self.client
            .post(
                &format!(
                    "/v1/dm/{}/participants",
                    urlencoding::encode(conversation_id)
                ),
                Some(body),
                None,
            )
            .await
    }

    /// Add a participant to a group DM (typed response).
    pub async fn add_dm_participant_typed(
        &self,
        conversation_id: &str,
        agent: &str,
    ) -> Result<GroupDmParticipantResponse> {
        let body = serde_json::json!({ "agent_name": agent });
        self.client
            .post(
                &format!(
                    "/v1/dm/{}/participants",
                    urlencoding::encode(conversation_id)
                ),
                Some(body),
                None,
            )
            .await
    }

    /// Remove a participant from a group DM.
    pub async fn remove_dm_participant(&self, conversation_id: &str, agent: &str) -> Result<()> {
        self.client
            .delete(
                &format!(
                    "/v1/dm/{}/participants/{}",
                    urlencoding::encode(conversation_id),
                    urlencoding::encode(agent)
                ),
                None,
            )
            .await
    }

    // === Channels ===

    /// Create a new channel.
    pub async fn create_channel(&self, request: CreateChannelRequest) -> Result<Channel> {
        self.client.post("/v1/channels", Some(request), None).await
    }

    /// Ensure a channel exists and this agent is a member.
    ///
    /// `409 Conflict` from either create or join is treated as success, which
    /// makes this safe to call during startup.
    pub async fn ensure_joined_channel(
        &self,
        request: CreateChannelRequest,
    ) -> Result<EnsureChannelOutcome> {
        let name = request.name.clone();
        let created = match self.create_channel(request).await {
            Ok(_) => true,
            Err(RelayError::Api { status: 409, .. }) => false,
            Err(error) => return Err(error),
        };

        let joined = match self.join_channel(&name).await {
            Ok(_) => true,
            Err(RelayError::Api { status: 409, .. }) => false,
            Err(error) => return Err(error),
        };

        Ok(EnsureChannelOutcome {
            name,
            created,
            joined,
        })
    }

    /// Ensure several channels exist and this agent is a member of each.
    pub async fn ensure_joined_channels<I>(&self, requests: I) -> Result<Vec<EnsureChannelOutcome>>
    where
        I: IntoIterator<Item = CreateChannelRequest>,
    {
        let mut outcomes = Vec::new();
        for request in requests {
            outcomes.push(self.ensure_joined_channel(request).await?);
        }
        Ok(outcomes)
    }

    /// List channels.
    pub async fn list_channels(&self, include_archived: bool) -> Result<Vec<Channel>> {
        let query = if include_archived {
            Some([("include_archived", "true")].as_slice())
        } else {
            None
        };
        self.client.get("/v1/channels", query, None).await
    }

    /// Get a channel by name.
    pub async fn get_channel(&self, name: &str) -> Result<ChannelWithMembers> {
        self.client
            .get(
                &format!("/v1/channels/{}", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// Join a channel.
    pub async fn join_channel(&self, name: &str) -> Result<serde_json::Value> {
        self.client
            .post(
                &format!("/v1/channels/{}/join", urlencoding::encode(name)),
                None::<()>,
                None,
            )
            .await
    }

    /// Leave a channel.
    pub async fn leave_channel(&self, name: &str) -> Result<()> {
        self.client
            .post::<()>(
                &format!("/v1/channels/{}/leave", urlencoding::encode(name)),
                None::<()>,
                None,
            )
            .await?;
        Ok(())
    }

    /// Set a channel's topic.
    pub async fn set_channel_topic(&self, name: &str, topic: &str) -> Result<Channel> {
        let body = serde_json::json!({ "topic": topic });
        self.client
            .patch(
                &format!("/v1/channels/{}/topic", urlencoding::encode(name)),
                Some(body),
                None,
            )
            .await
    }

    /// Archive a channel.
    pub async fn archive_channel(&self, name: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/channels/{}", urlencoding::encode(name)), None)
            .await
    }

    /// Invite an agent to a channel.
    pub async fn invite_to_channel(&self, channel: &str, agent: &str) -> Result<serde_json::Value> {
        let body = serde_json::json!({ "agent": agent });
        self.client
            .post(
                &format!("/v1/channels/{}/invite", urlencoding::encode(channel)),
                Some(body),
                None,
            )
            .await
    }

    /// Get channel members.
    pub async fn channel_members(&self, name: &str) -> Result<Vec<ChannelMemberInfo>> {
        self.client
            .get(
                &format!("/v1/channels/{}/members", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// Update a channel.
    pub async fn update_channel(
        &self,
        name: &str,
        request: UpdateChannelRequest,
    ) -> Result<Channel> {
        self.client
            .patch(
                &format!("/v1/channels/{}", urlencoding::encode(name)),
                Some(request),
                None,
            )
            .await
    }

    // === Reactions ===

    /// Add a reaction to a message.
    pub async fn react(&self, message_id: &str, emoji: &str) -> Result<serde_json::Value> {
        let body = serde_json::json!({ "emoji": emoji });
        self.client
            .post(
                &format!("/v1/messages/{}/reactions", urlencoding::encode(message_id)),
                Some(body),
                None,
            )
            .await
    }

    /// Remove a reaction from a message.
    pub async fn unreact(&self, message_id: &str, emoji: &str) -> Result<()> {
        self.client
            .delete(
                &format!(
                    "/v1/messages/{}/reactions/{}",
                    urlencoding::encode(message_id),
                    urlencoding::encode(emoji)
                ),
                None,
            )
            .await
    }

    /// Get reactions on a message.
    pub async fn reactions(&self, message_id: &str) -> Result<Vec<ReactionGroup>> {
        self.client
            .get(
                &format!("/v1/messages/{}/reactions", urlencoding::encode(message_id)),
                None,
                None,
            )
            .await
    }

    // === Search ===

    /// Search for messages.
    pub async fn search(
        &self,
        query: &str,
        opts: Option<SearchOptions>,
    ) -> Result<Vec<serde_json::Value>> {
        let opts = opts.unwrap_or_default();

        let mut query_params: Vec<(String, String)> = vec![("q".to_string(), query.to_string())];
        if let Some(channel) = opts.channel {
            query_params.push(("channel".to_string(), channel));
        }
        if let Some(from) = opts.from {
            query_params.push(("from".to_string(), from));
        }
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = opts.before {
            query_params.push(("before".to_string(), before));
        }
        if let Some(after) = opts.after {
            query_params.push(("after".to_string(), after));
        }

        let query_slice: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        self.client
            .get("/v1/search", Some(query_slice.as_slice()), None)
            .await
    }

    // === Inbox ===

    /// Get the agent's inbox.
    pub async fn inbox(&self) -> Result<InboxResponse> {
        self.client.get("/v1/inbox", None, None).await
    }

    // === Read Receipts ===

    /// Mark a message as read.
    pub async fn mark_read(&self, message_id: &str) -> Result<serde_json::Value> {
        self.client
            .post(
                &format!("/v1/messages/{}/read", urlencoding::encode(message_id)),
                None::<()>,
                None,
            )
            .await
    }

    /// Get readers of a message.
    pub async fn readers(&self, message_id: &str) -> Result<Vec<ReaderInfo>> {
        self.client
            .get(
                &format!("/v1/messages/{}/readers", urlencoding::encode(message_id)),
                None,
                None,
            )
            .await
    }

    /// Get read status for a channel.
    pub async fn read_status(&self, channel: &str) -> Result<Vec<ChannelReadStatus>> {
        let name = strip_hash(channel);
        self.client
            .get(
                &format!("/v1/channels/{}/read-status", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    // === Durable Delivery ===

    /// List durable delivery items queued for this agent.
    ///
    /// Defaults to the non-terminal replay queue (`accepted` + `deferred`) when
    /// no status is provided. Each item carries the associated message payload.
    pub async fn deliveries(
        &self,
        opts: Option<ListDeliveriesOptions>,
    ) -> Result<Vec<DeliveryItem>> {
        let opts = opts.unwrap_or_default();

        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(status) = opts.status {
            if let Some(status) = status.as_query_value() {
                query_params.push(("status".to_string(), status.to_string()));
            }
        }
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }

        let query: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client.get("/v1/deliveries", query_ref, None).await
    }

    /// Idempotently acknowledge a delivery, transitioning it to `delivered`.
    pub async fn ack_delivery(&self, delivery_id: &str) -> Result<Delivery> {
        self.client
            .post(
                &format!("/v1/deliveries/{}/ack", urlencoding::encode(delivery_id)),
                None::<()>,
                None,
            )
            .await
    }

    /// Idempotently record a delivery as `failed`.
    pub async fn fail_delivery(
        &self,
        delivery_id: &str,
        request: Option<FailDeliveryRequest>,
    ) -> Result<Delivery> {
        self.client
            .post(
                &format!("/v1/deliveries/{}/fail", urlencoding::encode(delivery_id)),
                Some(request.unwrap_or_default()),
                None,
            )
            .await
    }

    /// Idempotently defer a delivery until `available_at`.
    pub async fn defer_delivery(
        &self,
        delivery_id: &str,
        request: DeferDeliveryRequest,
    ) -> Result<Delivery> {
        self.client
            .post(
                &format!("/v1/deliveries/{}/defer", urlencoding::encode(delivery_id)),
                Some(request),
                None,
            )
            .await
    }

    // === Files ===

    /// Request a file upload.
    pub async fn upload_file(&self, request: UploadRequest) -> Result<UploadResponse> {
        self.client
            .post("/v1/files/upload", Some(request), None)
            .await
    }

    /// Complete a file upload.
    pub async fn complete_upload(&self, file_id: &str) -> Result<FileInfo> {
        self.client
            .post(
                &format!("/v1/files/{}/complete", urlencoding::encode(file_id)),
                None::<()>,
                None,
            )
            .await
    }

    /// Get file info.
    pub async fn get_file(&self, file_id: &str) -> Result<FileInfo> {
        self.client
            .get(
                &format!("/v1/files/{}", urlencoding::encode(file_id)),
                None,
                None,
            )
            .await
    }

    /// Delete a file.
    pub async fn delete_file(&self, file_id: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/files/{}", urlencoding::encode(file_id)), None)
            .await
    }

    /// List files.
    pub async fn list_files(&self, opts: Option<FileListOptions>) -> Result<Vec<FileInfo>> {
        let opts = opts.unwrap_or_default();

        let mut query_params: Vec<(String, String)> = Vec::new();
        if let Some(uploaded_by) = opts.uploaded_by {
            query_params.push(("uploaded_by".to_string(), uploaded_by));
        }
        if let Some(limit) = opts.limit {
            query_params.push(("limit".to_string(), limit.to_string()));
        }

        let query: Vec<(&str, &str)> = query_params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client.get("/v1/files", query_ref, None).await
    }

    // === Actions (agent-to-agent RPC) ===

    /// Invoke a registered action. The handler agent receives an `action.invoked`
    /// event; the returned invocation id can be polled with [`Self::get_action_invocation`].
    pub async fn invoke_action(
        &self,
        name: &str,
        input: Option<serde_json::Map<String, serde_json::Value>>,
    ) -> Result<InvokeActionResult> {
        self.client
            .post(
                &format!("/v1/actions/{}/invoke", urlencoding::encode(name)),
                Some(InvokeActionRequest { input }),
                None,
            )
            .await
    }

    /// As the handler agent, report the result (or error) of an invocation.
    pub async fn complete_action_invocation(
        &self,
        name: &str,
        invocation_id: &str,
        request: CompleteInvocationRequest,
    ) -> Result<ActionInvocation> {
        self.client
            .post(
                &format!(
                    "/v1/actions/{}/invocations/{}/complete",
                    urlencoding::encode(name),
                    urlencoding::encode(invocation_id)
                ),
                Some(request),
                None,
            )
            .await
    }

    /// Get the status and result of an action invocation.
    pub async fn get_action_invocation(
        &self,
        name: &str,
        invocation_id: &str,
    ) -> Result<ActionInvocation> {
        self.client
            .get(
                &format!(
                    "/v1/actions/{}/invocations/{}",
                    urlencoding::encode(name),
                    urlencoding::encode(invocation_id)
                ),
                None,
                None,
            )
            .await
    }
}
