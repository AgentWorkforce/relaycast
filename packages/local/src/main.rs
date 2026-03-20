use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::net::SocketAddr;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, Query, State};
use axum::http::header::AUTHORIZATION;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post};
use axum::{Json, Router};
use chrono::Utc;
use clap::Parser;
use rand::distr::Alphanumeric;
use rand::Rng;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tokio::net::TcpListener;
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::{Any, CorsLayer};
use tracing::{debug, info, warn};
use uuid::Uuid;

#[derive(Parser, Debug)]
#[command(name = "local")]
#[command(about = "Local Relaycast-compatible daemon")]
struct Cli {
    #[arg(long, default_value = "127.0.0.1")]
    host: String,
    #[arg(long, default_value_t = 7528)]
    port: u16,
    #[arg(long, default_value = ".agent-relay/state.db")]
    db_path: PathBuf,
    #[arg(long, default_value_t = 2)]
    autosave_secs: u64,
}

#[derive(Clone)]
struct AppState {
    store: Arc<RwLock<Store>>,
    events_tx: broadcast::Sender<RealtimeEvent>,
    persistence: Arc<Persistence>,
}

#[derive(Clone, Serialize, Deserialize, Default)]
struct Store {
    workspaces: HashMap<String, WorkspaceRecord>,
    workspace_by_key: HashMap<String, String>,

    agents: HashMap<String, AgentRecord>,
    agent_by_token: HashMap<String, String>,
    agent_by_workspace_name: HashMap<String, String>,

    channels: HashMap<String, ChannelRecord>,
    channel_by_workspace_name: HashMap<String, String>,
    channel_members: HashMap<String, HashSet<String>>, // channel_id -> agent_ids

    messages: HashMap<String, MessageRecord>,
    channel_messages: HashMap<String, Vec<String>>, // channel_id -> message_ids
    thread_replies: HashMap<String, Vec<String>>,   // parent_message_id -> reply ids

    dm_conversations: HashMap<String, DmConversationRecord>,
    dm_messages: HashMap<String, Vec<String>>, // conversation_id -> message_ids
    dm_by_pair: HashMap<String, String>,       // ws_id:min:max -> conversation_id

    reactions: HashMap<String, HashMap<String, HashSet<String>>>, // message_id -> emoji -> agent_ids
    read_receipts: HashMap<String, HashMap<String, String>>, // message_id -> agent_id -> read_at

    commands: HashMap<String, CommandRecord>, // ws_id:command -> command

    files: HashMap<String, FileRecord>,
    webhooks: HashMap<String, WebhookRecord>,
    subscriptions: HashMap<String, SubscriptionRecord>,

    #[serde(default, skip_serializing, skip_deserializing)]
    ws_connections: HashMap<String, usize>, // agent_id -> count

    activity: Vec<ActivityItem>,
}

#[derive(Clone)]
struct Persistence {
    conn: Arc<std::sync::Mutex<rusqlite::Connection>>,
}

impl Persistence {
    fn open(db_path: &FsPath) -> anyhow::Result<Self> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = rusqlite::Connection::open(db_path)?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS relaycast_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                snapshot TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )?;

        Ok(Self {
            conn: Arc::new(std::sync::Mutex::new(conn)),
        })
    }

    fn load(&self) -> anyhow::Result<Option<Store>> {
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("state database lock poisoned: {}", e))?;
        let snapshot: Option<String> = conn
            .query_row(
                "SELECT snapshot FROM relaycast_state WHERE id = 1",
                [],
                |row| row.get(0),
            )
            .optional()?;

        let Some(snapshot) = snapshot else {
            return Ok(None);
        };

        let store = serde_json::from_str::<Store>(&snapshot)?;
        Ok(Some(store))
    }

    fn save(&self, store: &Store) -> anyhow::Result<()> {
        let snapshot = serde_json::to_string(store)?;
        let conn = self
            .conn
            .lock()
            .map_err(|e| anyhow::anyhow!("state database lock poisoned: {}", e))?;
        conn.execute(
            "INSERT INTO relaycast_state (id, snapshot, updated_at)
             VALUES (1, ?1, ?2)
             ON CONFLICT(id) DO UPDATE SET
               snapshot = excluded.snapshot,
               updated_at = excluded.updated_at",
            params![snapshot, now_iso()],
        )?;
        Ok(())
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct WorkspaceRecord {
    id: String,
    name: String,
    api_key: String,
    created_at: String,
    system_prompt: Option<String>,
    stream_override: Option<bool>,
    metadata: Map<String, Value>,
}

#[derive(Clone, Serialize, Deserialize)]
struct AgentRecord {
    id: String,
    workspace_id: String,
    name: String,
    #[serde(rename = "type")]
    agent_type: String,
    token: String,
    status: String,
    persona: Option<String>,
    metadata: Map<String, Value>,
    created_at: String,
    last_seen: String,
}

#[derive(Clone, Serialize, Deserialize)]
struct ChannelRecord {
    id: String,
    workspace_id: String,
    name: String,
    topic: Option<String>,
    created_by: Option<String>,
    created_at: String,
    is_archived: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct FileAttachment {
    file_id: String,
    filename: String,
    url: String,
    size: i64,
}

#[derive(Clone, Serialize, Deserialize)]
struct MessageRecord {
    id: String,
    workspace_id: String,
    channel_id: Option<String>,
    conversation_id: Option<String>,
    agent_id: String,
    agent_name: String,
    text: String,
    blocks: Option<Vec<Value>>,
    attachments: Vec<FileAttachment>,
    created_at: String,
    thread_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct DmConversationRecord {
    id: String,
    workspace_id: String,
    #[serde(rename = "type")]
    dm_type: String,
    name: Option<String>,
    participant_ids: Vec<String>,
    created_at: String,
    last_message_id: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct CommandRecord {
    id: String,
    workspace_id: String,
    command: String,
    description: String,
    handler_agent_id: String,
    handler_agent_name: String,
    parameters: Vec<CommandParameter>,
    created_at: String,
    is_active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CommandParameter {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(rename = "type")]
    value_type: String,
    #[serde(default)]
    required: Option<bool>,
}

#[derive(Clone, Serialize, Deserialize)]
struct FileRecord {
    file_id: String,
    workspace_id: String,
    filename: String,
    content_type: String,
    size: i64,
    uploaded_by: String,
    created_at: String,
    upload_url: String,
    completed: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct WebhookRecord {
    id: String,
    workspace_id: String,
    name: String,
    channel_id: String,
    channel_name: String,
    url: String,
    created_by: Option<String>,
    created_at: String,
    is_active: bool,
}

#[derive(Clone, Serialize, Deserialize)]
struct SubscriptionFilterRecord {
    channel: Option<String>,
    mentions: Option<String>,
}

#[derive(Clone, Serialize, Deserialize)]
struct SubscriptionRecord {
    id: String,
    workspace_id: String,
    events: Vec<String>,
    filter: Option<SubscriptionFilterRecord>,
    url: String,
    secret: Option<String>,
    is_active: bool,
    created_at: String,
}

#[derive(Clone)]
struct RealtimeEvent {
    workspace_id: String,
    audience: EventAudience,
    payload: Value,
}

#[derive(Clone)]
enum EventAudience {
    Workspace,
    Channel { channel_name: String },
    Agents { agent_ids: HashSet<String> },
}

#[derive(Clone)]
enum AuthContext {
    Workspace {
        workspace_id: String,
    },
    Agent {
        workspace_id: String,
        agent_id: String,
        agent_name: String,
    },
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn new_id(prefix: &str) -> String {
    format!("{}_{}", prefix, Uuid::new_v4().simple())
}

fn random_token(prefix: &str) -> String {
    let rng = rand::rng();
    let suffix: String = rng
        .sample_iter(Alphanumeric)
        .take(28)
        .map(char::from)
        .collect();
    format!("{prefix}{suffix}")
}

fn normalize_workspace_name(name: &str) -> &str {
    name.trim()
}

fn ws_agent_key(workspace_id: &str, name: &str) -> String {
    format!("{workspace_id}:{name}")
}

fn ws_channel_key(workspace_id: &str, name: &str) -> String {
    format!("{workspace_id}:{name}")
}

fn ws_pair_key(workspace_id: &str, a: &str, b: &str) -> String {
    if a <= b {
        format!("{workspace_id}:{a}:{b}")
    } else {
        format!("{workspace_id}:{b}:{a}")
    }
}

fn ok<T: Serialize>(data: T) -> Response {
    (StatusCode::OK, Json(json!({ "ok": true, "data": data }))).into_response()
}

fn created<T: Serialize>(data: T) -> Response {
    (
        StatusCode::CREATED,
        Json(json!({ "ok": true, "data": data })),
    )
        .into_response()
}

fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

fn err(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "ok": false, "error": { "code": code, "message": message.into() } })),
    )
        .into_response()
}

fn json_error() -> Response {
    err(
        StatusCode::BAD_REQUEST,
        "invalid_json",
        "Malformed JSON in request body",
    )
}

fn auth_header_token(headers: &HeaderMap) -> Option<String> {
    headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|v| v.trim().to_string())
}

fn auth_any(store: &Store, headers: &HeaderMap) -> Result<AuthContext, Response> {
    let Some(token) = auth_header_token(headers) else {
        return Err(err(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Missing bearer token",
        ));
    };

    if token.starts_with("rk_") {
        let Some(workspace_id) = store.workspace_by_key.get(&token) else {
            return Err(err(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Invalid workspace key",
            ));
        };
        return Ok(AuthContext::Workspace {
            workspace_id: workspace_id.clone(),
        });
    }

    if token.starts_with("at_") {
        let Some(agent_id) = store.agent_by_token.get(&token) else {
            return Err(err(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Invalid agent token",
            ));
        };
        let Some(agent) = store.agents.get(agent_id) else {
            return Err(err(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Invalid agent token",
            ));
        };

        return Ok(AuthContext::Agent {
            workspace_id: agent.workspace_id.clone(),
            agent_id: agent.id.clone(),
            agent_name: agent.name.clone(),
        });
    }

    Err(err(
        StatusCode::UNAUTHORIZED,
        "invalid_token",
        "Invalid token format",
    ))
}

fn auth_workspace(store: &Store, headers: &HeaderMap) -> Result<String, Response> {
    match auth_any(store, headers)? {
        AuthContext::Workspace { workspace_id } => Ok(workspace_id),
        AuthContext::Agent { .. } => Err(err(
            StatusCode::FORBIDDEN,
            "workspace_key_required",
            "Workspace key required",
        )),
    }
}

fn auth_agent(store: &Store, headers: &HeaderMap) -> Result<(String, String, String), Response> {
    match auth_any(store, headers)? {
        AuthContext::Agent {
            workspace_id,
            agent_id,
            agent_name,
        } => Ok((workspace_id, agent_id, agent_name)),
        AuthContext::Workspace { .. } => Err(err(
            StatusCode::FORBIDDEN,
            "agent_token_required",
            "Agent token required",
        )),
    }
}

fn workspace_from_auth(auth: AuthContext) -> String {
    match auth {
        AuthContext::Workspace { workspace_id } => workspace_id,
        AuthContext::Agent { workspace_id, .. } => workspace_id,
    }
}

fn agent_name_by_id(store: &Store, agent_id: &str) -> String {
    store
        .agents
        .get(agent_id)
        .map(|a| a.name.clone())
        .unwrap_or_else(|| agent_id.to_string())
}

fn reaction_groups(store: &Store, message_id: &str) -> Vec<Value> {
    let Some(by_emoji) = store.reactions.get(message_id) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (emoji, agents) in by_emoji {
        let names = agents
            .iter()
            .map(|id| agent_name_by_id(store, id))
            .collect::<Vec<_>>();
        out.push(json!({
            "emoji": emoji,
            "count": names.len(),
            "agents": names,
        }));
    }
    out.sort_by(|a, b| {
        a.get("emoji")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("emoji").and_then(Value::as_str).unwrap_or(""))
    });
    out
}

fn message_to_json(store: &Store, message: &MessageRecord) -> Value {
    let reply_count = store
        .thread_replies
        .get(&message.id)
        .map(|v| v.len() as i64)
        .unwrap_or(0);

    let read_by_count = store
        .read_receipts
        .get(&message.id)
        .map(|v| v.len() as i64)
        .unwrap_or(0);

    json!({
        "id": message.id,
        "agent_id": message.agent_id,
        "agent_name": message.agent_name,
        "text": message.text,
        "blocks": message.blocks,
        "attachments": message.attachments,
        "created_at": message.created_at,
        "reply_count": reply_count,
        "reactions": reaction_groups(store, &message.id),
        "read_by_count": read_by_count,
    })
}

