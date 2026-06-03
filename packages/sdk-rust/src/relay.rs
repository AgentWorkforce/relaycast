//! Main RelayCast client for workspace-level operations.

use crate::agent::AgentClient;
use crate::client::{ClientOptions, HttpClient};
use crate::error::{RelayError, Result};
use crate::types::*;

const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_BASE_URL: &str = "https://gateway.relaycast.dev";
const DEFAULT_ORIGIN_SURFACE: &str = "sdk";
const DEFAULT_ORIGIN_CLIENT: &str = "@relaycast/sdk-rust";

fn strip_hash(channel: &str) -> &str {
    channel.strip_prefix('#').unwrap_or(channel)
}

/// Options for creating a RelayCast client.
#[derive(Debug, Clone)]
pub struct RelayCastOptions {
    /// The API key for authentication.
    pub api_key: String,
    /// The base URL for the API (defaults to https://gateway.relaycast.dev).
    ///
    /// To self-host, run the engine (`relaycast-engine`, default port 8787) and
    /// set this to e.g. `http://localhost:8787`.
    pub base_url: Option<String>,
    /// User-Agent-style identifier for the harness driving requests
    /// (e.g. `"claude-code/2.3 (model=opus-4.8)"`, `"codex"`, `"human"`). Sent as
    /// the `X-Relaycast-Harness` header so server-side telemetry can attribute
    /// traffic. Invalid values are dropped.
    pub harness: Option<String>,
    /// Agent Relay distinct telemetry id. Sent as
    /// `X-Agent-Relay-Distinct-Id` on HTTP requests; invalid values are dropped.
    pub agent_relay_distinct_id: Option<String>,
}

impl RelayCastOptions {
    /// Create new options with the given API key.
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: None,
            harness: None,
            agent_relay_distinct_id: None,
        }
    }

    /// Set a custom base URL.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Set the harness identifier sent as the `X-Relaycast-Harness` header.
    pub fn with_harness(mut self, harness: impl Into<String>) -> Self {
        self.harness = Some(harness.into());
        self
    }

    /// Set Agent Relay's distinct telemetry id.
    pub fn with_agent_relay_distinct_id(mut self, id: impl Into<String>) -> Self {
        self.agent_relay_distinct_id = Some(id.into());
        self
    }
}

/// Main client for RelayCast workspace operations.
#[derive(Clone)]
pub struct RelayCast {
    client: HttpClient,
}

impl RelayCast {
    /// Create a new RelayCast client with the given options.
    pub fn new(options: RelayCastOptions) -> Result<Self> {
        if options.api_key.trim().is_empty() {
            return Err(RelayError::InvalidResponse(
                "RelayCast api_key is required".to_string(),
            ));
        }

        let base_url = options
            .base_url
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());

