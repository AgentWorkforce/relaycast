//! Main RelayCast client for workspace-level operations.

use crate::agent::AgentClient;
use crate::client::{ClientOptions, HttpClient};
use crate::error::{RelayError, Result};
use crate::types::*;

use crate::DEFAULT_BASE_URL;

const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_ORIGIN_CLIENT: &str = "@relaycast/sdk-rust";

fn strip_hash(channel: &str) -> &str {
    channel.strip_prefix('#').unwrap_or(channel)
}

/// Options for creating a RelayCast client.
#[derive(Debug, Clone)]
pub struct RelayCastOptions {
    /// The API key for authentication.
    pub api_key: String,
    /// The base URL for the API (defaults to https://cast.agentrelay.com).
    ///
    /// To self-host, run the engine (`relaycast-engine`, default port 8787) and
    /// set this to e.g. `http://localhost:8787`.
    pub base_url: Option<String>,
    /// User-Agent-style identifier for the origin_actor driving requests
    /// (e.g. `"claude-code/2.3 (model=opus-4.8)"`, `"codex"`, `"human"`). Sent as
    /// the `X-Relaycast-Origin-Actor` header so server-side telemetry can attribute
    /// traffic. Invalid values are dropped.
    pub origin_actor: Option<String>,
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
            origin_actor: None,
            agent_relay_distinct_id: None,
        }
    }

    /// Set a custom base URL.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Set the origin_actor identifier sent as the `X-Relaycast-Origin-Actor` header.
    pub fn with_origin_actor(mut self, origin_actor: impl Into<String>) -> Self {
        self.origin_actor = Some(origin_actor.into());
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
        if let Some(origin_actor) = options.origin_actor {
            client_options = client_options.with_origin_actor(origin_actor);
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
        Self::create_workspace_with_authority(name, base_url, None).await
    }

    /// Create a new workspace with a RelayAuth sponsor grant.
    pub async fn create_workspace_with_authority(
        name: &str,
        base_url: Option<&str>,
        registration_authority: Option<WorkspaceRegistrationAuthority>,
    ) -> Result<CreateWorkspaceResponse> {
        let url = format!("{}/v1/workspaces", base_url.unwrap_or(DEFAULT_BASE_URL));

        let client = reqwest::Client::new();
        let mut body = serde_json::json!({ "name": name });
        if let Some(authority) = registration_authority {
            body.as_object_mut()
                .expect("workspace request is an object")
                .insert(
                    "registration_authority".to_string(),
                    serde_json::to_value(authority)?,
                );
        }

        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("X-SDK-Version", SDK_VERSION)
            .header("X-Relaycast-Origin-Client", DEFAULT_ORIGIN_CLIENT)
            .header("X-Relaycast-Origin-Version", SDK_VERSION)
            .json(&body)
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

    // === Observer Tokens ===

    /// Create a scoped observer token. The raw token is returned only from this
    /// response and rotate responses.
    pub async fn create_observer_token(
        &self,
        request: CreateObserverTokenRequest,
    ) -> Result<ObserverToken> {
        self.client
            .post("/v1/observer-tokens", Some(request), None)
            .await
    }

    /// List observer tokens without returning token material.
    pub async fn list_observer_tokens(&self) -> Result<Vec<ObserverToken>> {
        self.client.get("/v1/observer-tokens", None, None).await
    }

    /// Get observer token metadata by id.
    pub async fn get_observer_token(&self, id: &str) -> Result<ObserverToken> {
        self.client
            .get(
                &format!("/v1/observer-tokens/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Update observer token scopes, filters, or metadata.
    pub async fn update_observer_token(
        &self,
        id: &str,
        request: UpdateObserverTokenRequest,
    ) -> Result<ObserverToken> {
        self.client
            .patch(
                &format!("/v1/observer-tokens/{}", urlencoding::encode(id)),
                Some(request),
                None,
            )
            .await
    }

    /// Rotate an observer token and return the new token material.
    pub async fn rotate_observer_token(&self, id: &str) -> Result<ObserverToken> {
        self.client
            .post(
                &format!("/v1/observer-tokens/{}/rotate", urlencoding::encode(id)),
                Some(serde_json::json!({})),
                None,
            )
            .await
    }

    /// Revoke an observer token.
    pub async fn revoke_observer_token(&self, id: &str) -> Result<()> {
        self.client
            .delete(
                &format!("/v1/observer-tokens/{}", urlencoding::encode(id)),
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

    /// Register an agent with server-verified sponsor/work-unit authority.
    pub async fn register_agent_with_authority(
        &self,
        request: CreateAgentRequest,
        registration_authority: AgentRegistrationAuthority,
    ) -> Result<CreateAgentResponse> {
        let mut body = serde_json::to_value(request)?;
        body.as_object_mut()
            .ok_or_else(|| {
                RelayError::InvalidResponse(
                    "agent request did not serialize to an object".to_string(),
                )
            })?
            .insert(
                "registration_authority".to_string(),
                serde_json::to_value(registration_authority)?,
            );
        self.client.post("/v1/agents", Some(body), None).await
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

    /// Rotate an agent token with server-verified sponsor/work-unit authority.
    pub async fn rotate_agent_token_with_authority(
        &self,
        name: &str,
        registration_authority: AgentRegistrationAuthority,
    ) -> Result<TokenRotateResponse> {
        self.client
            .post(
                &format!("/v1/agents/{}/rotate-token", urlencoding::encode(name)),
                Some(serde_json::json!({ "registration_authority": registration_authority })),
                None,
            )
            .await
    }

    /// One-time legacy migration, authenticated by the incumbent agent token.
    pub async fn bind_agent_credential_authority(
        &self,
        agent_token: impl Into<String>,
        registration_authority: AgentRegistrationAuthority,
    ) -> Result<()> {
        let client = self.client.with_api_key(agent_token)?;
        let _: serde_json::Value = client
            .post(
                "/v1/agent/credential-authority",
                Some(serde_json::json!({ "registration_authority": registration_authority })),
                None,
            )
            .await?;
        Ok(())
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

    /// Delete an agent with server-verified sponsor/work-unit authority.
    pub async fn delete_agent_with_authority(
        &self,
        name: &str,
        registration_authority: AgentRegistrationAuthority,
    ) -> Result<()> {
        self.client
            .delete_with_body(
                &format!("/v1/agents/{}", urlencoding::encode(name)),
                serde_json::json!({ "registration_authority": registration_authority }),
                None,
            )
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
                    workspace_id: agent.workspace_id,
                    name: agent.name,
                    token: token_response.token,
                    status: agent.status,
                    created_at,
                })
            }
            Err(e) => Err(e),
        }
    }

    /// Register or rotate using the same verified authority on both paths.
    pub async fn register_or_get_agent_with_authority(
        &self,
        request: CreateAgentRequest,
        registration_authority: AgentRegistrationAuthority,
    ) -> Result<CreateAgentResponse> {
        match self
            .register_agent_with_authority(request.clone(), registration_authority.clone())
            .await
        {
            Ok(response) => Ok(response),
            Err(RelayError::Api { code, status, .. })
                if code == "agent_already_exists" || status == 409 =>
            {
                let agent = self.get_agent(&request.name).await?;
                let token_response = self
                    .rotate_agent_token_with_authority(&agent.name, registration_authority)
                    .await?;
                let created_at = agent.created_at.or(agent.last_seen).unwrap_or_default();
                Ok(CreateAgentResponse {
                    id: agent.id,
                    workspace_id: agent.workspace_id,
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

    /// Release an agent with server-verified authority for destructive deletion.
    pub async fn release_agent_with_authority(
        &self,
        request: ReleaseAgentRequest,
        registration_authority: AgentRegistrationAuthority,
    ) -> Result<ReleaseAgentResponse> {
        let mut body = serde_json::to_value(request)?;
        body.as_object_mut()
            .ok_or_else(|| {
                RelayError::InvalidResponse(
                    "release request did not serialize to an object".to_string(),
                )
            })?
            .insert(
                "registration_authority".to_string(),
                serde_json::to_value(registration_authority)?,
            );
        self.client
            .post("/v1/agents/release", Some(body), None)
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
        self.client.get("/v1/console/stats", None, None).await
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

    // === Workspace bootstrap ===

    /// Look up a workspace by name. Returns `None` when no workspace matches.
    pub async fn lookup_workspace(
        name: &str,
        base_url: Option<&str>,
    ) -> Result<Option<WorkspaceLookup>> {
        let url = format!(
            "{}/v1/workspaces/by-name/{}",
            base_url.unwrap_or(DEFAULT_BASE_URL),
            urlencoding::encode(name)
        );

        let client = reqwest::Client::new();
        let response = client
            .get(&url)
            .header("Content-Type", "application/json")
            .header("X-SDK-Version", SDK_VERSION)
            .header("X-Relaycast-Origin-Client", DEFAULT_ORIGIN_CLIENT)
            .header("X-Relaycast-Origin-Version", SDK_VERSION)
            .send()
            .await?;

        let status = response.status().as_u16();
        let json: ApiResponse<WorkspaceLookup> = response.json().await?;

        if !json.ok {
            if status == 404 {
                return Ok(None);
            }
            let error = json.error.unwrap_or_else(|| ApiErrorInfo {
                code: "unknown_error".to_string(),
                message: "Unknown error".to_string(),
            });
            return Err(RelayError::api(error.code, error.message, status));
        }

        json.data
            .map(Some)
            .ok_or_else(|| RelayError::InvalidResponse("Response missing data field".to_string()))
    }

    // === A2A (agent-to-agent bridge) ===

    /// Register an A2A agent bridge.
    pub async fn register_a2a(&self, options: RegisterA2aOptions) -> Result<RegisterA2aResponse> {
        self.client
            .post("/v1/a2a/register", Some(options), None)
            .await
    }

    /// List registered A2A agents.
    pub async fn list_a2a_agents(&self) -> Result<Vec<A2aAgentRecord>> {
        self.client.get("/v1/a2a/agents", None, None).await
    }

    /// Remove an A2A agent by name.
    pub async fn remove_a2a_agent(&self, name: &str) -> Result<RemoveA2aAgentResponse> {
        self.client
            .request(
                reqwest::Method::DELETE,
                &format!("/v1/a2a/agents/{}", urlencoding::encode(name)),
                None::<()>,
                None,
                None,
            )
            .await
    }

    /// Fetch the agent card for an A2A agent.
    pub async fn get_a2a_agent_card(&self, name: &str) -> Result<A2aAgentCard> {
        self.client
            .get(
                &format!("/v1/a2a/agents/{}/card", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    // === Routing ===

    /// Route a skill (and optional message) to the best candidate agent.
    pub async fn route(&self, skill: &str, message: Option<&str>) -> Result<RouteResult> {
        self.client
            .post(
                "/v1/route",
                Some(serde_json::json!({ "skill": skill, "message": message })),
                None,
            )
            .await
    }

    /// Report route feedback (success/failure) for a routed agent.
    pub async fn route_feedback(
        &self,
        request: RouteFeedbackRequest,
    ) -> Result<RouteFeedbackResult> {
        self.client
            .post("/v1/route/feedback", Some(request), None)
            .await
    }

    /// Get the workspace routing configuration.
    pub async fn get_routing_config(&self) -> Result<RoutingConfig> {
        self.client.get("/v1/routing/config", None, None).await
    }

    /// Update the workspace routing configuration.
    pub async fn update_routing_config(
        &self,
        request: UpdateRoutingConfigRequest,
    ) -> Result<RoutingConfig> {
        self.client
            .put("/v1/routing/config", Some(request), None)
            .await
    }

    // === Directory ===

    /// Search the agent directory.
    pub async fn search_directory(
        &self,
        query: SearchDirectoryQuery,
    ) -> Result<Vec<DirectorySearchResult>> {
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(q) = query.q {
            params.push(("q".to_string(), q));
        }
        if let Some(tags) = query.tags {
            if !tags.is_empty() {
                params.push(("tags".to_string(), tags.join(",")));
            }
        }
        if let Some(status) = query.status {
            params.push(("status".to_string(), status));
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
            .get("/v1/directory/search", query_ref, None)
            .await
    }

    /// Publish an agent to the directory.
    pub async fn publish_to_directory(
        &self,
        request: PublishToDirectoryRequest,
    ) -> Result<DirectoryAgent> {
        self.client
            .post("/v1/directory/agents", Some(request), None)
            .await
    }

    /// List directory agents.
    pub async fn list_directory(
        &self,
        query: Option<ListDirectoryQuery>,
    ) -> Result<Vec<DirectoryAgent>> {
        let query = query.unwrap_or_default();
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(status) = query.status {
            params.push(("status".to_string(), status));
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
            .get("/v1/directory/agents", query_ref, None)
            .await
    }

    /// Get a directory agent by slug.
    pub async fn get_directory_agent(&self, slug: &str) -> Result<DirectoryAgent> {
        self.client
            .get(
                &format!("/v1/directory/agents/{}", urlencoding::encode(slug)),
                None,
                None,
            )
            .await
    }

    /// Update a directory agent.
    pub async fn update_directory_agent(
        &self,
        slug: &str,
        request: UpdateDirectoryAgentRequest,
    ) -> Result<DirectoryAgent> {
        self.client
            .patch(
                &format!("/v1/directory/agents/{}", urlencoding::encode(slug)),
                Some(request),
                None,
            )
            .await
    }

    /// Delete a directory agent.
    pub async fn delete_directory_agent(&self, slug: &str) -> Result<()> {
        self.client
            .delete(
                &format!("/v1/directory/agents/{}", urlencoding::encode(slug)),
                None,
            )
            .await
    }

    /// List ratings for a directory agent.
    pub async fn list_directory_ratings(&self, slug: &str) -> Result<Vec<DirectoryRating>> {
        self.client
            .get(
                &format!(
                    "/v1/directory/agents/{}/ratings",
                    urlencoding::encode(slug)
                ),
                None,
                None,
            )
            .await
    }

    /// Rate a directory agent.
    pub async fn rate_directory_agent(
        &self,
        slug: &str,
        request: RateDirectoryAgentRequest,
    ) -> Result<DirectoryRating> {
        self.client
            .post(
                &format!(
                    "/v1/directory/agents/{}/ratings",
                    urlencoding::encode(slug)
                ),
                Some(request),
                None,
            )
            .await
    }

    // === Skills ===

    /// Import (sync) skills onto a directory agent.
    pub async fn import_skills(
        &self,
        request: ImportSkillsRequest,
    ) -> Result<Option<DirectoryAgent>> {
        self.client.post("/v1/skills/sync", Some(request), None).await
    }

    /// Search skills across the directory.
    pub async fn search_skills(
        &self,
        query: Option<SkillSearchQuery>,
    ) -> Result<Vec<SkillSearchResult>> {
        let query = query.unwrap_or_default();
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(q) = query.q {
            params.push(("q".to_string(), q));
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

        self.client.get("/v1/skills/search", query_ref, None).await
    }

    // === Fleet nodes ===

    /// Enroll or rotate a node token.
    pub async fn create_node(&self, request: CreateNodeRequest) -> Result<CreateNodeResponse> {
        self.client.post("/v1/nodes", Some(request), None).await
    }

    /// List fleet nodes on the roster.
    pub async fn list_nodes(&self, query: Option<NodeListQuery>) -> Result<Vec<NodeRosterEntry>> {
        let query = query.unwrap_or_default();
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(capability) = query.capability {
            params.push(("capability".to_string(), capability));
        }
        if let Some(name) = query.name {
            params.push(("name".to_string(), name));
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

        self.client.get("/v1/nodes", query_ref, None).await
    }

    /// Get a fleet node by name.
    pub async fn get_node(&self, name: &str) -> Result<NodeRosterEntry> {
        self.client
            .get(
                &format!("/v1/nodes/{}", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// List active agent bindings for a node.
    pub async fn list_node_agents(&self, name: &str) -> Result<Vec<NodeAgentBinding>> {
        self.client
            .get(
                &format!("/v1/nodes/{}/agents", urlencoding::encode(name)),
                None,
                None,
            )
            .await
    }

    /// Bind an agent to a node delivery host.
    pub async fn bind_agent_to_node(
        &self,
        name: &str,
        request: BindAgentToNodeRequest,
    ) -> Result<NodeAgentBinding> {
        self.client
            .post(
                &format!("/v1/nodes/{}/agents", urlencoding::encode(name)),
                Some(request),
                None,
            )
            .await
    }

    /// Remove an active node binding for an agent.
    pub async fn unbind_agent_from_node(&self, name: &str, agent_name: &str) -> Result<()> {
        self.client
            .delete(
                &format!(
                    "/v1/nodes/{}/agents/{}",
                    urlencoding::encode(name),
                    urlencoding::encode(agent_name)
                ),
                None,
            )
            .await
    }

    // === Triggers ===

    /// Create a trigger.
    pub async fn create_trigger(&self, request: CreateTriggerRequest) -> Result<Trigger> {
        self.client.post("/v1/triggers", Some(request), None).await
    }

    /// List triggers.
    pub async fn list_triggers(&self) -> Result<Vec<Trigger>> {
        self.client.get("/v1/triggers", None, None).await
    }

    /// Get a trigger by id.
    pub async fn get_trigger(&self, id: &str) -> Result<Trigger> {
        self.client
            .get(
                &format!("/v1/triggers/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Update a trigger.
    pub async fn update_trigger(
        &self,
        id: &str,
        request: UpdateTriggerRequest,
    ) -> Result<Trigger> {
        self.client
            .patch(
                &format!("/v1/triggers/{}", urlencoding::encode(id)),
                Some(request),
                None,
            )
            .await
    }

    /// Delete a trigger.
    pub async fn delete_trigger(&self, id: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/triggers/{}", urlencoding::encode(id)), None)
            .await
    }

    // === Certification ===

    /// Submit a certification run for an external agent.
    pub async fn certify(&self, request: SubmitCertificationRequest) -> Result<CertificationRun> {
        self.client.post("/v1/certify", Some(request), None).await
    }

    /// Get a certification run by id.
    pub async fn get_certification(&self, id: &str) -> Result<CertificationRun> {
        self.client
            .get(
                &format!("/v1/certify/{}", urlencoding::encode(id)),
                None,
                None,
            )
            .await
    }

    /// Public badge SVG URL for a certification run (served without an auth header).
    pub fn certification_badge_url(&self, id: &str) -> String {
        format!(
            "{}/v1/certify/{}/badge.svg",
            self.client.base_url().trim_end_matches('/'),
            urlencoding::encode(id)
        )
    }

    /// Enable certification monitoring for an external agent.
    pub async fn monitor_certification(
        &self,
        request: MonitorCertificationRequest,
    ) -> Result<CertificationRun> {
        self.client
            .post("/v1/certify/monitor", Some(request), None)
            .await
    }

    // === Console / observability ===

    /// List console message logs.
    pub async fn console_messages(
        &self,
        query: Option<ConsoleMessagesQuery>,
    ) -> Result<Vec<ConsoleMessageLog>> {
        let query = query.unwrap_or_default();
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(limit) = query.limit {
            params.push(("limit".to_string(), limit.to_string()));
        }
        if let Some(before) = query.before {
            params.push(("before".to_string(), before));
        }
        if let Some(agent_id) = query.agent_id {
            params.push(("agent_id".to_string(), agent_id));
        }
        if let Some(channel_id) = query.channel_id {
            params.push(("channel_id".to_string(), channel_id));
        }
        if let Some(conversation_id) = query.conversation_id {
            params.push(("conversation_id".to_string(), conversation_id));
        }
        if let Some(delivery_kind) = query.delivery_kind {
            params.push(("delivery_kind".to_string(), delivery_kind));
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

        self.client.get("/v1/console/messages", query_ref, None).await
    }

    /// Get console overview statistics.
    pub async fn console_stats(
        &self,
        query: Option<ConsoleWindowQuery>,
    ) -> Result<ConsoleOverview> {
        let query = query.unwrap_or_default();
        let days = query.days.map(|d| d.to_string());
        let slice: Vec<(&str, &str)> = days
            .as_ref()
            .map(|d| vec![("days", d.as_str())])
            .unwrap_or_default();
        let query_ref = if slice.is_empty() {
            None
        } else {
            Some(slice.as_slice())
        };
        self.client.get("/v1/console/stats", query_ref, None).await
    }

    /// List per-agent console statistics.
    pub async fn console_agents(
        &self,
        query: Option<ConsoleAgentStatsQuery>,
    ) -> Result<Vec<ConsoleAgentStat>> {
        let query = query.unwrap_or_default();
        let mut params: Vec<(String, String)> = Vec::new();
        if let Some(days) = query.days {
            params.push(("days".to_string(), days.to_string()));
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

        self.client.get("/v1/console/agents", query_ref, None).await
    }

    /// Get console cost statistics.
    pub async fn console_costs(
        &self,
        query: Option<ConsoleWindowQuery>,
    ) -> Result<ConsoleCostStats> {
        let query = query.unwrap_or_default();
        let days = query.days.map(|d| d.to_string());
        let slice: Vec<(&str, &str)> = days
            .as_ref()
            .map(|d| vec![("days", d.as_str())])
            .unwrap_or_default();
        let query_ref = if slice.is_empty() {
            None
        } else {
            Some(slice.as_slice())
        };
        self.client.get("/v1/console/costs", query_ref, None).await
    }
}

#[cfg(test)]
mod tests {
    use crate::{
        AgentRegistrationAuthority, CreateAgentRequest, RelayCast, RelayCastOptions,
        ReleaseAgentRequest,
    };
    use serde_json::json;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ok(data: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "data": data }))
    }

    fn request() -> CreateAgentRequest {
        CreateAgentRequest {
            name: "scout".to_string(),
            agent_type: Some("agent".to_string()),
            persona: None,
            metadata: None,
        }
    }

    #[tokio::test]
    async fn register_agent_parses_workspace_id() {
        let server = MockServer::start().await;
        let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
            .expect("relay init");

        Mock::given(method("POST"))
            .and(path("/v1/agents"))
            .respond_with(ok(json!({
                "id": "a1",
                "workspace_id": "ws_123",
                "name": "scout",
                "token": "at_live_1",
                "status": "active",
                "created_at": "2026-01-01T00:00:00.000Z"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let response = relay.register_agent(request()).await.expect("register");
        assert_eq!(response.workspace_id.as_deref(), Some("ws_123"));
    }

    #[tokio::test]
    async fn register_agent_without_workspace_id_defaults_to_none() {
        // Engines that predate the field omit it; the client must still parse.
        let server = MockServer::start().await;
        let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
            .expect("relay init");

        Mock::given(method("POST"))
            .and(path("/v1/agents"))
            .respond_with(ok(json!({
                "id": "a1",
                "name": "scout",
                "token": "at_live_1",
                "status": "active",
                "created_at": "2026-01-01T00:00:00.000Z"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let response = relay.register_agent(request()).await.expect("register");
        assert_eq!(response.workspace_id, None);
    }

    #[tokio::test]
    async fn authority_methods_send_proof_and_work_unit_to_server() {
        let server = MockServer::start().await;
        let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
            .expect("relay init");
        let authority = AgentRegistrationAuthority {
            sponsor_proof: "header.payload.signature".to_string(),
            work_unit_key: "stable-secret-work-unit-key-0000000000000001".to_string(),
        };

        Mock::given(method("POST"))
            .and(path("/v1/agents"))
            .and(body_json(json!({
                "name": "scout",
                "type": "agent",
                "registration_authority": authority,
            })))
            .respond_with(ok(json!({
                "id": "a1",
                "workspace_id": "ws_123",
                "name": "scout",
                "token": "at_live_1",
                "status": "active",
                "created_at": "2026-01-01T00:00:00.000Z"
            })))
            .expect(1)
            .mount(&server)
            .await;
        relay
            .register_agent_with_authority(request(), authority.clone())
            .await
            .expect("sponsored registration");

        Mock::given(method("POST"))
            .and(path(format!("/v1/agents/{}/rotate-token", "scout")))
            .and(body_json(json!({ "registration_authority": authority })))
            .respond_with(ok(json!({ "name": "scout", "token": "at_live_2" })))
            .expect(1)
            .mount(&server)
            .await;
        relay
            .rotate_agent_token_with_authority("scout", authority.clone())
            .await
            .expect("sponsored rotation");

        Mock::given(method("POST"))
            .and(path("/v1/agent/credential-authority"))
            .and(header("authorization", "Bearer at_live_2"))
            .and(body_json(json!({ "registration_authority": authority })))
            .respond_with(ok(json!({ "bound": true })))
            .expect(1)
            .mount(&server)
            .await;
        relay
            .bind_agent_credential_authority("at_live_2", authority)
            .await
            .expect("legacy binding");
    }

    #[tokio::test]
    async fn destructive_authority_methods_send_proof_and_work_unit_to_server() {
        let server = MockServer::start().await;
        let relay =
            RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
                .expect("relay init");
        let authority = AgentRegistrationAuthority {
            sponsor_proof: "header.payload.signature".to_string(),
            work_unit_key: "stable-secret-work-unit-key-0000000000000001".to_string(),
        };

        Mock::given(method("DELETE"))
            .and(path("/v1/agents/scout"))
            .and(body_json(json!({ "registration_authority": authority })))
            .respond_with(ResponseTemplate::new(204))
            .expect(1)
            .mount(&server)
            .await;
        relay
            .delete_agent_with_authority("scout", authority.clone())
            .await
            .expect("sponsored deletion");

        Mock::given(method("POST"))
            .and(path("/v1/agents/release"))
            .and(body_json(json!({
                "name": "scout",
                "delete_agent": true,
                "registration_authority": authority,
            })))
            .respond_with(ok(json!({
                "invocation_id": "inv_release",
                "action_name": "release",
                "handler_agent_id": null,
                "handler_node_id": null,
                "dispatched_node_id": null,
                "input": { "name": "scout", "delete_agent": true },
                "status": "completed",
                "created_at": "2026-01-01T00:00:00.000Z"
            })))
            .expect(1)
            .mount(&server)
            .await;
        relay
            .release_agent_with_authority(
                ReleaseAgentRequest {
                    name: "scout".to_string(),
                    reason: None,
                    delete_agent: Some(true),
                },
                authority,
            )
            .await
            .expect("sponsored destructive release");
    }
}