fn channel_to_json(store: &Store, channel: &ChannelRecord) -> Value {
    let member_count = store
        .channel_members
        .get(&channel.id)
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    json!({
        "id": channel.id,
        "workspace_id": channel.workspace_id,
        "name": channel.name,
        "channel_type": 0,
        "topic": channel.topic,
        "created_by": channel.created_by,
        "created_at": channel.created_at,
        "is_archived": channel.is_archived,
        "member_count": member_count,
    })
}

fn file_info_json(file: &FileRecord) -> Value {
    json!({
        "file_id": file.file_id,
        "filename": file.filename,
        "content_type": file.content_type,
        "size": file.size,
        "url": file.upload_url,
        "uploaded_by": file.uploaded_by,
        "created_at": file.created_at,
    })
}

fn publish(state: &AppState, event: RealtimeEvent) {
    if let Err(e) = state.events_tx.send(event) {
        debug!("no websocket listeners: {}", e);
    }
}

async fn persist_state(state: &AppState) {
    let snapshot = { state.store.read().await.clone() };
    if let Err(e) = state.persistence.save(&snapshot) {
        warn!("failed to persist state snapshot: {}", e);
    }
}

async fn set_agent_status(
    state: &AppState,
    workspace_id: &str,
    agent_id: &str,
    status: &str,
    emit_event: bool,
) {
    let mut store = state.store.write().await;
    let Some(agent) = store.agents.get_mut(agent_id) else {
        return;
    };

    if agent.workspace_id != workspace_id {
        return;
    }

    let old = agent.status.clone();
    agent.status = status.to_string();
    agent.last_seen = now_iso();

    if emit_event && old != status {
        let agent_name = agent.name.clone();
        drop(store);

        let payload = if status == "online" {
            json!({ "type": "agent.online", "agent": { "name": agent_name } })
        } else {
            json!({ "type": "agent.offline", "agent": { "name": agent_name } })
        };
        publish(
            state,
            RealtimeEvent {
                workspace_id: workspace_id.to_string(),
                audience: EventAudience::Workspace,
                payload,
            },
        );
    }
}

#[derive(Debug, Deserialize)]
struct CreateWorkspaceRequest {
    name: String,
}

async fn create_workspace(
    State(state): State<AppState>,
    payload: Result<Json<CreateWorkspaceRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let workspace_name = normalize_workspace_name(&payload.name);
    if workspace_name.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "name is required",
        );
    }

    let workspace_name = workspace_name.to_string();
    let workspace_id = new_id("ws");
    let api_key = random_token("rk_live_");
    let created_at = now_iso();

    let workspace = WorkspaceRecord {
        id: workspace_id.clone(),
        name: workspace_name.clone(),
        api_key: api_key.clone(),
        created_at: created_at.clone(),
        system_prompt: None,
        stream_override: None,
        metadata: Map::new(),
    };

    let mut store = state.store.write().await;
    let duplicate = store.workspaces.values().any(|ws| ws.name == workspace_name);
    if duplicate {
        return err(
            StatusCode::CONFLICT,
            "workspace_already_exists",
            format!("Workspace \"{}\" already exists", workspace_name),
        );
    }
    store
        .workspace_by_key
        .insert(api_key.clone(), workspace_id.clone());
    store.workspaces.insert(workspace_id.clone(), workspace);

    // Hosted parity: new workspaces start with a default #general channel.
    let general_channel = ChannelRecord {
        id: new_id("ch"),
        workspace_id: workspace_id.clone(),
        name: "general".to_string(),
        topic: Some("General discussion".to_string()),
        created_by: None,
        created_at: now_iso(),
        is_archived: false,
    };
    let general_key = ws_channel_key(&workspace_id, "general");
    store
        .channel_by_workspace_name
        .insert(general_key, general_channel.id.clone());
    store
        .channel_members
        .insert(general_channel.id.clone(), HashSet::new());
    store
        .channels
        .insert(general_channel.id.clone(), general_channel);

    created(json!({
        "workspace_id": workspace_id,
        "api_key": api_key,
        "created_at": created_at,
    }))
}

async fn health() -> Response {
    (
        StatusCode::OK,
        Json(json!({
            "ok": true,
            "service": "local",
            "version": "0.1.0",
            "timestamp": now_iso(),
        })),
    )
        .into_response()
}

async fn get_workspace_by_name(
    State(state): State<AppState>,
    Path(name): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let lookup_name = normalize_workspace_name(&name);

    let Some(ws) = store.workspaces.values().find(|ws| ws.name == lookup_name) else {
        return err(
            StatusCode::NOT_FOUND,
            "workspace_not_found",
            "Workspace not found",
        );
    };

    ok(json!({
        "id": ws.id,
        "name": ws.name,
        "created_at": ws.created_at,
    }))
}

async fn get_workspace(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let Some(ws) = store.workspaces.get(&workspace_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Workspace not found");
    };

    ok(json!({
        "id": ws.id,
        "name": ws.name,
        "api_key_hash": ws.api_key,
        "system_prompt": ws.system_prompt,
        "plan": "free",
        "created_at": ws.created_at,
        "metadata": ws.metadata,
    }))
}

#[derive(Debug, Deserialize)]
struct PatchWorkspaceRequest {
    name: Option<String>,
    system_prompt: Option<String>,
}

async fn patch_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<PatchWorkspaceRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let Some(ws) = store.workspaces.get_mut(&workspace_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Workspace not found");
    };

    if let Some(name) = payload.name {
        let name = normalize_workspace_name(&name);
        if name.is_empty() {
            return err(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "name cannot be empty",
            );
        }
        ws.name = name.to_string();
    }

    if let Some(prompt) = payload.system_prompt {
        ws.system_prompt = Some(prompt);
    }

    ok(json!({
        "id": ws.id,
        "name": ws.name,
        "api_key_hash": ws.api_key,
        "system_prompt": ws.system_prompt,
        "plan": "free",
        "created_at": ws.created_at,
        "metadata": ws.metadata,
    }))
}

async fn delete_workspace(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let Some(ws) = store.workspaces.remove(&workspace_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Workspace not found");
    };
    store.workspace_by_key.remove(&ws.api_key);

    let remove_agent_ids = store
        .agents
        .values()
        .filter(|a| a.workspace_id == workspace_id)
        .map(|a| a.id.clone())
        .collect::<Vec<_>>();
    for id in remove_agent_ids {
        if let Some(agent) = store.agents.remove(&id) {
            store.agent_by_token.remove(&agent.token);
            store
                .agent_by_workspace_name
                .remove(&ws_agent_key(&workspace_id, &agent.name));
        }
    }

    let remove_channel_ids = store
        .channels
        .values()
        .filter(|c| c.workspace_id == workspace_id)
        .map(|c| c.id.clone())
        .collect::<Vec<_>>();

    for id in remove_channel_ids {
        if let Some(ch) = store.channels.remove(&id) {
            store
                .channel_by_workspace_name
                .remove(&ws_channel_key(&workspace_id, &ch.name));
        }
        store.channel_members.remove(&id);
        store.channel_messages.remove(&id);
    }

    let remove_messages = store
        .messages
        .values()
        .filter(|m| m.workspace_id == workspace_id)
        .map(|m| m.id.clone())
        .collect::<Vec<_>>();

    for id in remove_messages {
        store.messages.remove(&id);
        store.thread_replies.remove(&id);
        store.reactions.remove(&id);
        store.read_receipts.remove(&id);
    }

    let remove_conversations = store
        .dm_conversations
        .values()
        .filter(|c| c.workspace_id == workspace_id)
        .map(|c| c.id.clone())
        .collect::<Vec<_>>();

    for id in remove_conversations {
        store.dm_conversations.remove(&id);
        store.dm_messages.remove(&id);
    }

    store
        .dm_by_pair
        .retain(|k, _| !k.starts_with(&format!("{workspace_id}:")));
    store
        .commands
        .retain(|k, _| !k.starts_with(&format!("{workspace_id}:")));

    no_content()
}

async fn get_workspace_stream(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };
    let Some(ws) = store.workspaces.get(&workspace_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Workspace not found");
    };

    let enabled = ws.stream_override.unwrap_or(true);
    ok(json!({
        "enabled": enabled,
        "default_enabled": true,
        "override": ws.stream_override,
    }))
}

#[derive(Debug, Deserialize)]
struct PutWorkspaceStreamRequest {
    enabled: Option<bool>,
    mode: Option<String>,
}

async fn put_workspace_stream(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<PutWorkspaceStreamRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let Some(ws) = store.workspaces.get_mut(&workspace_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Workspace not found");
    };

    if payload.mode.as_deref() == Some("inherit") {
        ws.stream_override = None;
    } else if let Some(enabled) = payload.enabled {
        ws.stream_override = Some(enabled);
    } else {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Provide enabled or mode=inherit",
        );
    }

    let enabled = ws.stream_override.unwrap_or(true);
    ok(json!({
        "enabled": enabled,
        "default_enabled": true,
        "override": ws.stream_override,
    }))
}

async fn get_system_prompt(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(auth) => auth,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let Some(ws) = store.workspaces.get(&workspace_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Workspace not found");
    };

    let default_prompt = "You are a helpful assistant.";
    let prompt = ws
        .system_prompt
        .clone()
        .unwrap_or_else(|| default_prompt.to_string());

    ok(json!({
        "prompt": prompt,
        "is_default": ws.system_prompt.is_none(),
    }))
}

#[derive(Debug, Deserialize)]
struct SetSystemPromptRequest {
    prompt: Option<String>,
    reset: Option<bool>,
}

async fn put_system_prompt(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<SetSystemPromptRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let Some(ws) = store.workspaces.get_mut(&workspace_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Workspace not found");
    };

    if payload.reset.unwrap_or(false) {
        ws.system_prompt = None;
    } else {
        let Some(prompt) = payload.prompt else {
            return err(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "prompt is required unless reset=true",
            );
        };
        ws.system_prompt = Some(prompt);
    }

    let default_prompt = "You are a helpful assistant.";
    let prompt = ws
        .system_prompt
        .clone()
        .unwrap_or_else(|| default_prompt.to_string());

    ok(json!({
        "prompt": prompt,
        "is_default": ws.system_prompt.is_none(),
    }))
}

#[derive(Debug, Deserialize)]
struct CreateAgentRequest {
    name: String,
    #[serde(rename = "type")]
    agent_type: Option<String>,
    persona: Option<String>,
    metadata: Option<Map<String, Value>>,
}

async fn create_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<CreateAgentRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.name.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "name is required",
        );
    }

    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let key = ws_agent_key(&workspace_id, payload.name.trim());
    if store.agent_by_workspace_name.contains_key(&key) {
        return err(
            StatusCode::CONFLICT,
            "agent_already_exists",
            format!("Agent \"{}\" already exists", payload.name.trim()),
        );
    }

    let id = new_id("ag");
    let token = random_token("at_live_");
    let created_at = now_iso();
    let agent = AgentRecord {
        id: id.clone(),
        workspace_id: workspace_id.clone(),
        name: payload.name.trim().to_string(),
        agent_type: payload.agent_type.unwrap_or_else(|| "agent".to_string()),
        token: token.clone(),
        status: "online".to_string(),
        persona: payload.persona,
        metadata: payload.metadata.unwrap_or_default(),
        created_at: created_at.clone(),
        last_seen: created_at.clone(),
    };

    store.agent_by_token.insert(token.clone(), id.clone());
    store.agent_by_workspace_name.insert(key, id.clone());
    store.agents.insert(id.clone(), agent.clone());

    // Hosted parity: newly registered agents auto-join #general when present.
    let general_key = ws_channel_key(&workspace_id, "general");
    if let Some(general_channel_id) = store.channel_by_workspace_name.get(&general_key).cloned() {
        store
            .channel_members
            .entry(general_channel_id)
            .or_default()
            .insert(id.clone());
    }

    created(json!({
        "id": id,
        "name": agent.name,
        "token": token,
        "status": "online",
        "created_at": created_at,
        "workspace_id": workspace_id,
    }))
}

#[derive(Debug, Deserialize)]
struct ListAgentsQuery {
    status: Option<String>,
}

