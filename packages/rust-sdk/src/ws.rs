//! WebSocket client for real-time events.

use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, Mutex};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{debug, warn};

use crate::error::{RelayError, Result};
use crate::types::WsEvent;

const DEFAULT_BASE_URL: &str = "https://api.agentrelay.dev";
const PING_INTERVAL_SECS: u64 = 30;
const MAX_RECONNECT_ATTEMPTS: u32 = 10;

/// Options for creating a WebSocket client.
#[derive(Debug, Clone)]
pub struct WsClientOptions {
    /// The agent token for authentication.
    pub token: String,
    /// The base URL for the API (defaults to https://api.agentrelay.dev).
    pub base_url: Option<String>,
    /// Enable debug logging for dropped/malformed messages.
    pub debug: bool,
}

impl WsClientOptions {
    /// Create new WebSocket client options with the given token.
    pub fn new(token: impl Into<String>) -> Self {
        Self {
            token: token.into(),
            base_url: None,
            debug: false,
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
}

/// A handle for subscribing to WebSocket events.
pub type EventReceiver = broadcast::Receiver<WsEvent>;

/// WebSocket client for receiving real-time events.
pub struct WsClient {
    token: String,
    base_url: String,
    debug: bool,
    event_tx: broadcast::Sender<WsEvent>,
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
        let base_url = options
            .base_url
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
            .replace("https://", "wss://")
            .replace("http://", "ws://");

        let (event_tx, _) = broadcast::channel(1024);

        Self {
            token: options.token,
            base_url,
            debug: options.debug,
            event_tx,
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

    /// Connect to the WebSocket server.
    pub async fn connect(&mut self) -> Result<()> {
        if *self.is_connected.lock().await {
            return Ok(());
        }

        let url = format!(
            "{}/v1/stream?token={}",
            self.base_url,
            urlencoding::encode(&self.token)
        );

        let (ws_stream, _) = connect_async(&url).await?;
        let (mut write, mut read) = ws_stream.split();

        let (command_tx, mut command_rx) = mpsc::channel::<WsCommand>(32);
        self.command_tx = Some(command_tx);

        let event_tx = self.event_tx.clone();
        let is_connected = self.is_connected.clone();
        let debug = self.debug;

        *is_connected.lock().await = true;

        // Spawn the WebSocket handler task
        tokio::spawn(async move {
            let mut ping_interval = tokio::time::interval(tokio::time::Duration::from_secs(PING_INTERVAL_SECS));

            loop {
                tokio::select! {
                    // Handle incoming messages
                    msg = read.next() => {
                        match msg {
                            Some(Ok(Message::Text(text))) => {
                                match serde_json::from_str::<WsEvent>(&text) {
                                    Ok(event) => {
                                        let _ = event_tx.send(event);
                                    }
                                    Err(e) => {
                                        if debug {
                                            warn!("[relaycast] Dropped WebSocket message: {}: {}", e, &text[..text.len().min(200)]);
                                        }
                                    }
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                debug!("WebSocket connection closed");
                                break;
                            }
                            Some(Err(e)) => {
                                warn!("WebSocket error: {}", e);
                                break;
                            }
                            _ => {}
                        }
                    }

                    // Handle commands
                    cmd = command_rx.recv() => {
                        match cmd {
                            Some(WsCommand::Subscribe(channels)) => {
                                let msg = serde_json::json!({
                                    "type": "subscribe",
                                    "channels": channels
                                });
                                if let Err(e) = write.send(Message::Text(msg.to_string().into())).await {
                                    warn!("Failed to send subscribe: {}", e);
                                }
                            }
                            Some(WsCommand::Unsubscribe(channels)) => {
                                let msg = serde_json::json!({
                                    "type": "unsubscribe",
                                    "channels": channels
                                });
                                if let Err(e) = write.send(Message::Text(msg.to_string().into())).await {
                                    warn!("Failed to send unsubscribe: {}", e);
                                }
                            }
                            Some(WsCommand::Disconnect) | None => {
                                let _ = write.send(Message::Close(None)).await;
                                break;
                            }
                        }
                    }

                    // Send pings
                    _ = ping_interval.tick() => {
                        let ping = serde_json::json!({"type": "ping"});
                        if let Err(e) = write.send(Message::Text(ping.to_string().into())).await {
                            warn!("Failed to send ping: {}", e);
                            break;
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
