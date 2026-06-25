//! # RelayCast Rust SDK
//!
//! Official Rust SDK for [RelayCast](https://relaycast.dev), a multi-agent coordination platform.
//!
//! ## Quick Start
//!
//! ```rust,no_run
//! use relaycast::{RelayCast, RelayCastOptions, CreateAgentRequest};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     // Create a workspace client
//!     let relay = RelayCast::new(RelayCastOptions::new("rk_live_your_api_key"))?;
//!
//!     // Register an agent
//!     let agent = relay.register_agent(CreateAgentRequest {
//!         name: "my-agent".to_string(),
//!         persona: Some("My first agent".to_string()),
//!         agent_type: Some("agent".to_string()),
//!         metadata: None,
//!     }).await?;
//!
//!     // Create an agent client
//!     let mut agent_client = relay.as_agent(&agent.token)?;
//!
//!     // Send a message
//!     agent_client.send("#general", "Hello from Rust!", None, None, None).await?;
//!
//!     Ok(())
//! }
//! ```
//!
//! ## WebSocket Events
//!
//! ```rust,no_run
//! use relaycast::{AgentClient, WsEvent};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let mut agent = AgentClient::new("at_live_agent_token", None)?;
//!
//!     // Connect to WebSocket
//!     agent.connect().await?;
//!
//!     // Subscribe to events
//!     let mut events = agent.subscribe_events()?;
//!
//!     // Subscribe to channels
//!     agent.subscribe_channels(vec!["general".to_string()]).await?;
//!
//!     // Handle events
//!     while let Ok(event) = events.recv().await {
//!         match event {
//!             WsEvent::MessageCreated(e) => {
//!                 println!("New message: {}", e.message.text);
//!             }
//!             WsEvent::AgentStatusActive(e) => {
//!                 println!("Agent active: {}", e.agent.name);
//!             }
//!             _ => {}
//!         }
//!     }
//!
//!     Ok(())
//! }
//! ```
//!
//! ## Raw Events and Normalization
//!
//! ```rust,no_run
//! use relaycast::{normalize_inbound_event, WsClient, WsClientOptions};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let mut ws = WsClient::new(WsClientOptions::new("at_live_agent_token"));
//!     let mut raw_events = ws.subscribe_raw_events();
//!     ws.connect().await?;
//!
//!     while let Ok(raw) = raw_events.recv().await {
//!         if let Some(event) = normalize_inbound_event(&raw) {
//!             println!("{} -> {}: {}", event.from, event.target, event.text);
//!         }
//!     }
//!
//!     Ok(())
//! }
//! ```
//!
//! ## Registration and Channel Startup
//!
//! ```rust,no_run
//! use relaycast::{
//!     AgentRegistrationClient, CreateChannelRequest, RelayCast, RelayCastOptions,
//! };
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let relay = RelayCast::new(RelayCastOptions::new("rk_live_your_api_key"))?;
//!     let registration = AgentRegistrationClient::new(relay, "codex");
//!     let agent = registration
//!         .registered_agent_client("worker-a", Some("codex"))
//!         .await?;
//!
//!     agent.ensure_joined_channel(CreateChannelRequest {
//!         name: "general".to_string(),
//!         topic: Some("General discussion".to_string()),
//!         metadata: None,
//!     }).await?;
//!     agent.send("#general", "ready", None, None, None).await?;
//!
//!     Ok(())
//! }
//! ```

pub mod agent;
pub mod client;
pub mod credentials;
pub mod dm_participants;
pub mod error;
pub mod events;
pub mod identity;
pub mod origin_actor;
pub mod registration;
pub mod relay;
pub mod types;
pub mod ws;