async fn list_agents(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListAgentsQuery>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let mut out = Vec::new();
    for agent in store.agents.values() {
        if agent.workspace_id != workspace_id {
            continue;
        }
        if let Some(ref status) = query.status {
            if &agent.status != status {
                continue;
            }
        }

        out.push(json!({
            "id": agent.id,
            "workspace_id": agent.workspace_id,
            "name": agent.name,
            "type": agent.agent_type,
            "token_hash": agent.token,
            "status": agent.status,
            "persona": agent.persona,
            "metadata": agent.metadata,
            "created_at": agent.created_at,
            "last_seen": agent.last_seen,
        }));
    }

    out.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });

    ok(out)
}

async fn get_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let key = ws_agent_key(&workspace_id, &name);
    let Some(agent_id) = store.agent_by_workspace_name.get(&key) else {
        return err(StatusCode::NOT_FOUND, "agent_not_found", "Agent not found");
    };

    let Some(agent) = store.agents.get(agent_id) else {
        return err(StatusCode::NOT_FOUND, "agent_not_found", "Agent not found");
    };

    ok(json!({
        "id": agent.id,
        "workspace_id": agent.workspace_id,
        "name": agent.name,
        "type": agent.agent_type,
        "token_hash": agent.token,
        "status": agent.status,
        "persona": agent.persona,
        "metadata": agent.metadata,
        "created_at": agent.created_at,
        "last_seen": agent.last_seen,
    }))
}

#[derive(Debug, Deserialize)]
struct UpdateAgentRequest {
    status: Option<String>,
    persona: Option<String>,
    metadata: Option<Map<String, Value>>,
}

async fn update_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    payload: Result<Json<UpdateAgentRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let key = ws_agent_key(&workspace_id, &name);
    let Some(agent_id) = store.agent_by_workspace_name.get(&key).cloned() else {
        return err(StatusCode::NOT_FOUND, "agent_not_found", "Agent not found");
    };

    let Some(agent) = store.agents.get_mut(&agent_id) else {
        return err(StatusCode::NOT_FOUND, "agent_not_found", "Agent not found");
    };

    if let Some(status) = payload.status {
        if status != "online" && status != "offline" {
            return err(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "status must be online or offline",
            );
        }
        agent.status = status;
    }

    if let Some(persona) = payload.persona {
        agent.persona = Some(persona);
    }

    if let Some(metadata) = payload.metadata {
        agent.metadata = metadata;
    }

    agent.last_seen = now_iso();

    ok(json!({
        "id": agent.id,
        "workspace_id": agent.workspace_id,
        "name": agent.name,
        "type": agent.agent_type,
        "token_hash": agent.token,
        "status": agent.status,
        "persona": agent.persona,
        "metadata": agent.metadata,
        "created_at": agent.created_at,
        "last_seen": agent.last_seen,
    }))
}

async fn delete_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let key = ws_agent_key(&workspace_id, &name);
    let Some(agent_id) = store.agent_by_workspace_name.remove(&key) else {
        return err(StatusCode::NOT_FOUND, "agent_not_found", "Agent not found");
    };

    if let Some(agent) = store.agents.remove(&agent_id) {
        store.agent_by_token.remove(&agent.token);
        store.ws_connections.remove(&agent_id);

        for members in store.channel_members.values_mut() {
            members.remove(&agent_id);
        }

        for conversation in store.dm_conversations.values_mut() {
            conversation.participant_ids.retain(|id| id != &agent_id);
        }
    }

    no_content()
}

async fn rotate_agent_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let key = ws_agent_key(&workspace_id, &name);
    let Some(agent_id) = store.agent_by_workspace_name.get(&key).cloned() else {
        return err(StatusCode::NOT_FOUND, "agent_not_found", "Agent not found");
    };

    let (agent_name, old_token, token) = {
        let Some(agent) = store.agents.get_mut(&agent_id) else {
            return err(StatusCode::NOT_FOUND, "agent_not_found", "Agent not found");
        };
        let old_token = agent.token.clone();
        let token = random_token("at_live_");
        agent.token = token.clone();
        agent.last_seen = now_iso();
        (agent.name.clone(), old_token, token)
    };

    store.agent_by_token.remove(&old_token);
    store.agent_by_token.insert(token.clone(), agent_id);

    ok(json!({
        "name": agent_name,
        "token": token,
    }))
}

async fn get_presence(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let mut out = Vec::new();
    for agent in store.agents.values() {
        if agent.workspace_id != workspace_id {
            continue;
        }
        out.push(json!({
            "agent_id": agent.id,
            "agent_name": agent.name,
            "status": agent.status,
        }));
    }
    out.sort_by(|a, b| {
        a.get("agent_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("agent_name").and_then(Value::as_str).unwrap_or(""))
    });

    ok(out)
}

async fn heartbeat(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (workspace_id, agent_id, _) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    set_agent_status(&state, &workspace_id, &agent_id, "online", true).await;
    ok(json!({}))
}

async fn disconnect_agent(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (workspace_id, agent_id, _) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    set_agent_status(&state, &workspace_id, &agent_id, "offline", true).await;
    ok(json!({}))
}

#[derive(Debug, Deserialize)]
struct SpawnAgentRequest {
    name: String,
    cli: String,
    task: String,
    channel: Option<String>,
    persona: Option<String>,
    metadata: Option<Value>,
}

async fn spawn_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<SpawnAgentRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.name.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "name is required",
        );
    }
    if payload.cli.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "cli is required",
        );
    }
    if payload.task.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "task is required",
        );
    }

    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let key = ws_agent_key(&workspace_id, payload.name.trim());

    let (agent_id, token, created_at, already_existed, agent_name) =
        if let Some(existing_id) = store.agent_by_workspace_name.get(&key).cloned() {
            let (old_token, token, created_at, agent_name) = {
                let Some(agent) = store.agents.get_mut(&existing_id) else {
                    return err(
                        StatusCode::INTERNAL_SERVER_ERROR,
                        "internal_error",
                        "Agent lookup failed",
                    );
                };
                let old_token = agent.token.clone();
                let token = random_token("at_live_");
                agent.token = token.clone();
                agent.status = "online".to_string();
                agent.last_seen = now_iso();
                (
                    old_token,
                    token,
                    agent.created_at.clone(),
                    agent.name.clone(),
                )
            };
            store.agent_by_token.remove(&old_token);
            store
                .agent_by_token
                .insert(token.clone(), existing_id.clone());
            (existing_id, token, created_at, true, agent_name)
        } else {
            let id = new_id("ag");
            let token = random_token("at_live_");
            let created_at = now_iso();
            let agent = AgentRecord {
                id: id.clone(),
                workspace_id: workspace_id.clone(),
                name: payload.name.trim().to_string(),
                agent_type: "agent".to_string(),
                token: token.clone(),
                status: "online".to_string(),
                persona: payload.persona.clone(),
                metadata: payload
                    .metadata
                    .clone()
                    .and_then(|v| v.as_object().cloned())
                    .unwrap_or_default(),
                created_at: created_at.clone(),
                last_seen: created_at.clone(),
            };
            store.agent_by_token.insert(token.clone(), id.clone());
            store.agent_by_workspace_name.insert(key, id.clone());
            store.agents.insert(id.clone(), agent.clone());
            (id, token, created_at, false, agent.name)
        };

    // Hosted parity: spawned agents should be members of #general by default.
    let general_key = ws_channel_key(&workspace_id, "general");
    if let Some(general_channel_id) = store.channel_by_workspace_name.get(&general_key).cloned() {
        store
            .channel_members
            .entry(general_channel_id)
            .or_default()
            .insert(agent_id.clone());
    }

    store.activity.push(ActivityItem {
        item_type: "agent.spawn_requested".to_string(),
        id: new_id("act"),
        channel_name: payload.channel.clone(),
        conversation_id: None,
        agent_name: agent_name.clone(),
        text: payload.task.clone(),
        created_at: now_iso(),
    });

    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id: workspace_id.clone(),
            audience: EventAudience::Workspace,
            payload: json!({
                "type": "agent.spawn_requested",
                "agent": {
                    "name": agent_name,
                    "cli": payload.cli,
                    "task": payload.task,
                    "channel": payload.channel,
                    "already_existed": already_existed,
                }
            }),
        },
    );

    let body = json!({
        "id": agent_id,
        "name": payload.name.trim(),
        "token": token,
        "cli": payload.cli,
        "task": payload.task,
        "channel": payload.channel,
        "status": "online",
        "created_at": created_at,
        "already_existed": already_existed,
    });

    if already_existed {
        ok(body)
    } else {
        created(body)
    }
}

#[derive(Debug, Deserialize)]
struct ReleaseAgentRequest {
    name: String,
    reason: Option<String>,
    delete_agent: Option<bool>,
}

async fn release_agent(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<ReleaseAgentRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.name.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "name is required",
        );
    }

    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(id) => id,
        Err(r) => return r,
    };

    let key = ws_agent_key(&workspace_id, payload.name.trim());
    let Some(agent_id) = store.agent_by_workspace_name.get(&key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "agent_not_found",
            format!("Agent \"{}\" not found", payload.name.trim()),
        );
    };

    let delete_agent = payload.delete_agent.unwrap_or(false);
    if delete_agent {
        store.agent_by_workspace_name.remove(&key);
        if let Some(agent) = store.agents.remove(&agent_id) {
            store.agent_by_token.remove(&agent.token);
            store.ws_connections.remove(&agent_id);
        }
    } else if let Some(agent) = store.agents.get_mut(&agent_id) {
        agent.status = "offline".to_string();
        agent.last_seen = now_iso();
    }

    store.activity.push(ActivityItem {
        item_type: "agent.release_requested".to_string(),
        id: new_id("act"),
        channel_name: None,
        conversation_id: None,
        agent_name: payload.name.clone(),
        text: payload.reason.clone().unwrap_or_default(),
        created_at: now_iso(),
    });

    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id: workspace_id.clone(),
            audience: EventAudience::Workspace,
            payload: json!({
                "type": "agent.release_requested",
                "agent": {
                    "name": payload.name,
                },
                "reason": payload.reason,
                "deleted": delete_agent,
            }),
        },
    );

    ok(json!({
        "name": payload.name,
        "released": true,
        "deleted": delete_agent,
        "reason": payload.reason,
    }))
}

#[derive(Debug, Deserialize)]
struct CreateChannelRequest {
    name: String,
    topic: Option<String>,
}

async fn create_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<CreateChannelRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let name = payload.name.trim();
    if name.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "name is required",
        );
    }

    let mut store = state.store.write().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth.clone());
    let created_by = match auth {
        AuthContext::Agent { agent_id, .. } => Some(agent_id),
        AuthContext::Workspace { .. } => None,
    };

    let key = ws_channel_key(&workspace_id, name);
    if store.channel_by_workspace_name.contains_key(&key) {
        return err(
            StatusCode::CONFLICT,
            "channel_already_exists",
            format!("Channel \"{name}\" already exists"),
        );
    }

    let channel = ChannelRecord {
        id: new_id("ch"),
        workspace_id: workspace_id.clone(),
        name: name.to_string(),
        topic: payload.topic.clone(),
        created_by: created_by.clone(),
        created_at: now_iso(),
        is_archived: false,
    };

    store
        .channel_by_workspace_name
        .insert(key, channel.id.clone());
    store
        .channel_members
        .insert(channel.id.clone(), HashSet::new());
    if let Some(agent_id) = created_by {
        store
            .channel_members
            .entry(channel.id.clone())
            .or_default()
            .insert(agent_id);
    }
    store.channels.insert(channel.id.clone(), channel.clone());

    store.activity.push(ActivityItem {
        item_type: "channel.created".to_string(),
        id: new_id("act"),
        channel_name: Some(channel.name.clone()),
        conversation_id: None,
        agent_name: String::new(),
        text: channel.topic.clone().unwrap_or_default(),
        created_at: now_iso(),
    });

    let response = channel_to_json(&store, &channel);
    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Workspace,
            payload: json!({
                "type": "channel.created",
                "channel": {
                    "name": channel.name,
                    "topic": channel.topic,
                }
            }),
        },
    );

    created(response)
}

#[derive(Debug, Deserialize)]
struct ChannelsQuery {
    include_archived: Option<bool>,
}