        let mut client_options = ClientOptions::new(options.api_key);
        client_options = client_options.with_base_url(base_url);
        if let Some(harness) = options.harness {
            client_options = client_options.with_harness(harness);
        }
        if let Some(id) = options.agent_relay_distinct_id {
            client_options = client_options.with_agent_relay_distinct_id(id);
        }
        let client = HttpClient::new(client_options)?;
        Ok(Self { client })
    }

    /// Create a new workspace.
    pub async fn create_workspace(
        name: &str,
        base_url: Option<&str>,
    ) -> Result<CreateWorkspaceResponse> {
        let url = format!("{}/v1/workspaces", base_url.unwrap_or(DEFAULT_BASE_URL));

        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("X-SDK-Version", SDK_VERSION)
            .header("X-Relaycast-Origin-Surface", DEFAULT_ORIGIN_SURFACE)
            .header("X-Relaycast-Origin-Client", DEFAULT_ORIGIN_CLIENT)
            .header("X-Relaycast-Origin-Version", SDK_VERSION)
            .json(&serde_json::json!({ "name": name }))
            .send()
            .await?;

        let status = response.status().as_u16();
        let json: ApiResponse<CreateWorkspaceResponse> = response.json().await?;

        if !json.ok {
            let error = json.error.unwrap_or_else(|| ApiErrorInfo {
                code: "unknown_error".to_string(),
                message: "Unknown error".to_string(),
            });
            return Err(RelayError::api(error.code, error.message, status));
        }

        json.data
            .ok_or_else(|| RelayError::InvalidResponse("Response missing data field".to_string()))
    }

    /// Create an agent client for the given agent token.
    pub fn as_agent(&self, agent_token: impl Into<String>) -> Result<AgentClient> {
        let client = self.client.with_api_key(agent_token)?;
        Ok(AgentClient::from_client(client))
    }

    /// Rehydrate an agent client from a persisted agent token, validating it first.
    pub async fn reconnect_agent(&self, agent_token: impl Into<String>) -> Result<AgentClient> {
        let agent = self.as_agent(agent_token)?;
        agent.me().await?;
        Ok(agent)
    }

    // === Workspace ===

    /// Get workspace information.
    pub async fn workspace_info(&self) -> Result<Workspace> {
        self.client.get("/v1/workspace", None, None).await
    }

    /// Update workspace settings.
    pub async fn update_workspace(&self, request: UpdateWorkspaceRequest) -> Result<Workspace> {
        self.client
            .patch("/v1/workspace", Some(request), None)
            .await
    }

    /// Delete the workspace.
    pub async fn delete_workspace(&self) -> Result<()> {
        self.client.delete("/v1/workspace", None).await
    }

    /// Get effective workspace stream configuration.
    pub async fn workspace_stream_get(&self) -> Result<WorkspaceStreamConfig> {
        self.client.get("/v1/workspace/stream", None, None).await
    }

    /// Set workspace stream override.
    pub async fn workspace_stream_set(&self, enabled: bool) -> Result<WorkspaceStreamConfig> {
        self.client
            .put(
                "/v1/workspace/stream",
                Some(serde_json::json!({ "enabled": enabled })),
                None,
            )
            .await
    }

    /// Clear workspace stream override and inherit default behavior.
    pub async fn workspace_stream_inherit(&self) -> Result<WorkspaceStreamConfig> {
        self.client
            .put(
                "/v1/workspace/stream",
                Some(serde_json::json!({ "mode": "inherit" })),
                None,
            )
            .await
    }

    // === System Prompt ===

    /// Get the workspace system prompt.
    pub async fn get_system_prompt(&self) -> Result<SystemPrompt> {
        self.client
            .get("/v1/workspace/system-prompt", None, None)
            .await
    }

    /// Set the workspace system prompt.
    pub async fn set_system_prompt(&self, request: SetSystemPromptRequest) -> Result<SystemPrompt> {
        self.client
            .put("/v1/workspace/system-prompt", Some(request), None)
            .await
    }

    // === Channels ===

    /// List channels in the workspace.
    pub async fn list_channels(&self, include_archived: bool) -> Result<Vec<Channel>> {
        let query = if include_archived {
            Some([("include_archived", "true")].as_slice())
        } else {
            None
        };
        self.client.get("/v1/channels", query, None).await
    }

    /// Get a channel and its members by name.
    pub async fn get_channel(&self, name: &str) -> Result<ChannelWithMembers> {
        self.client
            .get(
                &format!("/v1/channels/{}", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    // === Messages ===

    /// List messages in a channel.
    pub async fn list_messages(
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
    pub async fn get_message(&self, id: &str) -> Result<MessageWithMeta> {
        self.client
            .get(
                &format!("/v1/messages/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Get a message thread (parent and replies).
    pub async fn get_thread(
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

    /// Get grouped reactions for a message.
    pub async fn get_message_reactions(&self, id: &str) -> Result<Vec<ReactionGroup>> {
        self.client
            .get(
                &format!("/v1/messages/{}/reactions", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    // === Agents ===

    /// Register a new agent.
    pub async fn register_agent(&self, request: CreateAgentRequest) -> Result<CreateAgentResponse> {
        self.client.post("/v1/agents", Some(request), None).await
    }

    /// Resolve an agent token to its authenticated agent identity.
    pub async fn get_current_agent(&self, agent_token: impl Into<String>) -> Result<Agent> {
        self.client
            .with_api_key(agent_token)?
            .get("/v1/agent", None, None)
            .await
    }

    /// List agents.
    pub async fn list_agents(&self, query: Option<AgentListQuery>) -> Result<Vec<Agent>> {
        let query = query.unwrap_or_default();
        let params: Vec<(String, String)> = query
            .status
            .map(|s| vec![("status".to_string(), s)])
            .unwrap_or_default();

        let query_slice: Vec<(&str, &str)> = params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();

        let query_ref = if query_slice.is_empty() {
            None
        } else {
            Some(query_slice.as_slice())
        };

        self.client.get("/v1/agents", query_ref, None).await
    }

    /// Get an agent by name.
    pub async fn get_agent(&self, name: &str) -> Result<Agent> {
        self.client
            .get(
                &format!("/v1/agents/{}", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// Rotate an agent's token.
    pub async fn rotate_agent_token(&self, name: &str) -> Result<TokenRotateResponse> {
        self.client
            .post(
                &format!("/v1/agents/{}/rotate-token", urlencoding::encode(name)),
                Some(serde_json::json!({})),
                None,
            )
            .await
    }

    /// Update an agent.
    pub async fn update_agent(&self, name: &str, request: UpdateAgentRequest) -> Result<Agent> {
        self.client
            .patch(
                &format!("/v1/agents/{}", urlencoding::encode(name)),
                Some(request),
                None,
            )
            .await
    }

    /// Delete an agent.
    pub async fn delete_agent(&self, name: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/agents/{}", urlencoding::encode(name)), None)
            .await
    }

    /// Get agent presence information.
    pub async fn agent_presence(&self) -> Result<Vec<AgentPresenceInfo>> {
        self.client.get("/v1/agents/presence", None, None).await
    }

    /// Register an agent or get existing one (with token rotation).
    pub async fn register_or_get_agent(
        &self,
        request: CreateAgentRequest,
    ) -> Result<CreateAgentResponse> {
        match self.register_agent(request.clone()).await {
            Ok(response) => Ok(response),
            Err(RelayError::Api { code, status, .. })
                if code == "agent_already_exists" || status == 409 =>
            {
                let agent = self.get_agent(&request.name).await?;
                let token_response = self.rotate_agent_token(&agent.name).await?;
                let created_at = agent.created_at.or(agent.last_seen).unwrap_or_default();
                Ok(CreateAgentResponse {
                    id: agent.id,
                    name: agent.name,
                    token: token_response.token,
                    status: agent.status,
                    created_at,
                })
            }
            Err(e) => Err(e),
        }
    }

    /// Spawn an agent process (registering if needed).
    pub async fn spawn_agent(&self, request: SpawnAgentRequest) -> Result<SpawnAgentResponse> {
        self.client
            .post("/v1/agents/spawn", Some(request), None)
            .await
    }

    /// Release an agent process (optionally deleting the agent).
    pub async fn release_agent(
        &self,
        request: ReleaseAgentRequest,
    ) -> Result<ReleaseAgentResponse> {
        self.client
            .post("/v1/agents/release", Some(request), None)
            .await
    }

    // === Webhooks ===

    /// Create a webhook.
    pub async fn create_webhook(
        &self,
        request: CreateWebhookRequest,
    ) -> Result<CreateWebhookResponse> {
        self.client.post("/v1/webhooks", Some(request), None).await
    }

    /// Create an inbound webhook.
    pub async fn create_inbound_webhook(
        &self,
        request: CreateWebhookRequest,
    ) -> Result<CreateWebhookResponse> {
        self.create_webhook(request).await
    }

    /// List webhooks.
    pub async fn list_webhooks(&self) -> Result<Vec<Webhook>> {
        self.client.get("/v1/webhooks", None, None).await
    }

    /// Delete a webhook.
    pub async fn delete_webhook(&self, id: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/webhooks/{}", urlencoding::encode(id)), None)
            .await
    }

    /// Trigger a webhook with its per-webhook bearer token.
    pub async fn trigger_webhook(
        &self,
        webhook_id: &str,
        request: WebhookTriggerRequest,
        token: impl Into<String>,
    ) -> Result<WebhookTriggerResponse> {
        self.client
            .with_api_key(token)?
            .post(
                &format!("/v1/hooks/{}", urlencoding::encode(webhook_id)),
                Some(request),
                None,
            )
            .await
    }

    /// Trigger a webhook with its per-webhook bearer token.
    pub async fn trigger_webhook_with_token(
        &self,
        webhook_id: &str,
        request: WebhookTriggerRequest,
        token: impl Into<String>,
    ) -> Result<WebhookTriggerResponse> {
        self.trigger_webhook(webhook_id, request, token).await
    }

    // === Subscriptions ===

    /// Create an event subscription.
    pub async fn create_subscription(
        &self,
        request: CreateSubscriptionRequest,
    ) -> Result<CreateSubscriptionResponse> {
        self.client
            .post("/v1/subscriptions", Some(request), None)
            .await
    }

    /// List event subscriptions.
    pub async fn list_subscriptions(&self) -> Result<Vec<EventSubscription>> {
        self.client.get("/v1/subscriptions", None, None).await
    }

    /// Get an event subscription.
    pub async fn get_subscription(&self, id: &str) -> Result<EventSubscription> {
        self.client
            .get(
                &format!("/v1/subscriptions/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Delete an event subscription.
    pub async fn delete_subscription(&self, id: &str) -> Result<()> {
        self.client
            .delete(
                &format!("/v1/subscriptions/{}", urlencoding::encode(id)),
                None,
            )
            .await
    }

    // === Actions (agent-to-agent RPC) ===

    /// Register an action (async agent-to-agent RPC). Replaces the legacy command API.
    pub async fn register_action(
        &self,
        request: RegisterActionRequest,
    ) -> Result<ActionDefinition> {
        self.client.post("/v1/actions", Some(request), None).await
    }

    /// List registered actions.
    pub async fn list_actions(&self) -> Result<Vec<ActionDefinition>> {
        self.client.get("/v1/actions", None, None).await
    }

    /// Get a single action by name.
    pub async fn get_action(&self, name: &str) -> Result<ActionDefinition> {
        self.client
            .get(
                &format!("/v1/actions/{}", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// Delete an action.
    pub async fn delete_action(&self, name: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/actions/{}", urlencoding::encode(name)), None)
            .await
    }

    // === Agent session events ===

    /// Emit a session event for an agent (e.g. `status.active`).
    pub async fn emit_agent_event(
        &self,
        name: &str,
        request: EmitSessionEventRequest,
    ) -> Result<SessionEvent> {
        self.client
            .post(
                &format!("/v1/agents/{}/events", urlencoding::encode(name)),
                Some(request),
                None,
            )
            .await
    }

    /// List recorded session events for an agent.
    pub async fn list_agent_events(
        &self,
        name: &str,
        query: Option<ListSessionEventsQuery>,
    ) -> Result<Vec<SessionEvent>> {
        let query = query.unwrap_or_default();
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(event_type) = query.event_type {
            params.push(("type".to_string(), event_type));
        }
        if let Some(limit) = query.limit {
            params.push(("limit".to_string(), limit.to_string()));
        }

        let slice: Vec<(&str, &str)> = params
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let query_ref = if slice.is_empty() {
            None
        } else {
            Some(slice.as_slice())
        };

        self.client
            .get(
                &format!("/v1/agents/{}/events", urlencoding::encode(name)),
                query_ref,
                None,
            )
            .await
    }

    // === Stats & Activity ===

    /// Get workspace statistics.
    pub async fn stats(&self) -> Result<WorkspaceStats> {
        self.client.get("/v1/workspace/stats", None, None).await
    }

    /// Get recent activity.
    pub async fn activity(&self, limit: Option<i32>) -> Result<Vec<ActivityItem>> {
        let limit_str = limit.map(|l| l.to_string());
        let query: Vec<(&str, &str)> = limit_str
            .as_ref()
            .map(|l| vec![("limit", l.as_str())])
            .unwrap_or_default();

        let query_ref = if query.is_empty() {
            None
        } else {
            Some(query.as_slice())
        };

        self.client.get("/v1/activity", query_ref, None).await
    }

    /// Get all DM conversations in the workspace.
    pub async fn all_dm_conversations(&self) -> Result<Vec<WorkspaceDmConversation>> {
        self.client
            .get("/v1/dm/conversations/all", None, None)
            .await
    }

    /// Resolve participants for a workspace DM conversation.
    pub async fn dm_conversation_participants(&self, conversation_id: &str) -> Result<Vec<String>> {
        let target = conversation_id.trim();
        if target.is_empty() {
            return Ok(vec![]);
        }

        let conversations = self.all_dm_conversations().await?;
        Ok(conversations
            .into_iter()
            .find(|conversation| conversation.id == target)
            .map(|conversation| conversation.participants)
            .unwrap_or_default())
    }

    /// Get DM messages for a workspace conversation.
    pub async fn dm_messages(
        &self,
        conversation_id: &str,
        opts: Option<MessageListQuery>,
    ) -> Result<Vec<WorkspaceDmMessage>> {
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
                &format!(
                    "/v1/dm/conversations/{}/messages",
                    urlencoding::encode(conversation_id)
                ),
                query_ref,
                None,
            )
            .await
    }
}