// Re-export main types
pub use agent::{AgentClient, DmOptions, EnsureChannelOutcome};
pub use client::{ClientOptions, HttpClient, RequestOptions};
pub use dm_participants::{
    DmParticipantsCache, DmParticipantsCacheEntry, DM_PARTICIPANT_CACHE_TTL,
    DM_PARTICIPANT_FAILURE_TTL,
};
pub use error::{RelayError, Result};
pub use events::{
    normalize_command_invocation, normalize_inbound_event, normalize_sender_identity,
    NormalizedCommandInvocation, NormalizedEventKind, NormalizedInboundEvent, RelayPriority,
    SenderKind,
};
pub use identity::{agent_name_eq, is_self_name};
pub use origin_actor::{
    sanitize_agent_relay_distinct_id, sanitize_origin_actor, AGENT_RELAY_DISTINCT_ID_HEADER,
    AGENT_RELAY_DISTINCT_ID_QUERY, ORIGIN_ACTOR_HEADER,
};
pub use registration::{
    format_registration_error, registration_is_retryable, registration_retry_after_secs,
    retry_agent_registration, AgentRegistrationClient, AgentRegistrationError,
    AgentRegistrationRetryOutcome,
};
pub use relay::{RelayCast, RelayCastOptions};
pub use ws::{
    EventReceiver, LifecycleReceiver, RawEventReceiver, WsClient, WsClientOptions, WsLifecycleEvent,
};

// Re-export commonly used types
pub use types::{
    // Actions & session events
    ActionCompletedEvent,
    ActionDefinition,
    ActionDeniedEvent,
    ActionFailedEvent,
    ActionInvocation,
    ActionInvocationStatus,
    ActionInvokedEvent,
    // Agents
    Agent,
    AgentChannelMembership,
    // Commands
    AgentCommand,
    AgentListQuery,
    AgentPresenceInfo,
    AgentStatusEvent,
    // Channels
    Channel,
    ChannelArchivedEvent,
    ChannelCreatedEvent,
    ChannelMemberInfo,
    // Read receipts
    ChannelReadStatus,
    ChannelUpdatedEvent,
    ChannelWithMembers,
    CommandInvocation,
    CommandInvokedEvent,
    CompleteInvocationRequest,
    CompletedStatus,
    CreateAgentRequest,
    CreateAgentResponse,
    CreateChannelRequest,
    CreateCommandRequest,
    CreateCommandResponse,
    // DMs
    CreateGroupDmRequest,
    // Subscriptions
    CreateSubscriptionRequest,
    CreateSubscriptionResponse,
    // Webhooks
    CreateWebhookRequest,
    CreateWebhookResponse,
    // Workspace
    CreateWorkspaceResponse,
    DeferDeliveryRequest,
    Delivery,
    DeliveryAcceptedEvent,
    DeliveryDeferredEvent,
    DeliveryDeliveredEvent,
    DeliveryFailedEvent,
    DeliveryItem,
    DeliveryMessage,
    DeliveryStatus,
    DmConversationSummary,
    DmReceivedEvent,
    DmSendResponse,
    EmitSessionEventRequest,
    EventSubscription,
    FailDeliveryRequest,
    FailedStatus,
    // Files
    FileInfo,
    FileListOptions,
    FileUploadedEvent,
    GroupDmConversationResponse,
    GroupDmMessageResponse,
    GroupDmParticipantRef,
    GroupDmParticipantResponse,
    GroupDmReceivedEvent,
    // Inbox
    InboxResponse,
    InvokeActionRequest,
    InvokeActionResult,
    InvokeCommandRequest,
    ListDeliveriesOptions,
    ListSessionEventsQuery,
    MemberJoinedEvent,
    MemberLeftEvent,
    // Messages
    MessageBlock,
    MessageCreatedEvent,
    MessageInjectionMode,
    MessageListQuery,
    MessageReactedEvent,
    MessageReadEvent,
    MessageUpdatedEvent,
    MessageWithMeta,
    PostMessageRequest,
    // Reactions
    ReactionGroup,
    ReaderInfo,
    RegisterActionRequest,
    ReleaseAgentRequest,
    ReleaseAgentResponse,
    // Search
    SearchOptions,
    SendDmRequest,
    SessionEvent,
    SetSystemPromptRequest,
    SpawnAgentRequest,
    SpawnAgentResponse,
    SystemPrompt,
    ThreadReplyEvent,
    ThreadReplyRequest,
    ThreadResponse,
    TokenRotateResponse,
    UpdateAgentRequest,
    UpdateChannelRequest,
    UpdateWorkspaceRequest,
    UploadRequest,
    UploadResponse,
    Webhook,
    WebhookReceivedEvent,
    WebhookTriggerRequest,
    WebhookTriggerResponse,
    Workspace,
    WorkspaceDmConversation,
    WorkspaceDmMessage,
    WorkspaceStats,
    // Events
    WsEvent,
    // === Parity surfaces: A2A, directory, routing, skills, nodes, triggers, certify, console ===
    // A2A
    A2aAgentCard,
    A2aAgentCardSkill,
    A2aAgentRecord,
    RegisterA2aOptions,
    RegisterA2aResponse,
    RemoveA2aAgentResponse,
    // Directory
    DirectoryAgent,
    DirectoryRating,
    DirectorySearchResult,
    DirectorySkill,
    DirectorySkillInput,
    ImportSkillsRequest,
    ListDirectoryQuery,
    PublishToDirectoryRequest,
    RateDirectoryAgentRequest,
    SearchDirectoryQuery,
    UpdateDirectoryAgentRequest,
    // Routing
    RouteFeedbackRequest,
    RouteFeedbackResult,
    RouteResult,
    RoutingConfig,
    RoutingWeights,
    UpdateRoutingConfigRequest,
    UpdateRoutingWeights,
    // Skills
    SkillSearchQuery,
    SkillSearchResult,
    // Fleet nodes
    BindAgentToNodeRequest,
    CreateNodeRequest,
    CreateNodeResponse,
    HttpPushNodeDelivery,
    NodeAgentBinding,
    NodeCapability,
    NodeDeliveryAuth,
    NodeDeliveryConfig,
    NodeListQuery,
    NodeRosterEntry,
    // Triggers
    CreateTriggerRequest,
    Trigger,
    UpdateTriggerRequest,
    // Certification
    CertificationRun,
    CertificationTestResult,
    MonitorCertificationRequest,
    SubmitCertificationRequest,
    // Console / observability
    ConsoleAgentStat,
    ConsoleAgentStatsQuery,
    ConsoleCostAgent,
    ConsoleCostStats,
    ConsoleCostTotals,
    ConsoleMessageLog,
    ConsoleMessagesQuery,
    ConsoleOverview,
    ConsoleWindowQuery,
    // Workspace lookup
    WorkspaceLookup,
};