async fn list_channels(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ChannelsQuery>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let include_archived = query.include_archived.unwrap_or(false);
    let mut out = Vec::new();
    for channel in store.channels.values() {
        if channel.workspace_id != workspace_id {
            continue;
        }
        if !include_archived && channel.is_archived {
            continue;
        }
        out.push(channel_to_json(&store, channel));
    }

    out.sort_by(|a, b| {
        a.get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("name").and_then(Value::as_str).unwrap_or(""))
    });

    ok(out)
}

async fn get_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&key) else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };
    let Some(channel) = store.channels.get(channel_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };

    let members = store
        .channel_members
        .get(channel_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|agent_id| {
            store.agents.get(&agent_id).map(|agent| {
                json!({
                    "agent_id": agent.id,
                    "agent_name": agent.name,
                    "role": "member",
                    "joined_at": agent.created_at,
                })
            })
        })
        .collect::<Vec<_>>();

    ok(json!({
        "id": channel.id,
        "workspace_id": channel.workspace_id,
        "name": channel.name,
        "channel_type": 0,
        "topic": channel.topic,
        "created_by": channel.created_by,
        "created_at": channel.created_at,
        "is_archived": channel.is_archived,
        "member_count": members.len(),
        "members": members,
    }))
}

#[derive(Debug, Deserialize)]
struct ChannelTopicRequest {
    topic: Option<String>,
}

async fn patch_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    payload: Result<Json<ChannelTopicRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    patch_channel_topic_internal(state, headers, name, payload).await
}

async fn patch_channel_topic(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    payload: Result<Json<ChannelTopicRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    patch_channel_topic_internal(state, headers, name, payload).await
}

async fn patch_channel_topic_internal(
    state: AppState,
    headers: HeaderMap,
    name: String,
    payload: Result<Json<ChannelTopicRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let mut store = state.store.write().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };

    let (channel_name, channel_topic) = {
        let Some(channel) = store.channels.get_mut(&channel_id) else {
            return err(
                StatusCode::NOT_FOUND,
                "channel_not_found",
                "Channel not found",
            );
        };
        channel.topic = payload.topic.clone();
        (channel.name.clone(), channel.topic.clone())
    };
    let Some(channel_after) = store.channels.get(&channel_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };
    let response = channel_to_json(&store, channel_after);

    let event_payload = json!({
        "type": "channel.updated",
        "channel": {
            "name": channel_name,
            "topic": channel_topic,
        }
    });

    drop(store);
    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Channel { channel_name: name },
            payload: event_payload,
        },
    );

    ok(response)
}

async fn archive_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let mut store = state.store.write().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };
    let Some(channel) = store.channels.get_mut(&channel_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };
    channel.is_archived = true;

    drop(store);
    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Channel {
                channel_name: name.clone(),
            },
            payload: json!({
                "type": "channel.archived",
                "channel": { "name": name },
            }),
        },
    );

    no_content()
}

async fn join_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };

    let members = store.channel_members.entry(channel_id).or_default();
    let joined = members.insert(agent_id.clone());

    drop(store);

    if joined {
        publish(
            &state,
            RealtimeEvent {
                workspace_id,
                audience: EventAudience::Channel {
                    channel_name: name.clone(),
                },
                payload: json!({
                    "type": "member.joined",
                    "channel": name,
                    "agent_name": agent_name,
                }),
            },
        );
    }

    ok(json!({ "joined": true }))
}

async fn leave_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };

    let mut removed = false;
    if let Some(members) = store.channel_members.get_mut(&channel_id) {
        removed = members.remove(&agent_id);
    }

    drop(store);

    if removed {
        publish(
            &state,
            RealtimeEvent {
                workspace_id,
                audience: EventAudience::Channel {
                    channel_name: name.clone(),
                },
                payload: json!({
                    "type": "member.left",
                    "channel": name,
                    "agent_name": agent_name,
                }),
            },
        );
    }

    no_content()
}

#[derive(Debug, Deserialize)]
struct InviteChannelRequest {
    agent: String,
}

async fn invite_to_channel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    payload: Result<Json<InviteChannelRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.agent.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "agent is required",
        );
    }

    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let channel_key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&channel_key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };

    let agent_key = ws_agent_key(&workspace_id, payload.agent.trim());
    let Some(agent_id) = store.agent_by_workspace_name.get(&agent_key).cloned() else {
        return err(StatusCode::NOT_FOUND, "agent_not_found", "Agent not found");
    };
    drop(store);

    let mut store = state.store.write().await;
    store
        .channel_members
        .entry(channel_id)
        .or_default()
        .insert(agent_id.clone());
    let agent_name = store
        .agents
        .get(&agent_id)
        .map(|a| a.name.clone())
        .unwrap_or(payload.agent.clone());
    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Channel {
                channel_name: name.clone(),
            },
            payload: json!({
                "type": "member.joined",
                "channel": name,
                "agent_name": agent_name,
            }),
        },
    );

    ok(json!({ "invited": true }))
}

async fn channel_members(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };

    let mut members = Vec::new();
    if let Some(set) = store.channel_members.get(&channel_id) {
        for agent_id in set {
            if let Some(agent) = store.agents.get(agent_id) {
                members.push(json!({
                    "agent_id": agent.id,
                    "agent_name": agent.name,
                    "role": "member",
                    "joined_at": agent.created_at,
                }));
            }
        }
    }
    members.sort_by(|a, b| {
        a.get("agent_name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("agent_name").and_then(Value::as_str).unwrap_or(""))
    });

    ok(members)
}

async fn read_status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            "Channel not found",
        );
    };

    let message_ids = store
        .channel_messages
        .get(&channel_id)
        .cloned()
        .unwrap_or_default();

    let mut members = Vec::new();
    if let Some(agent_ids) = store.channel_members.get(&channel_id) {
        for agent_id in agent_ids {
            if let Some(agent) = store.agents.get(agent_id) {
                let mut unread = 0;
                for message_id in &message_ids {
                    if let Some(message) = store.messages.get(message_id) {
                        if message.agent_id == agent.id {
                            continue;
                        }
                        let seen = store
                            .read_receipts
                            .get(message_id)
                            .and_then(|v| v.get(agent_id))
                            .is_some();
                        if !seen {
                            unread += 1;
                        }
                    }
                }
                members.push(json!({
                    "agent_id": agent.id,
                    "agent_name": agent.name,
                    "unread_count": unread,
                }));
            }
        }
    }

    ok(json!({
        "channel": name,
        "members": members,
    }))
}

#[derive(Debug, Deserialize)]
struct PostMessageRequest {
    text: String,
    blocks: Option<Vec<Value>>,
    attachments: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct MessageListQuery {
    limit: Option<usize>,
    before: Option<String>,
    after: Option<String>,
}

async fn post_channel_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    payload: Result<Json<PostMessageRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };
    if payload.text.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "text is required",
        );
    }

    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let channel_key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&channel_key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            format!("Channel \"{}\" not found", name),
        );
    };

    store
        .channel_members
        .entry(channel_id.clone())
        .or_default()
        .insert(agent_id.clone());

    let attachments = payload
        .attachments
        .unwrap_or_default()
        .into_iter()
        .map(|id| FileAttachment {
            file_id: id.clone(),
            filename: id.clone(),
            url: format!("/v1/files/{id}"),
            size: 0,
        })
        .collect::<Vec<_>>();

    let message = MessageRecord {
        id: new_id("msg"),
        workspace_id: workspace_id.clone(),
        channel_id: Some(channel_id.clone()),
        conversation_id: None,
        agent_id: agent_id.clone(),
        agent_name: agent_name.clone(),
        text: payload.text.clone(),
        blocks: payload.blocks.clone(),
        attachments: attachments.clone(),
        created_at: now_iso(),
        thread_id: None,
    };

    store
        .channel_messages
        .entry(channel_id)
        .or_default()
        .push(message.id.clone());
    store.messages.insert(message.id.clone(), message.clone());

    store.activity.push(ActivityItem {
        item_type: "message.created".to_string(),
        id: new_id("act"),
        channel_name: Some(name.clone()),
        conversation_id: None,
        agent_name: agent_name.clone(),
        text: message.text.clone(),
        created_at: message.created_at.clone(),
    });

    let response = message_to_json(&store, &message);
    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Channel {
                channel_name: name.clone(),
            },
            payload: json!({
                "type": "message.created",
                "channel": name,
                "message": {
                    "id": message.id,
                    "agent_id": message.agent_id,
                    "agent_name": message.agent_name,
                    "text": message.text,
                    "attachments": attachments,
                }
            }),
        },
    );

    created(response)
}

fn apply_message_cursor(ids: &[String], query: &MessageListQuery) -> Vec<String> {
    let mut out = ids.to_vec();

    if let Some(before) = &query.before {
        if let Some(pos) = out.iter().position(|id| id == before) {
            out = out.into_iter().take(pos).collect();
        }
    }

    if let Some(after) = &query.after {
        if let Some(pos) = out.iter().position(|id| id == after) {
            out = out.into_iter().skip(pos + 1).collect();
        }
    }

    if let Some(limit) = query.limit {
        if out.len() > limit {
            out = out.into_iter().rev().take(limit).collect::<Vec<_>>();
            out.reverse();
        }
    }

    out
}

async fn list_channel_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(name): Path<String>,
    Query(query): Query<MessageListQuery>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let channel_key = ws_channel_key(&workspace_id, &name);
    let Some(channel_id) = store.channel_by_workspace_name.get(&channel_key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            format!("Channel \"{}\" not found", name),
        );
    };

    let ids = store
        .channel_messages
        .get(&channel_id)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|id| {
            store
                .messages
                .get(id)
                .map(|message| message.thread_id.is_none())
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    let ids = apply_message_cursor(&ids, &query);

    let mut out = Vec::new();
    for id in ids.into_iter().rev() {
        if let Some(message) = store.messages.get(&id) {
            out.push(message_to_json(&store, message));
        }
    }

    ok(out)
}

async fn get_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let Some(message) = store.messages.get(&message_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    };

    if message.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    }

    ok(message_to_json(&store, message))
}

#[derive(Debug, Deserialize)]
struct ThreadReplyRequest {
    text: String,
    blocks: Option<Vec<Value>>,
}

async fn post_thread_reply(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(parent_id): Path<String>,
    payload: Result<Json<ThreadReplyRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };
    if payload.text.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "text is required",
        );
    }

    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let Some(parent) = store.messages.get(&parent_id).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    };

    if parent.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    }

    let Some(channel_id) = parent.channel_id.clone() else {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Cannot reply to non-channel message",
        );
    };

    let channel_name = store
        .channels
        .get(&channel_id)
        .map(|ch| ch.name.clone())
        .unwrap_or_else(|| "unknown".to_string());

    let message = MessageRecord {
        id: new_id("msg"),
        workspace_id: workspace_id.clone(),
        channel_id: Some(channel_id.clone()),
        conversation_id: None,
        agent_id: agent_id.clone(),
        agent_name: agent_name.clone(),
        text: payload.text,
        blocks: payload.blocks,
        attachments: Vec::new(),
        created_at: now_iso(),
        thread_id: Some(parent_id.clone()),
    };

    store
        .channel_messages
        .entry(channel_id)
        .or_default()
        .push(message.id.clone());
    store
        .thread_replies
        .entry(parent_id.clone())
        .or_default()
        .push(message.id.clone());
    store.messages.insert(message.id.clone(), message.clone());

    let response = message_to_json(&store, &message);
    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Channel { channel_name },
            payload: json!({
                "type": "thread.reply",
                "parent_id": parent_id,
                "message": {
                    "id": message.id,
                    "agent_id": message.agent_id,
                    "agent_name": message.agent_name,
                    "text": message.text,
                }
            }),
        },
    );

    created(response)
}

async fn get_thread(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(parent_id): Path<String>,
    Query(query): Query<MessageListQuery>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let Some(parent) = store.messages.get(&parent_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    };
    if parent.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    }

    let ids = store
        .thread_replies
        .get(&parent_id)
        .cloned()
        .unwrap_or_default();
    let ids = apply_message_cursor(&ids, &query);

    let mut replies = Vec::new();
    for id in ids {
        if let Some(reply) = store.messages.get(&id) {
            replies.push(message_to_json(&store, reply));
        }
    }

    ok(json!({
        "parent": message_to_json(&store, parent),
        "replies": replies,
    }))
}

#[derive(Debug, Deserialize)]
struct AddReactionRequest {
    emoji: String,
}

