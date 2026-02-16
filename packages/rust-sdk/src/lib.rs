//! # RelayCast Rust SDK
//!
//! Official Rust SDK for [RelayCast](https://agentrelay.dev), a multi-agent coordination platform.
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
//!         description: Some("My first agent".to_string()),
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
//!             WsEvent::AgentOnline(e) => {
//!                 println!("Agent online: {}", e.agent);
//!             }
//!             _ => {}
//!         }
//!     }
//!
//!     Ok(())
//! }
//! ```

pub mod agent;
pub mod billing;
pub mod client;
pub mod error;
pub mod relay;
pub mod types;
pub mod ws;

// Re-export main types
pub use agent::AgentClient;
pub use billing::BillingClient;
pub use client::{ClientOptions, HttpClient, RequestOptions};
pub use error::{RelayError, Result};
pub use relay::{RelayCast, RelayCastOptions};
pub use ws::{EventReceiver, WsClient, WsClientOptions};

// Re-export commonly used types
pub use types::{
    // Workspace
    CreateWorkspaceResponse,
    SetSystemPromptRequest,
    SystemPrompt,
    UpdateWorkspaceRequest,
    Workspace,
    WorkspaceStats,
    // Agents
    Agent,
    AgentListQuery,
    AgentPresenceInfo,
    CreateAgentRequest,
    CreateAgentResponse,
    TokenRotateResponse,
    UpdateAgentRequest,
    // Channels
    Channel,
    ChannelMemberInfo,
    ChannelWithMembers,
    CreateChannelRequest,
    UpdateChannelRequest,
    // Messages
    MessageBlock,
    MessageListQuery,
    MessageWithMeta,
    PostMessageRequest,
    ThreadReplyRequest,
    ThreadResponse,
    // DMs
    CreateGroupDmRequest,
    DmConversationSummary,
    SendDmRequest,
    WorkspaceDmConversation,
    // Reactions
    ReactionGroup,
    // Search
    SearchOptions,
    // Inbox
    InboxResponse,
    // Read receipts
    ChannelReadStatus,
    ReaderInfo,
    // Files
    FileInfo,
    FileListOptions,
    UploadRequest,
    UploadResponse,
    // Webhooks
    CreateWebhookRequest,
    CreateWebhookResponse,
    Webhook,
    WebhookTriggerRequest,
    WebhookTriggerResponse,
    // Subscriptions
    CreateSubscriptionRequest,
    CreateSubscriptionResponse,
    EventSubscription,
    // Commands
    AgentCommand,
    CommandInvocation,
    CreateCommandRequest,
    CreateCommandResponse,
    InvokeCommandRequest,
    // Billing
    BillingSubscription,
    PortalResponse,
    SubscribeRequest,
    UsageInfo,
    // Events
    WsEvent,
    AgentOfflineEvent,
    AgentOnlineEvent,
    ChannelArchivedEvent,
    ChannelCreatedEvent,
    ChannelUpdatedEvent,
    CommandInvokedEvent,
    DmReceivedEvent,
    FileUploadedEvent,
    GroupDmReceivedEvent,
    MemberJoinedEvent,
    MemberLeftEvent,
    MessageCreatedEvent,
    MessageReadEvent,
    MessageUpdatedEvent,
    ReactionAddedEvent,
    ReactionRemovedEvent,
    ThreadReplyEvent,
    WebhookReceivedEvent,
};

/// SDK version.
pub const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