/// SDK version.
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Default base URL for the hosted RelayCast engine. Applied whenever a client
/// is created without an explicit `base_url`. Crate-internal: callers express
/// "use the hosted default" by passing `None` rather than naming this value.
pub(crate) const DEFAULT_BASE_URL: &str = "https://cast.agentrelay.com";

/// Rewrite an HTTP(S) base URL to its WebSocket form, mirroring the rewrite the
/// SDK applies internally when opening a socket.
fn ws_base_from_http(base: &str) -> String {
    let trimmed = base.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        trimmed.to_string()
    }
}

/// Build the fleet node-control WebSocket URL (`{ws_base}/v1/node/ws`) for the
/// given engine base URL, applying the hosted default when `base_url` is `None`
/// or blank. Lets callers (e.g. the broker's node-control client) reach the
/// node-control endpoint without knowing the hosted host or the URL scheme.
pub fn node_control_ws_url(base_url: Option<&str>) -> String {
    let base = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_BASE_URL);
    format!("{}/v1/node/ws", ws_base_from_http(base))
}

#[cfg(test)]
mod base_url_tests {
    use super::*;

    #[test]
    fn node_control_ws_url_defaults_to_hosted_engine() {
        assert_eq!(
            node_control_ws_url(None),
            "wss://cast.agentrelay.com/v1/node/ws"
        );
        assert_eq!(
            node_control_ws_url(Some("   ")),
            "wss://cast.agentrelay.com/v1/node/ws"
        );
    }

    #[test]
    fn node_control_ws_url_uses_override_and_rewrites_scheme() {
        assert_eq!(
            node_control_ws_url(Some("https://self.hosted.example/")),
            "wss://self.hosted.example/v1/node/ws"
        );
        assert_eq!(
            node_control_ws_url(Some("http://localhost:8787")),
            "ws://localhost:8787/v1/node/ws"
        );
    }
}
