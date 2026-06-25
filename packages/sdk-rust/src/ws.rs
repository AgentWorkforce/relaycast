//! WebSocket client for real-time events.

use futures_util::{Sink, SinkExt, StreamExt};
use std::collections::HashSet;
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio::time::{Duration, MissedTickBehavior};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, warn};
use url::Url;

use crate::error::{RelayError, Result};
use crate::origin_actor::{
    sanitize_agent_relay_distinct_id, sanitize_origin_actor, AGENT_RELAY_DISTINCT_ID_QUERY,
};
use crate::types::WsEvent;
use crate::{ws_base_from_http, DEFAULT_BASE_URL};

const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_ORIGIN_CLIENT: &str = "@relaycast/sdk-rust";
const PING_INTERVAL_SECS: u64 = 30;
const DEFAULT_MAX_RECONNECT_ATTEMPTS: u32 = 10;
const DEFAULT_MAX_RECONNECT_DELAY_MS: u64 = 30_000;

/// Options for creating a WebSocket client.
#[derive(Debug, Clone)]
pub struct WsClientOptions {
    /// The agent token for authentication.
    pub token: String,
    /// The base URL for the API (defaults to https://cast.agentrelay.com).
    pub base_url: Option<String>,
    /// Enable debug logging for dropped/malformed messages.
    pub debug: bool,
    /// SDK origin client metadata.
    pub origin_client: Option<String>,
    /// SDK origin version metadata.
    pub origin_version: Option<String>,
    /// User-Agent-style origin_actor identifier, forwarded as the `origin_actor` query
    /// param (browsers can't set custom WS headers). Invalid values are dropped.
    pub origin_actor: Option<String>,
    /// Agent Relay distinct telemetry id, forwarded as the
    /// `agent_relay_distinct_id` query param. Invalid values are dropped.
    pub agent_relay_distinct_id: Option<String>,
    /// Maximum reconnect attempts before giving up (default: 10).
    pub max_reconnect_attempts: Option<u32>,
    /// Maximum reconnect delay in milliseconds (default: 30000).
    pub max_reconnect_delay_ms: Option<u64>,
    /// WebSocket path. Defaults to `/v1/ws` for workspace observer streams.
    pub path: Option<String>,
    /// Optional node registration sent after connecting to `/v1/node/ws`.
    pub node_registration: Option<NodeRegistration>,
}

#[derive(Debug, Clone)]
pub struct NodeRegistration {
    pub node_id: String,
    pub name: String,
    pub agent_name: String,
}

impl WsClientOptions {
    /// Create new WebSocket client options with the given token.
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            base_url: None,
            debug: false,
            origin_client: None,
            origin_version: None,
            origin_actor: None,
            agent_relay_distinct_id: None,
            max_reconnect_attempts: None,
            max_reconnect_delay_ms: None,
            path: None,
            node_registration: None,
        }
    }

    /// Set a custom base URL.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Enable debug logging.
    pub fn with_debug(mut self, debug: bool) -> Self {
        self.debug = debug;
        self
    }

    /// Set origin metadata query params for WebSocket handshake.
    pub fn with_origin(
        mut self,
        origin_client: impl Into<String>,
        origin_version: impl Into<String>,
    ) -> Self {
        self.origin_client = Some(origin_client.into());
        self.origin_version = Some(origin_version.into());
        self
    }

    /// Set the origin_actor identifier forwarded as the `origin_actor` query param.
    pub fn with_origin_actor(mut self, origin_actor: impl Into<String>) -> Self {
        self.origin_actor = Some(origin_actor.into());
        self
    }

    /// Set Agent Relay's distinct telemetry id for WebSocket handshakes.
    pub fn with_agent_relay_distinct_id(mut self, id: impl Into<String>) -> Self {
        self.agent_relay_distinct_id = Some(id.into());
        self
    }

    /// Set max reconnect attempts.
    pub fn with_max_reconnect_attempts(mut self, attempts: u32) -> Self {
        self.max_reconnect_attempts = Some(attempts);
        self
    }

    /// Set max reconnect delay in milliseconds.
    pub fn with_max_reconnect_delay_ms(mut self, delay_ms: u64) -> Self {
        self.max_reconnect_delay_ms = Some(delay_ms);
        self
    }

    /// Connect to the node-control WebSocket and register this node on open.
    pub fn with_node_registration(mut self, registration: NodeRegistration) -> Self {
        self.path = Some("/v1/node/ws".to_string());
        self.node_registration = Some(registration);
        self
    }
}