async fn add_reaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
    payload: Result<Json<AddReactionRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.emoji.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "emoji is required",
        );
    }

    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let Some(message) = store.messages.get(&message_id).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    };
    if message.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    }

    let reactor_ids = {
        let by_emoji = store.reactions.entry(message_id.clone()).or_default();
        let reactors = by_emoji.entry(payload.emoji.clone()).or_default();
        reactors.insert(agent_id.clone());
        reactors.iter().cloned().collect::<Vec<_>>()
    };

    let count = reactor_ids.len();
    let agents = reactor_ids
        .iter()
        .map(|id| agent_name_by_id(&store, id))
        .collect::<Vec<_>>();

    let channel_name = message
        .channel_id
        .as_ref()
        .and_then(|channel_id| store.channels.get(channel_id))
        .map(|ch| ch.name.clone());

    drop(store);

    if let Some(channel_name) = channel_name.clone() {
        publish(
            &state,
            RealtimeEvent {
                workspace_id: workspace_id.clone(),
                audience: EventAudience::Channel { channel_name },
                payload: json!({
                    "type": "reaction.added",
                    "message_id": message_id,
                    "emoji": payload.emoji,
                    "agent_name": agent_name,
                }),
            },
        );
    }

    created(json!({
        "message_id": message_id,
        "emoji": payload.emoji,
        "count": count,
        "agents": agents,
    }))
}

async fn remove_reaction(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((message_id, emoji)): Path<(String, String)>,
) -> Response {
    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let Some(message) = store.messages.get(&message_id).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    };
    if message.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    }

    if let Some(by_emoji) = store.reactions.get_mut(&message_id) {
        if let Some(reactors) = by_emoji.get_mut(&emoji) {
            reactors.remove(&agent_id);
            if reactors.is_empty() {
                by_emoji.remove(&emoji);
            }
        }
        if by_emoji.is_empty() {
            store.reactions.remove(&message_id);
        }
    }

    let channel_name = message
        .channel_id
        .as_ref()
        .and_then(|channel_id| store.channels.get(channel_id))
        .map(|ch| ch.name.clone());

    drop(store);

    if let Some(channel_name) = channel_name {
        publish(
            &state,
            RealtimeEvent {
                workspace_id,
                audience: EventAudience::Channel { channel_name },
                payload: json!({
                    "type": "reaction.removed",
                    "message_id": message_id,
                    "emoji": emoji,
                    "agent_name": agent_name,
                }),
            },
        );
    }

    no_content()
}

async fn get_reactions(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let Some(message) = store.messages.get(&message_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    };
    if message.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    }

    ok(reaction_groups(&store, &message_id))
}

async fn mark_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
) -> Response {
    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let Some(message) = store.messages.get(&message_id).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    };
    if message.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    }

    let read_at = now_iso();
    store
        .read_receipts
        .entry(message_id.clone())
        .or_default()
        .insert(agent_id.clone(), read_at.clone());

    let channel_name = message
        .channel_id
        .as_ref()
        .and_then(|id| store.channels.get(id))
        .map(|ch| ch.name.clone());

    drop(store);

    if let Some(channel_name) = channel_name {
        publish(
            &state,
            RealtimeEvent {
                workspace_id,
                audience: EventAudience::Channel { channel_name },
                payload: json!({
                    "type": "message.read",
                    "message_id": message_id,
                    "agent_name": agent_name,
                    "read_at": read_at,
                }),
            },
        );
    }

    ok(json!({
        "message_id": message_id,
        "agent_id": agent_id,
        "read_at": read_at,
    }))
}

async fn readers(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(message_id): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let Some(message) = store.messages.get(&message_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    };
    if message.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "message_not_found",
            "Message not found",
        );
    }

    let mut out = Vec::new();
    if let Some(map) = store.read_receipts.get(&message_id) {
        for (agent_id, read_at) in map {
            out.push(json!({
                "agent_id": agent_id,
                "agent_name": agent_name_by_id(&store, agent_id),
                "read_at": read_at,
            }));
        }
    }

    out.sort_by(|a, b| {
        a.get("read_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("read_at").and_then(Value::as_str).unwrap_or(""))
    });

    ok(out)
}

#[derive(Debug, Deserialize)]
struct SendDmRequest {
    to: String,
    text: String,
}

fn ensure_direct_conversation(
    store: &mut Store,
    workspace_id: &str,
    from_id: &str,
    to_id: &str,
) -> String {
    let pair_key = ws_pair_key(workspace_id, from_id, to_id);
    if let Some(existing) = store.dm_by_pair.get(&pair_key) {
        return existing.clone();
    }

    let conv_id = new_id("dm");
    let conversation = DmConversationRecord {
        id: conv_id.clone(),
        workspace_id: workspace_id.to_string(),
        dm_type: "direct".to_string(),
        name: None,
        participant_ids: vec![from_id.to_string(), to_id.to_string()],
        created_at: now_iso(),
        last_message_id: None,
    };
    store.dm_by_pair.insert(pair_key, conv_id.clone());
    store.dm_messages.insert(conv_id.clone(), Vec::new());
    store.dm_conversations.insert(conv_id.clone(), conversation);
    conv_id
}

fn post_dm_message_internal(
    store: &mut Store,
    workspace_id: &str,
    conversation_id: &str,
    agent_id: &str,
    agent_name: &str,
    text: String,
) -> Option<MessageRecord> {
    let conversation = store.dm_conversations.get_mut(conversation_id)?;
    if conversation.workspace_id != workspace_id {
        return None;
    }
    if !conversation.participant_ids.iter().any(|id| id == agent_id) {
        return None;
    }

    let message = MessageRecord {
        id: new_id("msg"),
        workspace_id: workspace_id.to_string(),
        channel_id: None,
        conversation_id: Some(conversation_id.to_string()),
        agent_id: agent_id.to_string(),
        agent_name: agent_name.to_string(),
        text,
        blocks: None,
        attachments: Vec::new(),
        created_at: now_iso(),
        thread_id: None,
    };

    store
        .dm_messages
        .entry(conversation_id.to_string())
        .or_default()
        .push(message.id.clone());
    conversation.last_message_id = Some(message.id.clone());
    store.messages.insert(message.id.clone(), message.clone());

    Some(message)
}

async fn send_dm(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<SendDmRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };
    if payload.to.trim().is_empty() {
        return err(StatusCode::BAD_REQUEST, "invalid_request", "to is required");
    }
    if payload.text.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "text is required",
        );
    }

    let (workspace_id, from_id, from_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let target_key = ws_agent_key(&workspace_id, payload.to.trim());
    let Some(to_id) = store.agent_by_workspace_name.get(&target_key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "agent_not_found",
            format!("Agent \"{}\" not found", payload.to.trim()),
        );
    };

    let conversation_id = ensure_direct_conversation(&mut store, &workspace_id, &from_id, &to_id);
    let Some(message) = post_dm_message_internal(
        &mut store,
        &workspace_id,
        &conversation_id,
        &from_id,
        &from_name,
        payload.text.clone(),
    ) else {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Failed to post DM message",
        );
    };

    let participants = store
        .dm_conversations
        .get(&conversation_id)
        .map(|c| c.participant_ids.iter().cloned().collect::<HashSet<_>>())
        .unwrap_or_default();

    let response = json!({
        "id": message.id,
        "conversation_id": conversation_id,
        "from_agent_id": from_id,
        "to": payload.to.trim(),
        "text": message.text,
        "created_at": message.created_at,
    });

    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Agents {
                agent_ids: participants,
            },
            payload: json!({
                "type": "dm.received",
                "conversation_id": conversation_id,
                "message": {
                    "id": message.id,
                    "agent_id": message.agent_id,
                    "agent_name": message.agent_name,
                    "text": message.text,
                }
            }),
        },
    );

    created(response)
}

#[derive(Debug, Deserialize)]
struct CreateGroupDmRequest {
    participants: Vec<String>,
    name: Option<String>,
    text: Option<String>,
}

fn normalize_initial_group_dm_text(text: Option<String>) -> Result<Option<String>, &'static str> {
    match text {
        Some(text) if text.trim().is_empty() => Err("text must not be empty when provided"),
        Some(text) => Ok(Some(text.trim().to_string())),
        None => Ok(None),
    }
}

async fn create_group_dm(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<CreateGroupDmRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };
    if payload.participants.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "participants are required",
        );
    }
    let initial_text = match normalize_initial_group_dm_text(payload.text.clone()) {
        Ok(text) => text,
        Err(message) => {
            return err(StatusCode::BAD_REQUEST, "invalid_request", message);
        }
    };

    let (workspace_id, caller_id, caller_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let mut participant_ids = BTreeSet::new();
    participant_ids.insert(caller_id.clone());
    for participant in &payload.participants {
        let key = ws_agent_key(&workspace_id, participant.trim());
        let Some(agent_id) = store.agent_by_workspace_name.get(&key).cloned() else {
            return err(
                StatusCode::NOT_FOUND,
                "agent_not_found",
                format!("Agent \"{}\" not found", participant),
            );
        };
        participant_ids.insert(agent_id);
    }

    let conv_id = new_id("dm");
    let conversation = DmConversationRecord {
        id: conv_id.clone(),
        workspace_id: workspace_id.clone(),
        dm_type: "group".to_string(),
        name: payload.name.clone(),
        participant_ids: participant_ids.iter().cloned().collect(),
        created_at: now_iso(),
        last_message_id: None,
    };
    store
        .dm_conversations
        .insert(conv_id.clone(), conversation.clone());
    store.dm_messages.insert(conv_id.clone(), Vec::new());

    let message = if let Some(text) = initial_text {
        let Some(msg) = post_dm_message_internal(
            &mut store,
            &workspace_id,
            &conv_id,
            &caller_id,
            &caller_name,
            text,
        ) else {
            drop(store);
            return err(
                StatusCode::BAD_REQUEST,
                "invalid_request",
                "Failed to create initial group message",
            );
        };
        Some(msg)
    } else {
        None
    };

    drop(store);

    if let Some(ref message) = message {
        publish(
            &state,
            RealtimeEvent {
                workspace_id: workspace_id.clone(),
                audience: EventAudience::Agents {
                    agent_ids: participant_ids.iter().cloned().collect(),
                },
                payload: json!({
                    "type": "group_dm.received",
                    "conversation_id": conv_id,
                    "message": {
                        "id": message.id,
                        "agent_id": message.agent_id,
                        "agent_name": message.agent_name,
                        "text": message.text,
                    }
                }),
            },
        );
    }

    created(json!({
        "id": conversation.id,
        "channel_id": conversation.id,
        "dm_type": conversation.dm_type,
        "name": conversation.name,
        "participants": conversation
            .participant_ids
            .iter()
            .map(|id| json!({"agent_id": id}))
            .collect::<Vec<_>>(),
        "created_at": conversation.created_at,
    }))
}

async fn list_dm_conversations(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (workspace_id, agent_id, _) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let store = state.store.read().await;
    let mut out = Vec::new();

    for conv in store.dm_conversations.values() {
        if conv.workspace_id != workspace_id {
            continue;
        }
        if !conv.participant_ids.iter().any(|id| id == &agent_id) {
            continue;
        }

        let participant_names = conv
            .participant_ids
            .iter()
            .filter_map(|id| store.agents.get(id))
            .map(|a| a.name.clone())
            .collect::<Vec<_>>();

        let last_message = conv
            .last_message_id
            .as_ref()
            .and_then(|id| store.messages.get(id))
            .map(|m| m.text.clone());

        let unread_count = store
            .dm_messages
            .get(&conv.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|message_id| {
                let Some(message) = store.messages.get(message_id) else {
                    return false;
                };
                if message.agent_id == agent_id {
                    return false;
                }
                !store
                    .read_receipts
                    .get(message_id)
                    .and_then(|r| r.get(&agent_id))
                    .is_some()
            })
            .count();

        out.push(json!({
            "id": conv.id,
            "type": conv.dm_type,
            "name": conv.name,
            "participants": participant_names,
            "last_message": last_message,
            "unread_count": unread_count,
        }));
    }

    out.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
    });

    ok(out)
}

