//! Main RelayCast client for workspace-level operations.

use crate::agent::AgentClient;
use crate::billing::BillingClient;
use crate::client::{ClientOptions, HttpClient};
use crate::error::{RelayError, Result};
use crate::types::*;

const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_BASE_URL: &str = "https://api.agentrelay.dev";

/// Options for creating a RelayCast client.
#[derive(Debug, Clone)]
pub struct RelayCastOptions {
    /// The API key for authentication.
    pub api_key: String,
    /// The base URL for the API (defaults to https://api.agentrelay.dev).
    pub base_url: Option<String>,
}

impl RelayCastOptions {
    /// Create new options with the given API key.
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: None,
        }
    }

    /// Set a custom base URL.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }
}

/// Main client for RelayCast workspace operations.
pub struct RelayCast {
    client: HttpClient,
}

impl RelayCast {
    /// Create a new RelayCast client with the given options.
    pub fn new(options: RelayCastOptions) -> Result<Self> {
        let mut client_options = ClientOptions::new(options.api_key);
        if let Some(url) = options.base_url {
            client_options = client_options.with_base_url(url);
        }
        let client = HttpClient::new(client_options)?;
        Ok(Self { client })
    }

    /// Create a new workspace.
    pub async fn create_workspace(
        name: &str,
        base_url: Option<&str>,
    ) -> Result<CreateWorkspaceResponse> {
        let url = format!(
            "{}/v1/workspaces",
            base_url.unwrap_or(DEFAULT_BASE_URL)
        );

        let client = reqwest::Client::new();
        let response = client
            .post(&url)
            .header("Content-Type", "application/json")
            .header("X-SDK-Version", SDK_VERSION)
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

        json.data.ok_or_else(|| {
            RelayError::InvalidResponse("Response missing data field".to_string())
        })
    }

    /// Get the billing client.
    pub fn billing(&self) -> BillingClient<'_> {
        BillingClient::new(&self.client)
    }

    /// Create an agent client for the given agent token.
    pub fn as_agent(&self, agent_token: impl Into<String>) -> Result<AgentClient> {
        let mut options = ClientOptions::new(agent_token);
        options = options.with_base_url(self.client.base_url());
        let client = HttpClient::new(options)?;
        Ok(AgentClient::from_client(client))
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

    // === Agents ===

    /// Register a new agent.
    pub async fn register_agent(&self, request: CreateAgentRequest) -> Result<CreateAgentResponse> {
        self.client.post("/v1/agents", Some(request), None).await
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
            Err(RelayError::Api { code, .. }) if code == "agent_already_exists" => {
                let agent = self.get_agent(&request.name).await?;
                let token_response = self.rotate_agent_token(&agent.name).await?;
                Ok(CreateAgentResponse {
                    id: agent.id,
                    name: agent.name,
                    token: token_response.token,
                    status: agent.status,
                    created_at: agent.created_at,
                })
            }
            Err(e) => Err(e),
        }
    }

    // === Webhooks ===

    /// Create a webhook.
    pub async fn create_webhook(
        &self,
        request: CreateWebhookRequest,
    ) -> Result<CreateWebhookResponse> {
        self.client.post("/v1/webhooks", Some(request), None).await
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

    /// Trigger a webhook.
    pub async fn trigger_webhook(
        &self,
        webhook_id: &str,
        request: WebhookTriggerRequest,
    ) -> Result<WebhookTriggerResponse> {
        self.client
            .post(
                &format!("/v1/hooks/{}", urlencoding::encode(webhook_id)),
                Some(request),
                None,
            )
            .await
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
            .delete(&format!("/v1/subscriptions/{}", urlencoding::encode(id)), None)
            .await
    }

    // === Commands ===

    /// Register a command.
    pub async fn register_command(
        &self,
        request: CreateCommandRequest,
    ) -> Result<CreateCommandResponse> {
        self.client.post("/v1/commands", Some(request), None).await
    }

    /// List commands.
    pub async fn list_commands(&self) -> Result<Vec<AgentCommand>> {
        self.client.get("/v1/commands", None, None).await
    }

    /// Delete a command.
    pub async fn delete_command(&self, command: &str) -> Result<()> {
        self.client
            .delete(&format!("/v1/commands/{}", urlencoding::encode(command)), None)
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
}