/// A handle for subscribing to WebSocket events.
pub type EventReceiver = broadcast::Receiver<WsEvent>;
/// A handle for subscribing to raw WebSocket JSON events.
pub type RawEventReceiver = broadcast::Receiver<serde_json::Value>;
/// A handle for subscribing to WebSocket lifecycle events.
pub type LifecycleReceiver = broadcast::Receiver<WsLifecycleEvent>;

/// Lifecycle events emitted by the WebSocket client.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WsLifecycleEvent {
    Open,
    Close,
    Error(String),
    Reconnecting { attempt: u32 },
}

/// WebSocket client for receiving real-time events.
pub struct WsClient {
    token: Arc<Mutex<String>>,
    base_url: String,
    debug: bool,
    origin_client: String,
    origin_version: String,
    origin_actor: Option<String>,
    agent_relay_distinct_id: Option<String>,
    max_reconnect_attempts: u32,
    max_reconnect_delay_ms: u64,
    path: String,
    node_registration: Option<NodeRegistration>,
    event_tx: broadcast::Sender<WsEvent>,
    raw_event_tx: broadcast::Sender<serde_json::Value>,
    lifecycle_tx: broadcast::Sender<WsLifecycleEvent>,
    command_tx: Option<mpsc::Sender<WsCommand>>,
    is_connected: Arc<Mutex<bool>>,
}

enum WsCommand {
    Subscribe(Vec<String>),
    Unsubscribe(Vec<String>),
    Disconnect,
}

impl WsClient {
    /// Create a new WebSocket client with the given options.
    pub fn new(options: WsClientOptions) -> Self {
        // Single source of truth for HTTP(S)->WS(S) normalization (trims
        // whitespace + trailing slashes); see `ws_base_from_http` in lib.rs.
        let base_url =
            ws_base_from_http(options.base_url.as_deref().unwrap_or(DEFAULT_BASE_URL));

        let (event_tx, _) = broadcast::channel(1024);
        let (raw_event_tx, _) = broadcast::channel(1024);
        let (lifecycle_tx, _) = broadcast::channel(128);

        Self {
            token: Arc::new(Mutex::new(options.token)),
            base_url,
            debug: options.debug,
            origin_client: options
                .origin_client
                .unwrap_or_else(|| DEFAULT_ORIGIN_CLIENT.to_string()),
            origin_version: options
                .origin_version
                .unwrap_or_else(|| SDK_VERSION.to_string()),
            origin_actor: sanitize_origin_actor(options.origin_actor),
            agent_relay_distinct_id: sanitize_agent_relay_distinct_id(
                options.agent_relay_distinct_id,
            ),
            max_reconnect_attempts: options
                .max_reconnect_attempts
                .unwrap_or(DEFAULT_MAX_RECONNECT_ATTEMPTS),
            max_reconnect_delay_ms: options
                .max_reconnect_delay_ms
                .unwrap_or(DEFAULT_MAX_RECONNECT_DELAY_MS),
            path: options.path.unwrap_or_else(|| "/v1/ws".to_string()),
            node_registration: options.node_registration,
            event_tx,
            raw_event_tx,
            lifecycle_tx,
            command_tx: None,
            is_connected: Arc::new(Mutex::new(false)),
        }
    }

    /// Check if the WebSocket is connected.
    pub async fn is_connected(&self) -> bool {
        *self.is_connected.lock().await
    }

    /// Subscribe to receive events.
    pub fn subscribe_events(&self) -> EventReceiver {
        self.event_tx.subscribe()
    }

    /// Subscribe to receive raw WebSocket JSON events.
    pub fn subscribe_raw_events(&self) -> RawEventReceiver {
        self.raw_event_tx.subscribe()
    }

    /// Subscribe to lifecycle events.
    pub fn subscribe_lifecycle(&self) -> LifecycleReceiver {
        self.lifecycle_tx.subscribe()
    }