async fn list_all_dm_conversations(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };

    let mut out = Vec::new();
    for conv in store.dm_conversations.values() {
        if conv.workspace_id != workspace_id {
            continue;
        }

        let participants = conv
            .participant_ids
            .iter()
            .filter_map(|id| store.agents.get(id))
            .map(|a| a.name.clone())
            .collect::<Vec<_>>();

        let last_message = conv
            .last_message_id
            .as_ref()
            .and_then(|id| store.messages.get(id))
            .map(|m| {
                json!({
                    "text": m.text,
                    "agent_name": m.agent_name,
                    "created_at": m.created_at,
                })
            });

        out.push(json!({
            "id": conv.id,
            "type": conv.dm_type,
            "participants": participants,
            "last_message": last_message,
            "message_count": store.dm_messages.get(&conv.id).map(|v| v.len()).unwrap_or(0),
        }));
    }

    ok(out)
}

async fn list_dm_messages_as_workspace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Query(query): Query<MessageListQuery>,
) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };

    let Some(conv) = store.dm_conversations.get(&conversation_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    };
    if conv.workspace_id != workspace_id {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    }

    let ids = store
        .dm_messages
        .get(&conversation_id)
        .cloned()
        .unwrap_or_default();
    let ids = apply_message_cursor(&ids, &query);

    let mut out = Vec::new();
    for id in ids.into_iter().rev() {
        if let Some(message) = store.messages.get(&id) {
            out.push(json!({
                "id": message.id,
                "agent_id": message.agent_id,
                "agent_name": message.agent_name,
                "text": message.text,
                "created_at": message.created_at,
            }));
        }
    }

    ok(out)
}

async fn list_dm_messages(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    Query(query): Query<MessageListQuery>,
) -> Response {
    let (workspace_id, agent_id, _) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let store = state.store.read().await;
    let Some(conv) = store.dm_conversations.get(&conversation_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    };
    if conv.workspace_id != workspace_id {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    }
    if !conv.participant_ids.iter().any(|id| id == &agent_id) {
        return err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Not a conversation participant",
        );
    }

    let ids = store
        .dm_messages
        .get(&conversation_id)
        .cloned()
        .unwrap_or_default();
    let ids = apply_message_cursor(&ids, &query);

    let mut out = Vec::new();
    for id in ids.into_iter().rev() {
        if let Some(message) = store.messages.get(&id) {
            out.push(message_to_json(&store, message));
        }
    }

    ok(out)
}

#[derive(Debug, Deserialize)]
struct SendConversationMessageRequest {
    text: String,
}

async fn send_dm_message(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    payload: Result<Json<SendConversationMessageRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.text.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "text is required",
        );
    }

    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let Some(conversation) = store.dm_conversations.get(&conversation_id).cloned() else {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    };

    if conversation.workspace_id != workspace_id {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    }
    if !conversation
        .participant_ids
        .iter()
        .any(|id| id == &agent_id)
    {
        return err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Not a conversation participant",
        );
    }

    let Some(message) = post_dm_message_internal(
        &mut store,
        &workspace_id,
        &conversation_id,
        &agent_id,
        &agent_name,
        payload.text.clone(),
    ) else {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "Failed to post message",
        );
    };

    let participant_ids = conversation
        .participant_ids
        .iter()
        .cloned()
        .collect::<HashSet<_>>();
    let dm_type = conversation.dm_type.clone();

    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Agents {
                agent_ids: participant_ids,
            },
            payload: if dm_type == "group" {
                json!({
                    "type": "group_dm.received",
                    "conversation_id": conversation_id,
                    "message": {
                        "id": message.id,
                        "agent_id": message.agent_id,
                        "agent_name": message.agent_name,
                        "text": message.text,
                    }
                })
            } else {
                json!({
                    "type": "dm.received",
                    "conversation_id": conversation_id,
                    "message": {
                        "id": message.id,
                        "agent_id": message.agent_id,
                        "agent_name": message.agent_name,
                        "text": message.text,
                    }
                })
            },
        },
    );

    created(json!({
        "id": message.id,
        "conversation_id": conversation_id,
        "agent_id": message.agent_id,
        "text": message.text,
        "created_at": message.created_at,
    }))
}

#[derive(Debug, Deserialize)]
struct AddParticipantRequest {
    agent_name: String,
}

async fn add_dm_participant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(conversation_id): Path<String>,
    payload: Result<Json<AddParticipantRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let (workspace_id, requester_id, _) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    if payload.agent_name.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "agent_name is required",
        );
    }

    let mut store = state.store.write().await;
    let target_key = ws_agent_key(&workspace_id, payload.agent_name.trim());
    let Some(target_id) = store.agent_by_workspace_name.get(&target_key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "agent_not_found",
            format!("Agent \"{}\" not found", payload.agent_name.trim()),
        );
    };

    let Some(conv) = store.dm_conversations.get_mut(&conversation_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    };

    if conv.workspace_id != workspace_id {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    }
    if !conv.participant_ids.iter().any(|id| id == &requester_id) {
        return err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Not a conversation participant",
        );
    }

    let already_member = conv.participant_ids.iter().any(|id| id == &target_id);
    if !already_member {
        conv.participant_ids.push(target_id.clone());
    }

    ok(json!({
        "conversation_id": conversation_id,
        "agent": payload.agent_name.trim(),
        "already_member": already_member,
    }))
}

async fn remove_dm_participant(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path((conversation_id, agent_name)): Path<(String, String)>,
) -> Response {
    let (workspace_id, requester_id, _) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let target_key = ws_agent_key(&workspace_id, &agent_name);
    let Some(target_id) = store.agent_by_workspace_name.get(&target_key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "agent_not_found",
            format!("Agent \"{}\" not found", agent_name),
        );
    };

    let Some(conv) = store.dm_conversations.get_mut(&conversation_id) else {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    };

    if conv.workspace_id != workspace_id {
        return err(StatusCode::NOT_FOUND, "not_found", "Conversation not found");
    }
    if !conv.participant_ids.iter().any(|id| id == &requester_id) {
        return err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "Not a conversation participant",
        );
    }

    conv.participant_ids.retain(|id| id != &target_id);
    no_content()
}

async fn inbox(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let store = state.store.read().await;
    let mut unread_channels = Vec::new();

    for channel in store.channels.values() {
        if channel.workspace_id != workspace_id {
            continue;
        }

        let is_member = store
            .channel_members
            .get(&channel.id)
            .map(|members| members.contains(&agent_id))
            .unwrap_or(false);
        if !is_member {
            continue;
        }

        let unread = store
            .channel_messages
            .get(&channel.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|message_id| {
                let Some(message) = store.messages.get(message_id) else {
                    return false;
                };
                if message.agent_id == agent_id {
                    return false;
                }
                !store
                    .read_receipts
                    .get(message_id)
                    .and_then(|r| r.get(&agent_id))
                    .is_some()
            })
            .count();

        if unread > 0 {
            unread_channels.push(json!({
                "channel_name": channel.name,
                "unread_count": unread,
            }));
        }
    }

    let mut unread_dms = 0;
    for conv in store.dm_conversations.values() {
        if conv.workspace_id != workspace_id {
            continue;
        }
        if !conv.participant_ids.iter().any(|id| id == &agent_id) {
            continue;
        }

        unread_dms += store
            .dm_messages
            .get(&conv.id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|message_id| {
                let Some(message) = store.messages.get(message_id) else {
                    return false;
                };
                if message.agent_id == agent_id {
                    return false;
                }
                !store
                    .read_receipts
                    .get(message_id)
                    .and_then(|r| r.get(&agent_id))
                    .is_some()
            })
            .count();
    }

    let mut mentions = Vec::new();
    let mention_pattern = format!("@{}", agent_name);
    for message in store.messages.values() {
        if message.workspace_id != workspace_id {
            continue;
        }
        if message.text.contains(&mention_pattern) {
            mentions.push(message_to_json(&store, message));
        }
    }

    mentions.sort_by(|a, b| {
        b.get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("created_at").and_then(Value::as_str).unwrap_or(""))
    });

    ok(json!({
        "unread_channels": unread_channels,
        "unread_dms": unread_dms,
        "mentions": mentions,
    }))
}

#[derive(Debug, Deserialize)]
struct SearchQuery {
    q: Option<String>,
    channel: Option<String>,
    from: Option<String>,
    limit: Option<usize>,
}

async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let needle = query.q.as_deref().unwrap_or("").trim().to_ascii_lowercase();

    let mut out = Vec::new();

    for message in store.messages.values() {
        if message.workspace_id != workspace_id {
            continue;
        }
        if !needle.is_empty() && !message.text.to_ascii_lowercase().contains(&needle) {
            continue;
        }

        if let Some(channel_filter) = &query.channel {
            let Some(channel_id) = &message.channel_id else {
                continue;
            };
            let Some(channel) = store.channels.get(channel_id) else {
                continue;
            };
            if channel.name != *channel_filter {
                continue;
            }
        }

        if let Some(from_filter) = &query.from {
            if &message.agent_name != from_filter {
                continue;
            }
        }

        out.push(message_to_json(&store, message));
    }

    out.sort_by(|a, b| {
        b.get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("created_at").and_then(Value::as_str).unwrap_or(""))
    });

    if let Some(limit) = query.limit {
        out.truncate(limit);
    }

    let total = out.len();

    ok(json!({
        "messages": out,
        "total": total,
    }))
}

#[derive(Clone, Serialize, Deserialize)]
struct ActivityItem {
    #[serde(rename = "type")]
    item_type: String,
    id: String,
    channel_name: Option<String>,
    conversation_id: Option<String>,
    agent_name: String,
    text: String,
    created_at: String,
}

#[derive(Debug, Deserialize)]
struct ActivityQuery {
    limit: Option<usize>,
}

async fn activity(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ActivityQuery>,
) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };

    let mut items = store
        .activity
        .iter()
        .filter(|item| {
            if let Some(channel_name) = &item.channel_name {
                let key = ws_channel_key(&workspace_id, channel_name);
                store.channel_by_workspace_name.contains_key(&key)
            } else {
                true
            }
        })
        .cloned()
        .collect::<Vec<_>>();

    items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    if let Some(limit) = query.limit {
        items.truncate(limit);
    }

    ok(items)
}

#[derive(Debug, Deserialize)]
struct CreateCommandRequest {
    command: String,
    description: String,
    handler_agent: String,
    parameters: Option<Vec<CommandParameter>>,
}

async fn create_command(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<CreateCommandRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.command.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "command is required",
        );
    }

    let mut store = state.store.write().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let handler_key = ws_agent_key(&workspace_id, payload.handler_agent.trim());
    let Some(handler_agent_id) = store.agent_by_workspace_name.get(&handler_key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "agent_not_found",
            format!("Agent \"{}\" not found", payload.handler_agent.trim()),
        );
    };

    let key = format!("{}:{}", workspace_id, payload.command.trim());
    if store.commands.contains_key(&key) {
        return err(
            StatusCode::CONFLICT,
            "command_exists",
            format!("Command \"{}\" already exists", payload.command.trim()),
        );
    }

    let command = CommandRecord {
        id: new_id("cmd"),
        workspace_id: workspace_id.clone(),
        command: payload.command.trim().to_string(),
        description: payload.description.clone(),
        handler_agent_id: handler_agent_id.clone(),
        handler_agent_name: payload.handler_agent.trim().to_string(),
        parameters: payload.parameters.unwrap_or_default(),
        created_at: now_iso(),
        is_active: true,
    };

    store.commands.insert(key, command.clone());

    created(json!({
        "id": command.id,
        "command": command.command,
        "description": command.description,
        "handler_agent": command.handler_agent_name,
        "parameters": command.parameters,
        "created_at": command.created_at,
    }))
}

async fn list_commands(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let store = state.store.read().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let mut out = Vec::new();
    for command in store.commands.values() {
        if command.workspace_id != workspace_id {
            continue;
        }
        out.push(json!({
            "id": command.id,
            "workspace_id": command.workspace_id,
            "command": command.command,
            "description": command.description,
            "handler_agent_id": command.handler_agent_id,
            "handler_agent_name": command.handler_agent_name,
            "parameters": command.parameters,
            "created_at": command.created_at,
            "is_active": command.is_active,
        }));
    }

    out.sort_by(|a, b| {
        a.get("command")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("command").and_then(Value::as_str).unwrap_or(""))
    });

    ok(out)
}

async fn delete_command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(command): Path<String>,
) -> Response {
    let mut store = state.store.write().await;
    let auth = match auth_any(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };
    let workspace_id = workspace_from_auth(auth);

    let key = format!("{}:{}", workspace_id, command);
    if store.commands.remove(&key).is_none() {
        return err(StatusCode::NOT_FOUND, "not_found", "Command not found");
    }

    no_content()
}

#[derive(Debug, Deserialize)]
struct InvokeCommandRequest {
    channel: String,
    args: Option<String>,
    parameters: Option<BTreeMap<String, Value>>,
}

async fn invoke_command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(command): Path<String>,
    payload: Result<Json<InvokeCommandRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let (workspace_id, _, invoked_by_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let store = state.store.read().await;
    let key = format!("{}:{}", workspace_id, command);
    let Some(command_record) = store.commands.get(&key).cloned() else {
        return err(StatusCode::NOT_FOUND, "not_found", "Command not found");
    };
    drop(store);

    let invocation = json!({
        "id": new_id("cmi"),
        "command": command,
        "channel": payload.channel,
        "invoked_by": invoked_by_name,
        "args": payload.args,
        "parameters": payload.parameters,
        "response_message_id": Value::Null,
        "created_at": now_iso(),
    });

    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Workspace,
            payload: json!({
                "type": "command.invoked",
                "command": command_record.command,
                "channel": invocation.get("channel").cloned().unwrap_or(Value::Null),
                "invoked_by": invocation.get("invoked_by").cloned().unwrap_or(Value::Null),
                "handler_agent_id": command_record.handler_agent_id,
                "args": invocation.get("args").cloned().unwrap_or(Value::Null),
                "parameters": invocation.get("parameters").cloned().unwrap_or(Value::Null),
            }),
        },
    );

    created(invocation)
}

#[derive(Debug, Deserialize)]
struct UploadFileRequest {
    filename: String,
    content_type: String,
    size_bytes: i64,
}

async fn upload_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<UploadFileRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.filename.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "filename is required",
        );
    }
    if payload.content_type.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "content_type is required",
        );
    }
    if payload.size_bytes == 0 {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "size_bytes is required",
        );
    }

    let (workspace_id, agent_id, _) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let file_id = new_id("file");
    let created_at = now_iso();
    let upload_url = format!("/v1/files/{}", file_id);
    let expires_at = now_iso();
    let file = FileRecord {
        file_id: file_id.clone(),
        workspace_id,
        filename: payload.filename.trim().to_string(),
        content_type: payload.content_type.trim().to_string(),
        size: payload.size_bytes.abs(),
        uploaded_by: agent_id,
        created_at: created_at.clone(),
        upload_url: upload_url.clone(),
        completed: false,
    };

    let mut store = state.store.write().await;
    store.files.insert(file_id.clone(), file);
    drop(store);

    created(json!({
        "file_id": file_id,
        "upload_url": upload_url,
        "expires_at": expires_at,
    }))
}

async fn complete_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
) -> Response {
    let (workspace_id, agent_id, agent_name) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let Some(file) = store.files.get_mut(&file_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "file_not_found",
            "File not found or not owned by you",
        );
    };
    if file.workspace_id != workspace_id || file.uploaded_by != agent_id {
        return err(
            StatusCode::NOT_FOUND,
            "file_not_found",
            "File not found or not owned by you",
        );
    }

    file.completed = true;
    let file_json = file_info_json(file);
    let ws_payload = json!({
        "type": "file.uploaded",
        "file": {
            "file_id": file.file_id,
            "filename": file.filename,
            "uploaded_by": agent_name,
        }
    });
    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id,
            audience: EventAudience::Workspace,
            payload: ws_payload,
        },
    );

    ok(file_json)
}

async fn get_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_any(&store, &headers) {
        Ok(v) => workspace_from_auth(v),
        Err(r) => return r,
    };

    let Some(file) = store.files.get(&file_id) else {
        return err(StatusCode::NOT_FOUND, "file_not_found", "File not found");
    };
    if file.workspace_id != workspace_id {
        return err(StatusCode::NOT_FOUND, "file_not_found", "File not found");
    }

    ok(file_info_json(file))
}

async fn delete_file(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
) -> Response {
    let (workspace_id, agent_id, _) = {
        let store = state.store.read().await;
        match auth_agent(&store, &headers) {
            Ok(v) => v,
            Err(r) => return r,
        }
    };

    let mut store = state.store.write().await;
    let Some(file) = store.files.get(&file_id) else {
        return err(StatusCode::NOT_FOUND, "file_not_found", "File not found");
    };
    if file.workspace_id != workspace_id {
        return err(StatusCode::NOT_FOUND, "file_not_found", "File not found");
    }
    if file.uploaded_by != agent_id {
        return err(StatusCode::FORBIDDEN, "forbidden", "Not the file owner");
    }
    store.files.remove(&file_id);
    no_content()
}

#[derive(Debug, Deserialize)]
struct ListFilesQuery {
    uploaded_by: Option<String>,
    limit: Option<usize>,
}

async fn list_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ListFilesQuery>,
) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_any(&store, &headers) {
        Ok(v) => workspace_from_auth(v),
        Err(r) => return r,
    };

    let mut out = Vec::new();
    for file in store.files.values() {
        if file.workspace_id != workspace_id {
            continue;
        }

        if let Some(uploaded_by) = &query.uploaded_by {
            let matches_id = &file.uploaded_by == uploaded_by;
            let matches_name = store
                .agents
                .get(&file.uploaded_by)
                .map(|a| &a.name == uploaded_by)
                .unwrap_or(false);
            if !matches_id && !matches_name {
                continue;
            }
        }

        out.push(file_info_json(file));
    }

    out.sort_by(|a, b| {
        b.get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("created_at").and_then(Value::as_str).unwrap_or(""))
    });
    if let Some(limit) = query.limit {
        out.truncate(limit);
    }
    ok(out)
}

#[derive(Debug, Deserialize)]
struct CreateWebhookRequest {
    name: String,
    channel: String,
}

async fn create_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<CreateWebhookRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    if payload.name.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "name is required",
        );
    }
    if payload.channel.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "channel is required",
        );
    }

    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };

    let channel_key = ws_channel_key(&workspace_id, payload.channel.trim());
    let Some(channel_id) = store.channel_by_workspace_name.get(&channel_key).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "channel_not_found",
            format!("Channel \"{}\" not found", payload.channel.trim()),
        );
    };

    let id = new_id("wh");
    let created_at = now_iso();
    let webhook = WebhookRecord {
        id: id.clone(),
        workspace_id: workspace_id.clone(),
        name: payload.name.trim().to_string(),
        channel_id,
        channel_name: payload.channel.trim().to_string(),
        url: format!("/v1/hooks/{}", id),
        created_by: None,
        created_at: created_at.clone(),
        is_active: true,
    };

    store.webhooks.insert(id.clone(), webhook.clone());

    created(json!({
        "webhook_id": webhook.id,
        "name": webhook.name,
        "channel": webhook.channel_name,
        "url": webhook.url,
        "created_at": created_at,
    }))
}

async fn list_webhooks(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };

    let mut out = Vec::new();
    for webhook in store.webhooks.values() {
        if webhook.workspace_id != workspace_id {
            continue;
        }
        out.push(json!({
            "id": webhook.id,
            "workspace_id": webhook.workspace_id,
            "name": webhook.name,
            "channel_id": webhook.channel_id,
            "channel_name": webhook.channel_name,
            "url": webhook.url,
            "created_by": webhook.created_by,
            "created_at": webhook.created_at,
            "is_active": webhook.is_active,
        }));
    }
    out.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
    });

    ok(out)
}

async fn delete_webhook(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(webhook_id): Path<String>,
) -> Response {
    let mut store = state.store.write().await;
    let workspace_id = match auth_workspace(&store, &headers) {
        Ok(v) => v,
        Err(r) => return r,
    };

    let Some(webhook) = store.webhooks.get(&webhook_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "webhook_not_found",
            "Webhook not found",
        );
    };
    if webhook.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "webhook_not_found",
            "Webhook not found",
        );
    }
    store.webhooks.remove(&webhook_id);
    no_content()
}

#[derive(Debug, Deserialize)]
struct TriggerWebhookRequest {
    text: Option<String>,
    source: Option<String>,
    payload: Option<Map<String, Value>>,
}

async fn trigger_webhook(
    State(state): State<AppState>,
    Path(webhook_id): Path<String>,
    payload: Result<Json<TriggerWebhookRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };

    let mut store = state.store.write().await;
    let Some(webhook) = store.webhooks.get(&webhook_id).cloned() else {
        return err(
            StatusCode::NOT_FOUND,
            "webhook_not_found",
            "Webhook not found or inactive",
        );
    };
    if !webhook.is_active {
        return err(
            StatusCode::NOT_FOUND,
            "webhook_not_found",
            "Webhook not found or inactive",
        );
    }

    let text = payload
        .text
        .clone()
        .unwrap_or_else(|| "Webhook event".to_string());
    let created_at = now_iso();
    let message = MessageRecord {
        id: new_id("msg"),
        workspace_id: webhook.workspace_id.clone(),
        channel_id: Some(webhook.channel_id.clone()),
        conversation_id: None,
        agent_id: format!("webhook:{}", webhook.id),
        agent_name: payload
            .source
            .clone()
            .unwrap_or_else(|| webhook.name.clone()),
        text: text.clone(),
        blocks: payload.payload.clone().map(|v| vec![Value::Object(v)]),
        attachments: Vec::new(),
        created_at: created_at.clone(),
        thread_id: None,
    };
    store
        .channel_messages
        .entry(webhook.channel_id.clone())
        .or_default()
        .push(message.id.clone());
    store.messages.insert(message.id.clone(), message.clone());
    drop(store);

    publish(
        &state,
        RealtimeEvent {
            workspace_id: webhook.workspace_id.clone(),
            audience: EventAudience::Channel {
                channel_name: webhook.channel_name.clone(),
            },
            payload: json!({
                "type": "webhook.received",
                "webhook_id": webhook.id,
                "channel": webhook.channel_name,
                "message": {
                    "id": message.id,
                    "text": text,
                    "source": payload.source,
                }
            }),
        },
    );

    created(json!({
        "message_id": message.id,
        "channel": webhook.channel_name,
        "text": message.text,
        "created_at": created_at,
    }))
}

#[derive(Debug, Deserialize)]
struct SubscriptionFilterRequest {
    channel: Option<String>,
    mentions: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateSubscriptionRequest {
    events: Vec<String>,
    filter: Option<SubscriptionFilterRequest>,
    url: String,
    secret: Option<String>,
}

async fn create_subscription(
    State(state): State<AppState>,
    headers: HeaderMap,
    payload: Result<Json<CreateSubscriptionRequest>, axum::extract::rejection::JsonRejection>,
) -> Response {
    let Ok(Json(payload)) = payload else {
        return json_error();
    };
    if payload.events.is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "events array is required",
        );
    }
    if payload.url.trim().is_empty() {
        return err(
            StatusCode::BAD_REQUEST,
            "invalid_request",
            "url is required",
        );
    }

    let mut store = state.store.write().await;
    let workspace_id = match auth_any(&store, &headers) {
        Ok(v) => workspace_from_auth(v),
        Err(r) => return r,
    };

    let record = SubscriptionRecord {
        id: new_id("sub"),
        workspace_id: workspace_id.clone(),
        events: payload.events.clone(),
        filter: payload.filter.map(|f| SubscriptionFilterRecord {
            channel: f.channel,
            mentions: f.mentions,
        }),
        url: payload.url.trim().to_string(),
        secret: payload.secret.clone(),
        is_active: true,
        created_at: now_iso(),
    };
    store
        .subscriptions
        .insert(record.id.clone(), record.clone());

    created(json!({
        "id": record.id,
        "events": record.events,
        "filter": record.filter,
        "url": record.url,
        "is_active": record.is_active,
        "created_at": record.created_at,
    }))
}

async fn list_subscriptions(State(state): State<AppState>, headers: HeaderMap) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_any(&store, &headers) {
        Ok(v) => workspace_from_auth(v),
        Err(r) => return r,
    };

    let mut out = Vec::new();
    for sub in store.subscriptions.values() {
        if sub.workspace_id != workspace_id {
            continue;
        }
        out.push(json!({
            "id": sub.id,
            "workspace_id": sub.workspace_id,
            "events": sub.events,
            "filter": sub.filter,
            "url": sub.url,
            "secret": sub.secret,
            "is_active": sub.is_active,
            "created_at": sub.created_at,
        }));
    }
    out.sort_by(|a, b| {
        a.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(b.get("id").and_then(Value::as_str).unwrap_or(""))
    });

    ok(out)
}