    /// Update the token used for subsequent reconnect attempts.
    pub async fn set_token(&self, token: impl Into<String>) {
        *self.token.lock().await = token.into();
    }

    /// Connect to the WebSocket server.
    pub async fn connect(&mut self) -> Result<()> {
        if *self.is_connected.lock().await {
            return Ok(());
        }

        let mut url = Url::parse(&format!("{}{}", self.base_url, self.path))?;
        {
            let token = self.token.lock().await.clone();
            let mut query = url.query_pairs_mut();
            query.append_pair("token", &token);
            query.append_pair("origin_client", &self.origin_client);
            query.append_pair("origin_version", &self.origin_version);
            if let Some(ref origin_actor) = self.origin_actor {
                query.append_pair("origin_actor", origin_actor);
            }
            if let Some(ref id) = self.agent_relay_distinct_id {
                query.append_pair(AGENT_RELAY_DISTINCT_ID_QUERY, id);
            }
        }

        let (ws_stream, _) = connect_async(url.as_str()).await?;

        let (command_tx, mut command_rx) = mpsc::channel::<WsCommand>(32);
        self.command_tx = Some(command_tx);

        let token = self.token.clone();
        let event_tx = self.event_tx.clone();
        let raw_event_tx = self.raw_event_tx.clone();
        let lifecycle_tx = self.lifecycle_tx.clone();
        let is_connected = self.is_connected.clone();
        let debug = self.debug;
        let base_url = self.base_url.clone();
        let origin_client = self.origin_client.clone();
        let origin_version = self.origin_version.clone();
        let origin_actor = self.origin_actor.clone();
        let agent_relay_distinct_id = self.agent_relay_distinct_id.clone();
        let max_reconnect_attempts = self.max_reconnect_attempts;
        let max_reconnect_delay_ms = self.max_reconnect_delay_ms;
        let path = self.path.clone();
        let node_registration = self.node_registration.clone();

        *is_connected.lock().await = true;

        // Spawn the WebSocket handler task
        tokio::spawn(async move {
            let mut subscribed_channels: HashSet<String> = HashSet::new();
            let mut current_stream = Some(ws_stream);
            let mut reconnect_attempt = 0u32;
            let mut should_stop = false;

            'outer: while !should_stop {
                let stream = if let Some(stream) = current_stream.take() {
                    stream
                } else {
                    let mut reconnect_url = match Url::parse(&format!("{}{}", base_url, path)) {
                        Ok(url) => url,
                        Err(err) => {
                            let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                            break 'outer;
                        }
                    };

                    let current_token = token.lock().await.clone();
                    {
                        let mut query = reconnect_url.query_pairs_mut();
                        query.append_pair("token", &current_token);
                        query.append_pair("origin_client", &origin_client);
                        query.append_pair("origin_version", &origin_version);
                        if let Some(ref origin_actor) = origin_actor {
                            query.append_pair("origin_actor", origin_actor);
                        }
                        if let Some(ref id) = agent_relay_distinct_id {
                            query.append_pair(AGENT_RELAY_DISTINCT_ID_QUERY, id);
                        }
                    }

                    match connect_async(reconnect_url.as_str()).await {
                        Ok((stream, _)) => stream,
                        Err(err) => {
                            let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));

                            if reconnect_attempt >= max_reconnect_attempts {
                                break 'outer;
                            }
                            reconnect_attempt += 1;
                            let _ = lifecycle_tx.send(WsLifecycleEvent::Reconnecting {
                                attempt: reconnect_attempt,
                            });
                            let delay_ms =
                                reconnect_delay_ms(reconnect_attempt, max_reconnect_delay_ms);
                            let reconnect_sleep =
                                tokio::time::sleep(Duration::from_millis(delay_ms));
                            tokio::pin!(reconnect_sleep);

                            loop {
                                tokio::select! {
                                    _ = &mut reconnect_sleep => break,
                                    cmd = command_rx.recv() => {
                                        match cmd {
                                            Some(WsCommand::Subscribe(channels)) => {
                                                for ch in channels {
                                                    subscribed_channels.insert(ch);
                                                }
                                            }
                                            Some(WsCommand::Unsubscribe(channels)) => {
                                                for ch in channels {
                                                    subscribed_channels.remove(&ch);
                                                }
                                            }
                                            Some(WsCommand::Disconnect) | None => {
                                                should_stop = true;
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                            continue;
                        }
                    }
                };

                let (mut write, mut read) = stream.split();
                reconnect_attempt = 0;
                *is_connected.lock().await = true;
                if let Some(registration) = &node_registration {
                    if let Err(err) = send_node_register(&mut write, registration).await {
                        let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                        *is_connected.lock().await = false;
                        continue;
                    }
                }
                let _ = lifecycle_tx.send(WsLifecycleEvent::Open);

                // Re-subscribe all known channels on every new socket.
                if node_registration.is_none() && !subscribed_channels.is_empty() {
                    let msg = serde_json::json!({
                        "type": "subscribe",
                        "channels": subscribed_channels.iter().cloned().collect::<Vec<_>>()
                    });
                    if let Err(err) = write.send(Message::Text(msg.to_string())).await {
                        let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                        *is_connected.lock().await = false;
                        continue;
                    }
                }

                let mut ping_interval =
                    tokio::time::interval(Duration::from_secs(PING_INTERVAL_SECS));
                ping_interval.set_missed_tick_behavior(MissedTickBehavior::Skip);

                loop {
                    tokio::select! {
                        msg = read.next() => {
                            match msg {
                                Some(Ok(Message::Text(text))) => {
                                    match serde_json::from_str::<serde_json::Value>(&text) {
                                        Ok(value) => {
                                            let event_value = normalize_node_message(value.clone()).unwrap_or_else(|| value.clone());
                                            let _ = raw_event_tx.send(event_value.clone());
                                            if node_registration.is_some() {
                                                if let Some(ack) = node_delivery_ack(&value) {
                                                    if let Err(err) = write.send(Message::Text(ack.to_string())).await {
                                                        let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                                        break;
                                                    }
                                                }
                                            }
                                            match serde_json::from_value::<WsEvent>(event_value) {
                                                Ok(event) => {
                                                    let _ = event_tx.send(event);
                                                }
                                                Err(err) => {
                                                    if debug {
                                                        warn!("[relaycast] Dropped typed WebSocket event: {}: {}", err, truncate_str(&text, 200));
                                                    }
                                                }
                                            }
                                        }
                                        Err(err) => {
                                            if debug {
                                                warn!("[relaycast] Dropped non-JSON WebSocket message: {}: {}", err, truncate_str(&text, 200));
                                            }
                                        }
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => {
                                    debug!("WebSocket connection closed");
                                    break;
                                }
                                Some(Err(err)) => {
                                    let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                    break;
                                }
                                _ => {}
                            }
                        }
                        cmd = command_rx.recv() => {
                            match cmd {
                                Some(WsCommand::Subscribe(channels)) => {
                                    for ch in &channels {
                                        subscribed_channels.insert(ch.clone());
                                    }
                                    if node_registration.is_none() {
                                        let msg = serde_json::json!({
                                            "type": "subscribe",
                                            "channels": channels
                                        });
                                        if let Err(err) = write.send(Message::Text(msg.to_string())).await {
                                            let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                            break;
                                        }
                                    }
                                }
                                Some(WsCommand::Unsubscribe(channels)) => {
                                    for ch in &channels {
                                        subscribed_channels.remove(ch);
                                    }
                                    if node_registration.is_none() {
                                        let msg = serde_json::json!({
                                            "type": "unsubscribe",
                                            "channels": channels
                                        });
                                        if let Err(err) = write.send(Message::Text(msg.to_string())).await {
                                            let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                            break;
                                        }
                                    }
                                }
                                Some(WsCommand::Disconnect) | None => {
                                    should_stop = true;
                                    let _ = write.send(Message::Close(None)).await;
                                    break;
                                }
                            }
                        }
                        _ = ping_interval.tick() => {
                            let ping = if let Some(registration) = &node_registration {
                                serde_json::json!({
                                    "v": 1,
                                    "type": "node.heartbeat",
                                    "load": 0,
                                    "active_agents": 1,
                                    "handlers_live": false,
                                    "node_id": registration.node_id,
                                    "name": registration.name,
                                    "capabilities": [],
                                    "max_agents": 1,
                                    "version": SDK_VERSION,
                                })
                            } else {
                                serde_json::json!({"type": "ping"})
                            };
                            if let Err(err) = write.send(Message::Text(ping.to_string())).await {
                                let _ = lifecycle_tx.send(WsLifecycleEvent::Error(err.to_string()));
                                break;
                            }
                        }
                    }
                }

                *is_connected.lock().await = false;
                let _ = lifecycle_tx.send(WsLifecycleEvent::Close);

                if should_stop {
                    break 'outer;
                }

                if reconnect_attempt >= max_reconnect_attempts {
                    break 'outer;
                }
                reconnect_attempt += 1;
                let _ = lifecycle_tx.send(WsLifecycleEvent::Reconnecting {
                    attempt: reconnect_attempt,
                });
                let delay_ms = reconnect_delay_ms(reconnect_attempt, max_reconnect_delay_ms);
                let reconnect_sleep = tokio::time::sleep(Duration::from_millis(delay_ms));
                tokio::pin!(reconnect_sleep);

                loop {
                    tokio::select! {
                        _ = &mut reconnect_sleep => break,
                        cmd = command_rx.recv() => {
                            match cmd {
                                Some(WsCommand::Subscribe(channels)) => {
                                    for ch in channels {
                                        subscribed_channels.insert(ch);
                                    }
                                }
                                Some(WsCommand::Unsubscribe(channels)) => {
                                    for ch in channels {
                                        subscribed_channels.remove(&ch);
                                    }
                                }
                                Some(WsCommand::Disconnect) | None => {
                                    should_stop = true;
                                    break;
                                }
                            }
                        }
                    }
                }
            }

            *is_connected.lock().await = false;
        });

        Ok(())
    }

    /// Disconnect from the WebSocket server.
    pub async fn disconnect(&mut self) {
        if let Some(tx) = self.command_tx.take() {
            let _ = tx.send(WsCommand::Disconnect).await;
        }
        *self.is_connected.lock().await = false;
    }

    /// Subscribe to channels.
    pub async fn subscribe(&self, channels: Vec<String>) -> Result<()> {
        if let Some(ref tx) = self.command_tx {
            tx.send(WsCommand::Subscribe(channels))
                .await
                .map_err(|_| RelayError::NotConnected)?;
            Ok(())
        } else {
            Err(RelayError::NotConnected)
        }
    }

    /// Unsubscribe from channels.
    pub async fn unsubscribe(&self, channels: Vec<String>) -> Result<()> {
        if let Some(ref tx) = self.command_tx {
            tx.send(WsCommand::Unsubscribe(channels))
                .await
                .map_err(|_| RelayError::NotConnected)?;
            Ok(())
        } else {
            Err(RelayError::NotConnected)
        }
    }
}

impl Drop for WsClient {
    fn drop(&mut self) {
        // Note: We can't call async disconnect here, but the task will
        // eventually clean up when the channels are dropped
    }
}

fn reconnect_delay_ms(attempt: u32, max_delay_ms: u64) -> u64 {
    let exp = attempt.saturating_sub(1);
    let delay = 1_000u64.saturating_mul(2u64.saturating_pow(exp));
    delay.min(max_delay_ms.max(1_000))
}

async fn send_node_register<S>(
    write: &mut S,
    registration: &NodeRegistration,
) -> std::result::Result<(), tokio_tungstenite::tungstenite::Error>
where
    S: Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let msg = serde_json::json!({
        "v": 1,
        "id": format!("register-{}", registration.node_id),
        "type": "node.register",
        "node_id": registration.node_id,
        "name": registration.name,
        "capabilities": [],
        "max_agents": 1,
        "tags": ["implicit", "direct", "sdk"],
        "version": SDK_VERSION,
        "resume_cursor": null,
    });
    write.send(Message::Text(msg.to_string())).await
}

fn node_delivery_ack(value: &serde_json::Value) -> Option<serde_json::Value> {
    if value.get("type")?.as_str()? != "deliver" {
        return None;
    }
    Some(serde_json::json!({
        "v": 1,
        "type": "delivery.ack",
        "agent": value.get("agent")?.as_str()?,
        "up_to_seq": value.get("seq")?.as_u64()?,
    }))
}

fn normalize_node_deliver(value: serde_json::Value) -> Option<serde_json::Value> {
    if value.get("type")?.as_str()? != "deliver" {
        return None;
    }
    let payload = value.get("payload")?;
    let event_type = payload.get("type")?.as_str()?;
    let data = payload.get("data")?.clone();
    let data_obj = data.as_object()?;

    if event_type == "message.created" {
        return Some(serde_json::json!({
            "type": event_type,
            "channel": data_obj.get("channel_name").and_then(|v| v.as_str()).unwrap_or(""),
            "message": {
                "id": data_obj.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "agent_id": data_obj.get("agent_id").cloned().unwrap_or(serde_json::Value::Null),
                "agent_name": data_obj
                    .get("agent_name")
                    .or_else(|| data_obj.get("from_name"))
                    .cloned()
                    .unwrap_or(serde_json::Value::String("unknown".to_string())),
                "text": data_obj.get("text").cloned().unwrap_or(serde_json::Value::String(String::new())),
                "attachments": data_obj.get("attachments").cloned().unwrap_or_else(|| serde_json::json!([])),
                "injection_mode": data_obj.get("injection_mode").cloned().unwrap_or(serde_json::Value::Null),
            }
        }));
    }

    if event_type == "thread.reply" {
        return Some(serde_json::json!({
            "type": event_type,
            "channel": data_obj.get("channel_name").and_then(|v| v.as_str()).unwrap_or(""),
            "parent_id": data_obj.get("thread_id").cloned().unwrap_or(serde_json::Value::Null),
            "message": {
                "id": data_obj.get("id").cloned().unwrap_or(serde_json::Value::Null),
                "agent_id": data_obj.get("agent_id").cloned().unwrap_or(serde_json::Value::Null),
                "agent_name": data_obj
                    .get("agent_name")
                    .or_else(|| data_obj.get("from_name"))
                    .cloned()
                    .unwrap_or(serde_json::Value::String("unknown".to_string())),
                "text": data_obj.get("text").cloned().unwrap_or(serde_json::Value::String(String::new())),
            }
        }));
    }

    let mut event = data_obj.clone();
    event.insert("type".to_string(), serde_json::Value::String(event_type.to_string()));
    Some(serde_json::Value::Object(event))
}

fn normalize_node_message(value: serde_json::Value) -> Option<serde_json::Value> {
    normalize_node_deliver(value.clone()).or_else(|| normalize_node_action_invoke(value))
}

fn normalize_node_action_invoke(value: serde_json::Value) -> Option<serde_json::Value> {
    if value.get("type")?.as_str()? != "action.invoke" {
        return None;
    }
    Some(serde_json::json!({
        "type": "action.invoked",
        "invocation_id": value.get("invocation_id").cloned().unwrap_or(serde_json::Value::String(String::new())),
        "action_name": value.get("action").cloned().unwrap_or(serde_json::Value::String(String::new())),
        "caller_name": "node",
        "handler_agent_id": value.get("agent_id").cloned().unwrap_or(serde_json::Value::String(String::new())),
        "handler_agent_name": value.get("agent_name").cloned().unwrap_or(serde_json::Value::Null),
        "input": value.get("input").cloned().unwrap_or(serde_json::json!({})),
    }))
}

fn truncate_str(s: &str, max_chars: usize) -> &str {
    match s.char_indices().nth(max_chars) {
        Some((idx, _)) => &s[..idx],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::truncate_str;

    #[test]
    fn truncate_str_respects_utf8_boundaries() {
        let text = "😀".repeat(201);
        let truncated = truncate_str(&text, 200);

        assert_eq!(truncated.chars().count(), 200);
        assert!(truncated.is_char_boundary(truncated.len()));
    }

    #[test]
    fn truncate_str_returns_short_strings_unchanged() {
        assert_eq!(truncate_str("hello", 200), "hello");
    }
}