async fn get_subscription(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(subscription_id): Path<String>,
) -> Response {
    let store = state.store.read().await;
    let workspace_id = match auth_any(&store, &headers) {
        Ok(v) => workspace_from_auth(v),
        Err(r) => return r,
    };

    let Some(sub) = store.subscriptions.get(&subscription_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "subscription_not_found",
            "Subscription not found",
        );
    };
    if sub.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "subscription_not_found",
            "Subscription not found",
        );
    }

    ok(json!({
        "id": sub.id,
        "workspace_id": sub.workspace_id,
        "events": sub.events,
        "filter": sub.filter,
        "url": sub.url,
        "secret": sub.secret,
        "is_active": sub.is_active,
        "created_at": sub.created_at,
    }))
}

async fn delete_subscription(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(subscription_id): Path<String>,
) -> Response {
    let mut store = state.store.write().await;
    let workspace_id = match auth_any(&store, &headers) {
        Ok(v) => workspace_from_auth(v),
        Err(r) => return r,
    };

    let Some(sub) = store.subscriptions.get(&subscription_id) else {
        return err(
            StatusCode::NOT_FOUND,
            "subscription_not_found",
            "Subscription not found",
        );
    };
    if sub.workspace_id != workspace_id {
        return err(
            StatusCode::NOT_FOUND,
            "subscription_not_found",
            "Subscription not found",
        );
    }
    store.subscriptions.remove(&subscription_id);
    no_content()
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<BTreeMap<String, String>>,
) -> Response {
    let Some(token) = query.get("token").cloned() else {
        return err(StatusCode::UNAUTHORIZED, "unauthorized", "Missing token");
    };

    let auth = {
        let store = state.store.read().await;
        if token.starts_with("at_") {
            let Some(agent_id) = store.agent_by_token.get(&token).cloned() else {
                return err(
                    StatusCode::UNAUTHORIZED,
                    "invalid_token",
                    "Invalid agent token",
                );
            };
            let Some(agent) = store.agents.get(&agent_id) else {
                return err(
                    StatusCode::UNAUTHORIZED,
                    "invalid_token",
                    "Invalid agent token",
                );
            };
            AuthContext::Agent {
                workspace_id: agent.workspace_id.clone(),
                agent_id: agent.id.clone(),
                agent_name: agent.name.clone(),
            }
        } else if token.starts_with("rk_") {
            let Some(workspace_id) = store.workspace_by_key.get(&token).cloned() else {
                return err(
                    StatusCode::UNAUTHORIZED,
                    "invalid_token",
                    "Invalid workspace key",
                );
            };
            let enabled = store
                .workspaces
                .get(&workspace_id)
                .map(|w| w.stream_override.unwrap_or(true))
                .unwrap_or(true);
            if !enabled {
                return err(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    "Workspace stream is disabled",
                );
            }
            AuthContext::Workspace { workspace_id }
        } else {
            return err(
                StatusCode::UNAUTHORIZED,
                "invalid_token",
                "Invalid token format",
            );
        }
    };

    ws.on_upgrade(move |socket| ws_session(socket, state, auth))
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum WsClientEvent {
    #[serde(rename = "subscribe")]
    Subscribe { channels: Vec<String> },
    #[serde(rename = "unsubscribe")]
    Unsubscribe { channels: Vec<String> },
    #[serde(rename = "ping")]
    Ping,
}

async fn ws_session(mut socket: WebSocket, state: AppState, auth: AuthContext) {
    let mut rx = state.events_tx.subscribe();
    let mut subscriptions = HashSet::<String>::new();

    let mut connected_agent: Option<(String, String)> = None; // (workspace_id, agent_id)

    if let AuthContext::Agent {
        workspace_id,
        agent_id,
        ..
    } = &auth
    {
        connected_agent = Some((workspace_id.clone(), agent_id.clone()));

        let mut emit_online = false;
        {
            let mut store = state.store.write().await;
            let count = store.ws_connections.entry(agent_id.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                emit_online = true;
            }
        }

        if emit_online {
            set_agent_status(&state, workspace_id, agent_id, "online", true).await;
        }
    }

    loop {
        tokio::select! {
            incoming = socket.recv() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        match serde_json::from_str::<WsClientEvent>(&text) {
                            Ok(WsClientEvent::Subscribe { channels }) => {
                                for channel in channels {
                                    subscriptions.insert(channel);
                                }
                            }
                            Ok(WsClientEvent::Unsubscribe { channels }) => {
                                for channel in channels {
                                    subscriptions.remove(&channel);
                                }
                            }
                            Ok(WsClientEvent::Ping) => {
                                if socket.send(Message::Text(json!({"type":"pong"}).to_string().into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(e) => {
                                debug!("dropped malformed ws client event: {}", e);
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => {
                        break;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        warn!("websocket receive error: {}", e);
                        break;
                    }
                }
            }
            outbound = rx.recv() => {
                let Ok(event) = outbound else {
                    continue;
                };

                let should_deliver = match (&auth, &event.audience) {
                    (AuthContext::Workspace { workspace_id }, _) => event.workspace_id == *workspace_id,
                    (AuthContext::Agent { workspace_id, .. }, EventAudience::Workspace) => {
                        event.workspace_id == *workspace_id
                    }
                    (AuthContext::Agent { workspace_id, .. }, EventAudience::Channel { channel_name }) => {
                        event.workspace_id == *workspace_id && subscriptions.contains(channel_name)
                    }
                    (AuthContext::Agent { workspace_id, agent_id, .. }, EventAudience::Agents { agent_ids }) => {
                        event.workspace_id == *workspace_id && agent_ids.contains(agent_id)
                    }
                };

                if should_deliver {
                    if socket.send(Message::Text(event.payload.to_string().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    }

    if let Some((workspace_id, agent_id)) = connected_agent {
        let mut emit_offline = false;
        {
            let mut store = state.store.write().await;
            if let Some(count) = store.ws_connections.get_mut(&agent_id) {
                if *count > 0 {
                    *count -= 1;
                }
                if *count == 0 {
                    store.ws_connections.remove(&agent_id);
                    emit_offline = true;
                }
            }
        }

        if emit_offline {
            set_agent_status(&state, &workspace_id, &agent_id, "offline", true).await;
        }
    }
}

fn app_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/v1/ws", get(ws_upgrade))
        .route("/v1/workspaces", post(create_workspace))
        .route(
            "/v1/workspaces/by-name/{name}",
            get(get_workspace_by_name),
        )
        .route(
            "/v1/workspace",
            get(get_workspace)
                .patch(patch_workspace)
                .delete(delete_workspace),
        )
        .route(
            "/v1/workspace/stream",
            get(get_workspace_stream).put(put_workspace_stream),
        )
        .route(
            "/v1/workspace/system-prompt",
            get(get_system_prompt).put(put_system_prompt),
        )
        .route("/v1/activity", get(activity))
        .route("/v1/agents", post(create_agent).get(list_agents))
        .route("/v1/agents/presence", get(get_presence))
        .route("/v1/agents/heartbeat", post(heartbeat))
        .route("/v1/agents/disconnect", post(disconnect_agent))
        .route("/v1/agents/spawn", post(spawn_agent))
        .route("/v1/agents/release", post(release_agent))
        .route(
            "/v1/agents/{name}",
            get(get_agent).patch(update_agent).delete(delete_agent),
        )
        .route("/v1/agents/{name}/rotate-token", post(rotate_agent_token))
        .route("/v1/channels", post(create_channel).get(list_channels))
        .route(
            "/v1/channels/{name}",
            get(get_channel)
                .patch(patch_channel)
                .delete(archive_channel),
        )
        .route("/v1/channels/{name}/topic", patch(patch_channel_topic))
        .route("/v1/channels/{name}/join", post(join_channel))
        .route("/v1/channels/{name}/leave", post(leave_channel))
        .route("/v1/channels/{name}/invite", post(invite_to_channel))
        .route("/v1/channels/{name}/members", get(channel_members))
        .route("/v1/channels/{name}/read-status", get(read_status))
        .route(
            "/v1/channels/{name}/messages",
            post(post_channel_message).get(list_channel_messages),
        )
        .route("/v1/messages/{id}", get(get_message))
        .route(
            "/v1/messages/{id}/replies",
            post(post_thread_reply).get(get_thread),
        )
        .route(
            "/v1/messages/{id}/reactions",
            post(add_reaction).get(get_reactions),
        )
        .route(
            "/v1/messages/{id}/reactions/{emoji}",
            delete(remove_reaction),
        )
        .route("/v1/messages/{id}/read", post(mark_read))
        .route("/v1/messages/{id}/readers", get(readers))
        .route("/v1/dm", post(send_dm))
        .route("/v1/dm/group", post(create_group_dm))
        .route("/v1/dm/conversations", get(list_dm_conversations))
        .route("/v1/dm/conversations/all", get(list_all_dm_conversations))
        .route(
            "/v1/dm/conversations/{conversation_id}/messages",
            get(list_dm_messages_as_workspace),
        )
        .route(
            "/v1/dm/{conversation_id}/messages",
            get(list_dm_messages).post(send_dm_message),
        )
        .route(
            "/v1/dm/{conversation_id}/participants",
            post(add_dm_participant),
        )
        .route(
            "/v1/dm/{conversation_id}/participants/{agent}",
            delete(remove_dm_participant),
        )
        .route("/v1/inbox", get(inbox))
        .route("/v1/search", get(search))
        .route("/v1/files/upload", post(upload_file))
        .route("/v1/files/{id}/complete", post(complete_upload))
        .route("/v1/files/{id}", get(get_file).delete(delete_file))
        .route("/v1/files", get(list_files))
        .route("/v1/webhooks", post(create_webhook).get(list_webhooks))
        .route("/v1/webhooks/{id}", delete(delete_webhook))
        .route("/v1/hooks/{webhook_id}", post(trigger_webhook))
        .route(
            "/v1/subscriptions",
            post(create_subscription).get(list_subscriptions),
        )
        .route(
            "/v1/subscriptions/{id}",
            get(get_subscription).delete(delete_subscription),
        )
        .route("/v1/commands", post(create_command).get(list_commands))
        .route("/v1/commands/{command}", delete(delete_command))
        .route("/v1/commands/{command}/invoke", post(invoke_command))
        .fallback(|| async { err(StatusCode::NOT_FOUND, "not_found", "Route not found") })
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_target(false)
        .compact()
        .init();

    let cli = Cli::parse();

    let addr: SocketAddr = format!("{}:{}", cli.host, cli.port).parse()?;
    let persistence = Arc::new(Persistence::open(&cli.db_path)?);
    let initial_store = persistence.load()?.unwrap_or_default();

    let (events_tx, _) = broadcast::channel(2048);
    let state = AppState {
        store: Arc::new(RwLock::new(initial_store)),
        events_tx,
        persistence: persistence.clone(),
    };

    // Periodic autosave of in-memory state to SQLite snapshot.
    let autosave_state = state.clone();
    let autosave_every = Duration::from_secs(cli.autosave_secs.max(1));
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(autosave_every);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            persist_state(&autosave_state).await;
        }
    });

    let app = app_router(state);
    let listener = TcpListener::bind(addr).await?;
    info!(
        "local daemon listening on http://{} (sqlite={})",
        addr,
        cli.db_path.display()
    );

    axum::serve(listener, app).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_initial_group_dm_text, normalize_workspace_name};

    #[test]
    fn normalize_workspace_name_trims_surrounding_whitespace() {
        assert_eq!(normalize_workspace_name("  test  "), "test");
    }

    #[test]
    fn normalize_workspace_name_preserves_inner_whitespace() {
        assert_eq!(normalize_workspace_name("  test workspace  "), "test workspace");
    }

    #[test]
    fn normalize_initial_group_dm_text_accepts_absent_text() {
        assert_eq!(normalize_initial_group_dm_text(None).unwrap(), None);
    }

    #[test]
    fn normalize_initial_group_dm_text_rejects_whitespace_only_text() {
        assert_eq!(
            normalize_initial_group_dm_text(Some("   ".to_string())).unwrap_err(),
            "text must not be empty when provided"
        );
    }

    #[test]
    fn normalize_initial_group_dm_text_trims_non_empty_text() {
        assert_eq!(
            normalize_initial_group_dm_text(Some("  hello  ".to_string())).unwrap(),
            Some("hello".to_string())
        );
    }
}
