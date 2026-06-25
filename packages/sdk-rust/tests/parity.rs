use relaycast::{
    ActionInvocationStatus, AgentClient, BindAgentToNodeRequest, ClientOptions,
    CompleteInvocationRequest, CreateAgentRequest, CreateChannelRequest, CreateNodeRequest,
    CreateSubscriptionRequest, CreateTriggerRequest, CreateWebhookRequest, DeferDeliveryRequest,
    DeliveryStatus, DmConversationSummary, EmitSessionEventRequest, FailDeliveryRequest,
    HttpClient, HttpPushNodeDelivery, ListDeliveriesOptions, ListSessionEventsQuery,
    MessageInjectionMode, MessageListQuery, MonitorCertificationRequest, NodeDeliveryAuth,
    NodeDeliveryConfig, NodeListQuery, RateDirectoryAgentRequest, RegisterA2aOptions,
    RegisterActionRequest, RelayCast, RelayCastOptions, ReleaseAgentRequest, RouteFeedbackRequest,
    SearchDirectoryQuery, SpawnAgentRequest, SubmitCertificationRequest,
    UpdateRoutingConfigRequest, WebhookTriggerRequest, WsClient, WsClientOptions, WsEvent,
};
use serde_json::json;
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::Duration;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use wiremock::matchers::{body_json, header, method, path, query_param, query_param_is_missing};
use wiremock::{Mock, MockServer, ResponseTemplate};

#[test]
fn options_builder_sets_expected_defaults() {
    let options = RelayCastOptions::new("rk_live_test").with_base_url("http://localhost:8787");
    assert_eq!(options.api_key, "rk_live_test");
    assert_eq!(options.base_url.as_deref(), Some("http://localhost:8787"));
}

fn ok(data: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "data": data }))
}

fn api_error(status: u16, code: &str, message: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({
        "ok": false,
        "error": {
            "code": code,
            "message": message
        }
    }))
}

fn delivery_payload(id: &str, status: &str) -> serde_json::Value {
    json!({
        "id": id,
        "message_id": "m_1",
        "channel_id": "ch_1",
        "agent_id": "a_1",
        "status": status,
        "mode": "wait",
        "reason": null,
        "priority": "normal",
        "retryable": null,
        "error": null,
        "available_at": null,
        "deadline": null,
        "created_at": "2026-06-01T00:00:00.000Z",
        "updated_at": "2026-06-01T00:00:01.000Z"
    })
}

#[tokio::test]
async fn create_channel_accepts_public_channel_payload() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("POST"))
        .and(path("/v1/channels"))
        .and(body_json(json!({
            "name": "engineering",
            "topic": "Engineering discussion"
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "ok": true,
            "data": {
                "id": "ch_123",
                "name": "engineering",
                "topic": "Engineering discussion",
                "metadata": {},
                "created_by": "agent_123",
                "created_at": "2026-05-14T16:28:32.000Z",
                "member_count": 1
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let channel = agent
        .create_channel(CreateChannelRequest {
            name: "engineering".to_string(),
            topic: Some("Engineering discussion".to_string()),
            metadata: None,
        })
        .await
        .expect("create_channel should decode the documented channel payload");

    assert_eq!(channel.id, "ch_123");
    assert_eq!(channel.workspace_id, None);
    assert_eq!(channel.channel_type, None);
    assert!(!channel.is_archived);
    assert_eq!(channel.member_count, Some(1));
}

#[tokio::test]
async fn ensure_joined_channel_treats_conflicts_as_success() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("POST"))
        .and(path("/v1/channels"))
        .and(body_json(json!({
            "name": "general",
            "topic": "General discussion"
        })))
        .respond_with(api_error(409, "channel_already_exists", "Channel exists"))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/v1/channels/general/join"))
        .respond_with(api_error(409, "already_member", "Already joined"))
        .expect(1)
        .mount(&server)
        .await;

    let outcome = agent
        .ensure_joined_channel(CreateChannelRequest {
            name: "general".to_string(),
            topic: Some("General discussion".to_string()),
            metadata: None,
        })
        .await
        .expect("ensure_joined_channel should treat 409 as success");

    assert_eq!(outcome.name, "general");
    assert!(!outcome.created);
    assert!(!outcome.joined);
}

#[tokio::test]
async fn register_or_get_agent_reclaims_public_agent_payload() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/agents"))
        .and(body_json(json!({
            "name": "Lead",
            "type": "agent"
        })))
        .respond_with(api_error(409, "agent_already_exists", "name_taken"))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/v1/agents/Lead"))
        .respond_with(ok(json!({
            "id": "a_existing",
            "name": "Lead",
            "type": "agent",
            "status": "offline",
            "persona": null,
            "last_seen": "2026-01-01T00:00:00.000Z",
            "channels": [
                {
                    "id": "ch_1",
                    "name": "general",
                    "role": "member",
                    "joined_at": "2026-01-01T00:00:00.000Z"
                }
            ]
        })))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("POST"))
        .and(path("/v1/agents/Lead/rotate-token"))
        .respond_with(ok(json!({
            "name": "Lead",
            "token": "at_live_rotated"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let reclaimed = relay
        .register_or_get_agent(CreateAgentRequest {
            name: "Lead".to_string(),
            agent_type: Some("agent".to_string()),
            persona: None,
            metadata: None,
        })
        .await
        .expect("register_or_get_agent should tolerate public get-agent payload");

    assert_eq!(reclaimed.id, "a_existing");
    assert_eq!(reclaimed.name, "Lead");
    assert_eq!(reclaimed.token, "at_live_rotated");
    assert_eq!(reclaimed.status, "offline");
    assert_eq!(reclaimed.created_at, "2026-01-01T00:00:00.000Z");
}

#[tokio::test]
async fn agent_token_resolution_uses_current_agent_endpoint() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("GET"))
        .and(path("/v1/agent"))
        .and(header("authorization", "Bearer at_live_worker"))
        .respond_with(ok(json!({
            "id": "agent_1",
            "name": "Worker",
            "type": "agent",
            "status": "online",
            "persona": null,
            "metadata": {},
            "last_seen": "2026-01-01T00:00:00.000Z",
            "channels": []
        })))
        .expect(3)
        .mount(&server)
        .await;

    let current = relay
        .get_current_agent("at_live_worker")
        .await
        .expect("get_current_agent failed");
    assert_eq!(current.name, "Worker");

    let agent = relay
        .as_agent("at_live_worker")
        .expect("failed to create agent client");
    let me = agent.me().await.expect("agent.me failed");
    assert_eq!(me.id, "agent_1");

    relay
        .reconnect_agent("at_live_worker")
        .await
        .expect("reconnect_agent failed");
}

#[tokio::test]
async fn workspace_stream_methods_use_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("GET"))
        .and(path("/v1/workspace/stream"))
        .respond_with(ok(json!({
            "enabled": true,
            "default_enabled": true,
            "override": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let current = relay
        .workspace_stream_get()
        .await
        .expect("workspace_stream_get failed");
    assert!(current.enabled);
    assert!(current.default_enabled);
    assert_eq!(current.override_value, None);

    Mock::given(method("PUT"))
        .and(path("/v1/workspace/stream"))
        .and(body_json(json!({ "enabled": false })))
        .respond_with(ok(json!({
            "enabled": false,
            "default_enabled": true,
            "override": false
        })))
        .expect(1)
        .mount(&server)
        .await;

    let updated = relay
        .workspace_stream_set(false)
        .await
        .expect("workspace_stream_set failed");
    assert!(!updated.enabled);
    assert_eq!(updated.override_value, Some(false));

    Mock::given(method("PUT"))
        .and(path("/v1/workspace/stream"))
        .and(body_json(json!({ "mode": "inherit" })))
        .respond_with(ok(json!({
            "enabled": true,
            "default_enabled": true,
            "override": null
        })))
        .expect(1)
        .mount(&server)
        .await;

    let inherited = relay
        .workspace_stream_inherit()
        .await
        .expect("workspace_stream_inherit failed");
    assert_eq!(inherited.override_value, None);
}

#[tokio::test]
async fn spawn_and_release_methods_use_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/agents/spawn"))
        .and(body_json(json!({
            "name": "WorkerOne",
            "cli": "codex",
            "task": "Run parity check",
            "channel": "general",
            "persona": "SDK verifier",
            "model": "claude-haiku-4-5-20251001",
            "metadata": {"ticket": "SDK-101"}
        })))
        .respond_with(ok(json!({
            "id": "a_1",
            "name": "WorkerOne",
            "token": "at_live_worker",
            "cli": "codex",
            "task": "Run parity check",
            "channel": "general",
            "status": "online",
            "created_at": "2026-01-01T00:00:00.000Z",
            "already_existed": false
        })))
        .expect(1)
        .mount(&server)
        .await;

    let spawned = relay
        .spawn_agent(SpawnAgentRequest {
            name: "WorkerOne".to_string(),
            cli: "codex".to_string(),
            task: "Run parity check".to_string(),
            channel: Some("general".to_string()),
            persona: Some("SDK verifier".to_string()),
            model: Some("claude-haiku-4-5-20251001".to_string()),
            metadata: Some(json!({"ticket": "SDK-101"})),
        })
        .await
        .expect("spawn_agent failed");
    assert_eq!(spawned.name, "WorkerOne");
    assert!(!spawned.already_existed);

    Mock::given(method("POST"))
        .and(path("/v1/agents/release"))
        .and(body_json(json!({
            "name": "WorkerOne",
            "reason": "task completed",
            "delete_agent": true
        })))
        .respond_with(ok(json!({
            "name": "WorkerOne",
            "released": true,
            "deleted": true,
            "reason": "task completed"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let released = relay
        .release_agent(ReleaseAgentRequest {
            name: "WorkerOne".to_string(),
            reason: Some("task completed".to_string()),
            delete_agent: Some(true),
        })
        .await
        .expect("release_agent failed");
    assert!(released.released);
    assert!(released.deleted);
}

#[tokio::test]
async fn list_messages_strips_hash_and_passes_pagination_query() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("GET"))
        .and(path("/v1/channels/general/messages"))
        .and(query_param("limit", "25"))
        .and(query_param("before", "m_99"))
        .and(query_param("after", "m_12"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    relay
        .list_messages(
            "#general",
            Some(MessageListQuery {
                limit: Some(25),
                before: Some("m_99".to_string()),
                after: Some("m_12".to_string()),
            }),
        )
        .await
        .expect("list_messages failed");
}

#[tokio::test]
async fn send_defaults_mode_wait() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("POST"))
        .and(path("/v1/channels/general/messages"))
        .and(body_json(json!({
            "text": "Hello",
            "mode": "wait"
        })))
        .respond_with(ok(json!({
            "id": "m_1",
            "agent_name": "alice",
            "agent_id": "a_1",
            "text": "Hello",
            "created_at": "2026-01-01T00:00:00.000Z",
            "reply_count": 0,
            "reactions": [],
            "read_by_count": 0,
            "attachments": [],
            "injection_mode": "wait"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let sent = agent
        .send("#general", "Hello", None, None, None)
        .await
        .expect("send failed");
    assert!(matches!(
        sent.injection_mode,
        Some(MessageInjectionMode::Wait)
    ));
}

#[tokio::test]
async fn send_with_mode_forwards_steer() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("POST"))
        .and(path("/v1/channels/general/messages"))
        .and(body_json(json!({
            "text": "Ping",
            "mode": "steer"
        })))
        .respond_with(ok(json!({
            "id": "m_2",
            "agent_name": "alice",
            "agent_id": "a_1",
            "text": "Ping",
            "created_at": "2026-01-01T00:00:00.000Z",
            "reply_count": 0,
            "reactions": [],
            "read_by_count": 0,
            "attachments": [],
            "injection_mode": "steer"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let sent = agent
        .send_with_mode(
            "#general",
            "Ping",
            None,
            None,
            MessageInjectionMode::Steer,
            None,
        )
        .await
        .expect("send_with_mode failed");
    assert!(matches!(
        sent.injection_mode,
        Some(MessageInjectionMode::Steer)
    ));
}

#[tokio::test]
async fn create_workspace_sends_origin_headers() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/workspaces"))
        .and(header("content-type", "application/json"))
        .and(header("x-sdk-version", env!("CARGO_PKG_VERSION")))
        .and(header("x-relaycast-origin-client", "@relaycast/sdk-rust"))
        .respond_with(ok(json!({
            "workspace_id": "ws_123",
            "api_key": "rk_live_new",
            "created_at": "2026-01-01T00:00:00.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let created = RelayCast::create_workspace("Parity Test", Some(&server.uri()))
        .await
        .expect("create_workspace failed");

    assert_eq!(created.workspace_id, "ws_123");
}

#[tokio::test]
async fn client_sends_sanitized_origin_actor_header() {
    let server = MockServer::start().await;

    // The origin actor is supplied mixed-case; it should arrive lowercased.
    Mock::given(method("GET"))
        .and(path("/v1/channels"))
        .and(header(
            "x-relaycast-origin-actor",
            "agent-relay-cli/agent/claude-code@2.3.1-opus4.8",
        ))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    let relay = RelayCast::new(
        RelayCastOptions::new("rk_live_test")
            .with_base_url(server.uri())
            .with_origin_actor("Agent-Relay-Cli/agent/Claude-Code@2.3.1-Opus4.8"),
    )
    .expect("failed to create RelayCast client");

    relay
        .list_channels(false)
        .await
        .expect("list_channels failed");
}

#[tokio::test]
async fn client_sends_agent_relay_distinct_id_header() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/v1/channels"))
        .and(header("x-agent-relay-distinct-id", "abc123def4567890"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    let relay = RelayCast::new(
        RelayCastOptions::new("rk_live_test")
            .with_base_url(server.uri())
            .with_agent_relay_distinct_id("abc123def4567890"),
    )
    .expect("failed to create RelayCast client");

    relay
        .list_channels(false)
        .await
        .expect("list_channels failed");
}

#[tokio::test]
async fn client_preserves_origin_actor_across_api_key_rotation() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/v1/channels"))
        .and(header("authorization", "Bearer at_live_rotated"))
        .and(header("x-relaycast-origin-actor", "cursor"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpClient::new(
        ClientOptions::new("rk_live_test")
            .with_base_url(server.uri())
            .with_origin_actor("Cursor"),
    )
    .expect("failed to create HTTP client");
    let rotated = client
        .with_api_key("at_live_rotated")
        .expect("failed to rotate API key");

    rotated
        .get::<Vec<serde_json::Value>>("/v1/channels", None, None)
        .await
        .expect("list channels failed");
}

#[tokio::test]
async fn client_preserves_agent_relay_distinct_id_across_api_key_rotation() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/v1/channels"))
        .and(header("authorization", "Bearer at_live_rotated"))
        .and(header("x-agent-relay-distinct-id", "abc123def4567890"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    let client = HttpClient::new(
        ClientOptions::new("rk_live_test")
            .with_base_url(server.uri())
            .with_agent_relay_distinct_id("abc123def4567890"),
    )
    .expect("failed to create HTTP client");
    let rotated = client
        .with_api_key("at_live_rotated")
        .expect("failed to rotate API key");

    rotated
        .get::<Vec<serde_json::Value>>("/v1/channels", None, None)
        .await
        .expect("list channels failed");
}

#[tokio::test]
async fn ws_client_forwards_sanitized_origin_actor_query_param() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind test WS server");
    let addr = listener.local_addr().expect("failed to read listener addr");
    let (uri_tx, uri_rx) = mpsc::channel();

    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("failed to accept WS connection");
        let callback = |request: &Request, response: Response| {
            uri_tx
                .send(request.uri().to_string())
                .expect("failed to send captured request URI");
            Ok(response)
        };
        let _websocket = tokio_tungstenite::tungstenite::accept_hdr(stream, callback)
            .expect("failed to accept WS handshake");
    });

    let mut ws = WsClient::new(
        WsClientOptions::new("at_live_test")
            .with_base_url(format!("http://{addr}"))
            .with_origin_actor("Agent-Relay-Cli/agent/Claude-Code@2.3.1"),
    );
    ws.connect().await.expect("WS connect failed");

    let uri = uri_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("test WS server did not capture a request URI");
    let url = url::Url::parse(&format!("http://localhost{uri}")).expect("invalid captured URI");
    assert_eq!(url.path(), "/v1/ws");
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "token")
            .map(|(_, value)| value.into_owned()),
        Some("at_live_test".to_string())
    );
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "origin_actor")
            .map(|(_, value)| value.into_owned()),
        Some("agent-relay-cli/agent/claude-code@2.3.1".to_string())
    );

    ws.disconnect().await;
    server.join().expect("test WS server panicked");
}

#[tokio::test]
async fn ws_client_forwards_agent_relay_distinct_id_query_param() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("failed to bind test WS server");
    let addr = listener.local_addr().expect("failed to read listener addr");
    let (uri_tx, uri_rx) = mpsc::channel();

    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().expect("failed to accept WS connection");
        let callback = |request: &Request, response: Response| {
            uri_tx
                .send(request.uri().to_string())
                .expect("failed to send captured request URI");
            Ok(response)
        };
        let _websocket = tokio_tungstenite::tungstenite::accept_hdr(stream, callback)
            .expect("failed to accept WS handshake");
    });

    let mut ws = WsClient::new(
        WsClientOptions::new("at_live_test")
            .with_base_url(format!("http://{addr}"))
            .with_agent_relay_distinct_id("abc123def4567890"),
    );
    ws.connect().await.expect("WS connect failed");

    let uri = uri_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("test WS server did not capture a request URI");
    let url = url::Url::parse(&format!("http://localhost{uri}")).expect("invalid captured URI");
    assert_eq!(url.path(), "/v1/ws");
    assert_eq!(
        url.query_pairs()
            .find(|(key, _)| key == "agent_relay_distinct_id")
            .map(|(_, value)| value.into_owned()),
        Some("abc123def4567890".to_string())
    );

    ws.disconnect().await;
    server.join().expect("test WS server panicked");
}

#[tokio::test]
async fn agent_heartbeat_uses_presence_endpoint() {
    let server = MockServer::start().await;

    Mock::given(method("POST"))
        .and(path("/v1/agents/heartbeat"))
        .respond_with(ok(json!({})))
        .expect(1)
        .mount(&server)
        .await;

    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");
    agent.heartbeat().await.expect("heartbeat failed");
}

#[tokio::test]
async fn durable_delivery_methods_use_expected_endpoints() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("GET"))
        .and(path("/v1/deliveries"))
        .and(query_param("status", "queued"))
        .and(query_param("limit", "25"))
        .respond_with(ok(json!([
            {
                "id": "del_1",
                "message_id": "m_1",
                "channel_id": "ch_1",
                "agent_id": "a_1",
                "status": "queued",
                "mode": "wait",
                "reason": null,
                "priority": "normal",
                "retryable": null,
                "error": null,
                "available_at": null,
                "deadline": null,
                "created_at": "2026-06-01T00:00:00.000Z",
                "updated_at": null,
                "message": {
                    "id": "m_1",
                    "channel_id": "ch_1",
                    "agent_id": "a_sender",
                    "agent_name": "sender",
                    "text": "hello",
                    "thread_id": null,
                    "created_at": "2026-06-01T00:00:00.000Z"
                }
            }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    let deliveries = agent
        .deliveries(Some(ListDeliveriesOptions {
            status: Some(DeliveryStatus::Queued),
            limit: Some(25),
        }))
        .await
        .expect("deliveries failed");
    assert_eq!(deliveries[0].delivery.id, "del_1");
    assert_eq!(deliveries[0].delivery.status, DeliveryStatus::Queued);
    assert_eq!(
        deliveries[0]
            .message
            .as_ref()
            .map(|message| message.agent_name.as_deref()),
        Some(Some("sender"))
    );

    Mock::given(method("GET"))
        .and(path("/v1/deliveries"))
        .and(query_param_is_missing("status"))
        .and(query_param("limit", "10"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    let unknown_status_deliveries = agent
        .deliveries(Some(ListDeliveriesOptions {
            status: Some(DeliveryStatus::Unknown),
            limit: Some(10),
        }))
        .await
        .expect("deliveries with unknown status failed");
    assert!(unknown_status_deliveries.is_empty());

    Mock::given(method("POST"))
        .and(path("/v1/deliveries/del_1/ack"))
        .respond_with(ok(json!({
            "id": "del_1",
            "message_id": "m_1",
            "channel_id": "ch_1",
            "agent_id": "a_1",
            "status": "acked",
            "mode": "wait",
            "reason": null,
            "priority": "normal",
            "retryable": null,
            "error": null,
            "available_at": null,
            "deadline": null,
            "created_at": "2026-06-01T00:00:00.000Z",
            "updated_at": "2026-06-01T00:00:01.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let acked = agent
        .ack_delivery("del_1")
        .await
        .expect("ack_delivery failed");
    assert_eq!(acked.status, DeliveryStatus::Acked);

    Mock::given(method("POST"))
        .and(path("/v1/deliveries/del_1/fail"))
        .and(body_json(json!({
            "error": "boom",
            "retryable": true
        })))
        .respond_with(ok(json!({
            "id": "del_1",
            "message_id": "m_1",
            "channel_id": "ch_1",
            "agent_id": "a_1",
            "status": "failed",
            "mode": "wait",
            "reason": null,
            "priority": "normal",
            "retryable": true,
            "error": "boom",
            "available_at": null,
            "deadline": null,
            "created_at": "2026-06-01T00:00:00.000Z",
            "updated_at": "2026-06-01T00:00:02.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let failed = agent
        .fail_delivery(
            "del_1",
            Some(FailDeliveryRequest {
                error: Some("boom".to_string()),
                retryable: Some(true),
            }),
        )
        .await
        .expect("fail_delivery failed");
    assert_eq!(failed.status, DeliveryStatus::Failed);
    assert_eq!(failed.error.as_deref(), Some("boom"));
    assert_eq!(failed.retryable, Some(true));

    Mock::given(method("POST"))
        .and(path("/v1/deliveries/del_1/fail"))
        .and(body_json(json!({
            "error": "boom",
            "retryable": false
        })))
        .respond_with(ok(json!({
            "id": "del_1",
            "message_id": "m_1",
            "channel_id": "ch_1",
            "agent_id": "a_1",
            "status": "failed",
            "mode": "wait",
            "reason": null,
            "priority": "normal",
            "retryable": false,
            "error": "boom",
            "available_at": null,
            "deadline": null,
            "created_at": "2026-06-01T00:00:00.000Z",
            "updated_at": "2026-06-01T00:00:02.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let failed = agent
        .fail_delivery(
            "del_1",
            Some(FailDeliveryRequest {
                error: Some("boom".to_string()),
                retryable: Some(false),
            }),
        )
        .await
        .expect("fail_delivery retryable false failed");
    assert_eq!(failed.status, DeliveryStatus::Failed);
    assert_eq!(failed.error.as_deref(), Some("boom"));
    assert_eq!(failed.retryable, Some(false));

    Mock::given(method("POST"))
        .and(path("/v1/deliveries/del_1/fail"))
        .and(body_json(json!({})))
        .respond_with(ok(json!({
            "id": "del_1",
            "message_id": "m_1",
            "channel_id": "ch_1",
            "agent_id": "a_1",
            "status": "failed",
            "mode": "wait",
            "reason": null,
            "priority": "normal",
            "retryable": true,
            "error": "boom",
            "available_at": null,
            "deadline": null,
            "created_at": "2026-06-01T00:00:00.000Z",
            "updated_at": "2026-06-01T00:00:02.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    agent
        .fail_delivery("del_1", None)
        .await
        .expect("fail_delivery without options failed");

    Mock::given(method("POST"))
        .and(path("/v1/deliveries/del_1/defer"))
        .and(body_json(json!({
            "available_at": "2026-06-01T00:05:00.000Z",
            "reason": "busy"
        })))
        .respond_with(ok(json!({
            "id": "del_1",
            "message_id": "m_1",
            "channel_id": "ch_1",
            "agent_id": "a_1",
            "status": "queued",
            "mode": "wait",
            "reason": "busy",
            "priority": "normal",
            "retryable": true,
            "error": "boom",
            "available_at": "2026-06-01T00:05:00.000Z",
            "deadline": null,
            "created_at": "2026-06-01T00:00:00.000Z",
            "updated_at": "2026-06-01T00:00:03.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let deferred = agent
        .defer_delivery(
            "del_1",
            DeferDeliveryRequest {
                available_at: "2026-06-01T00:05:00.000Z".to_string(),
                reason: Some("busy".to_string()),
            },
        )
        .await
        .expect("defer_delivery failed");
    assert_eq!(deferred.status, DeliveryStatus::Queued);
    assert_eq!(
        deferred.available_at.as_deref(),
        Some("2026-06-01T00:05:00.000Z")
    );
}

#[tokio::test]
async fn durable_delivery_methods_encode_delivery_ids() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");
    let raw_id = "del needs/encoding";
    let encoded_id = "del%20needs%2Fencoding";

    Mock::given(method("POST"))
        .and(path(format!("/v1/deliveries/{encoded_id}/ack")))
        .respond_with(ok(delivery_payload(raw_id, "acked")))
        .expect(1)
        .mount(&server)
        .await;

    let acked = agent
        .ack_delivery(raw_id)
        .await
        .expect("ack_delivery with encoded id failed");
    assert_eq!(acked.id, raw_id);
    assert_eq!(acked.status, DeliveryStatus::Acked);

    Mock::given(method("POST"))
        .and(path(format!("/v1/deliveries/{encoded_id}/fail")))
        .respond_with(ok(delivery_payload(raw_id, "failed")))
        .expect(1)
        .mount(&server)
        .await;

    let failed = agent
        .fail_delivery(raw_id, None)
        .await
        .expect("fail_delivery with encoded id failed");
    assert_eq!(failed.id, raw_id);
    assert_eq!(failed.status, DeliveryStatus::Failed);

    Mock::given(method("POST"))
        .and(path(format!("/v1/deliveries/{encoded_id}/defer")))
        .and(body_json(json!({
            "available_at": "2026-06-01T00:05:00.000Z"
        })))
        .respond_with(ok(delivery_payload(raw_id, "queued")))
        .expect(1)
        .mount(&server)
        .await;

    let deferred = agent
        .defer_delivery(
            raw_id,
            DeferDeliveryRequest {
                available_at: "2026-06-01T00:05:00.000Z".to_string(),
                reason: None,
            },
        )
        .await
        .expect("defer_delivery with encoded id failed");
    assert_eq!(deferred.id, raw_id);
    assert_eq!(deferred.status, DeliveryStatus::Queued);
}

#[test]
fn ws_message_created_deserializes_optional_agent_id() {
    let event = serde_json::from_value::<WsEvent>(json!({
        "type": "message.created",
        "channel": "general",
        "message": {
            "id": "m_1",
            "agent_id": "a_123",
            "agent_name": "alice",
            "text": "hello",
            "attachments": [],
            "injection_mode": "steer"
        }
    }))
    .expect("failed to parse ws message.created");

    match event {
        WsEvent::MessageCreated(msg) => {
            assert_eq!(msg.message.agent_id.as_deref(), Some("a_123"));
            assert_eq!(msg.message.agent_name, "alice");
            assert!(matches!(
                msg.message.injection_mode,
                Some(MessageInjectionMode::Steer)
            ));
        }
        other => panic!("unexpected event variant: {other:?}"),
    }
}

#[test]
fn ws_command_invoked_deserializes_handler_agent_id() {
    let event = serde_json::from_value::<WsEvent>(json!({
        "type": "command.invoked",
        "command": "/spawn",
        "channel": "general",
        "invoked_by": "lead",
        "handler_agent_id": "a_handler_1",
        "parameters": {
            "name": "worker-1",
            "cli": "codex"
        }
    }))
    .expect("failed to parse ws command.invoked");

    match event {
        WsEvent::CommandInvoked(cmd) => {
            assert_eq!(cmd.handler_agent_id, "a_handler_1");
            assert_eq!(cmd.command, "/spawn");
        }
        other => panic!("unexpected event variant: {other:?}"),
    }
}

#[test]
fn ws_agent_spawn_requested_tolerates_missing_or_null_optional_fields() {
    let missing = serde_json::from_value::<WsEvent>(json!({
        "type": "agent.spawn_requested",
        "agent": {
            "name": "worker-1",
            "cli": "codex"
        }
    }))
    .expect("failed to parse spawn request with missing fields");

    match missing {
        WsEvent::AgentSpawnRequested(event) => {
            assert_eq!(event.agent.name, "worker-1");
            assert_eq!(event.agent.cli, "codex");
            assert_eq!(event.agent.task, "");
            assert_eq!(event.agent.channel, None);
            assert!(!event.agent.already_existed);
        }
        other => panic!("unexpected event variant: {other:?}"),
    }

    let nulled = serde_json::from_value::<WsEvent>(json!({
        "type": "agent.spawn_requested",
        "agent": {
            "name": "worker-2",
            "cli": "claude",
            "task": null,
            "channel": null,
            "already_existed": true
        }
    }))
    .expect("failed to parse spawn request with null task/channel");

    match nulled {
        WsEvent::AgentSpawnRequested(event) => {
            assert_eq!(event.agent.name, "worker-2");
            assert_eq!(event.agent.cli, "claude");
            assert_eq!(event.agent.task, "");
            assert_eq!(event.agent.channel, None);
            assert!(event.agent.already_existed);
        }
        other => panic!("unexpected event variant: {other:?}"),
    }
}

#[test]
fn ws_command_invoked_requires_handler_agent_id() {
    let err = serde_json::from_value::<WsEvent>(json!({
        "type": "command.invoked",
        "command": "/spawn",
        "channel": "general",
        "invoked_by": "lead",
        "parameters": {
            "name": "worker-1"
        }
    }))
    .expect_err("expected missing handler_agent_id to fail");

    assert!(err.to_string().contains("handler_agent_id"));
}

#[test]
fn dm_conversation_summary_supports_object_shapes() {
    let summary = serde_json::from_value::<DmConversationSummary>(json!({
        "id": "dm_1",
        "channel_id": "c_1",
        "type": "group",
        "name": "ops-room",
        "participants": [
            { "agent_name": "alice", "agent_id": "a_1" },
            { "agent_id": "a_2" },
            "carol"
        ],
        "last_message": { "text": "latest update" },
        "unread_count": 3
    }))
    .expect("failed to parse dm conversation summary");

    assert_eq!(summary.participants, vec!["alice", "a_2", "carol"]);
    assert_eq!(summary.last_message.as_deref(), Some("latest update"));
}

#[tokio::test]
async fn add_dm_participant_uses_agent_name_payload_and_typed_response() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("POST"))
        .and(path("/v1/dm/dm_123/participants"))
        .and(body_json(json!({ "agent_name": "worker-1" })))
        .respond_with(ok(json!({
            "conversation_id": "dm_123",
            "agent": "worker-1",
            "already_member": false
        })))
        .expect(2)
        .mount(&server)
        .await;

    let untyped = agent
        .add_dm_participant("dm_123", "worker-1")
        .await
        .expect("add_dm_participant failed");
    assert_eq!(untyped["agent"], "worker-1");

    let typed = agent
        .add_dm_participant_typed("dm_123", "worker-1")
        .await
        .expect("add_dm_participant_typed failed");
    assert_eq!(typed.agent, "worker-1");
    assert!(!typed.already_member);
}

#[tokio::test]
async fn dm_messages_with_agent_uses_matching_conversation() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("GET"))
        .and(path("/v1/dm/conversations"))
        .respond_with(ok(json!([
            {
                "id": "c_1",
                "type": "dm",
                "name": null,
                "participants": ["worker-1", "lead"],
                "last_message": "hello",
                "unread_count": 0
            }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/v1/dm/c_1/messages"))
        .and(query_param("limit", "2"))
        .respond_with(ok(json!([
            {
                "id": "m_1",
                "agent_name": "worker-1",
                "agent_id": "a_1",
                "text": "ping",
                "created_at": "2026-01-01T00:00:00.000Z",
                "reply_count": 0,
                "reactions": [],
                "read_by_count": 0,
                "attachments": []
            }
        ])))
        .expect(1)
        .mount(&server)
        .await;

    let messages = agent
        .dm_messages_with_agent(
            "worker-1",
            Some(MessageListQuery {
                limit: Some(2),
                before: None,
                after: None,
            }),
        )
        .await
        .expect("dm_messages_with_agent failed");
    assert_eq!(messages.len(), 1);
    assert_eq!(messages[0].text, "ping");
}

#[tokio::test]
async fn dm_conversation_participants_returns_workspace_conversation_members() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("GET"))
        .and(path("/v1/dm/conversations/all"))
        .respond_with(ok(json!([
            {
                "id": "conv_1",
                "type": "dm",
                "participants": ["alice", "bob"],
                "message_count": 5,
                "last_message": {
                    "text": "latest",
                    "agent_name": "alice",
                    "created_at": "2026-01-01T00:00:00.000Z"
                }
            }
        ])))
        .expect(2)
        .mount(&server)
        .await;

    let participants = relay
        .dm_conversation_participants("conv_1")
        .await
        .expect("dm_conversation_participants failed");
    assert_eq!(participants, vec!["alice".to_string(), "bob".to_string()]);

    let missing = relay
        .dm_conversation_participants("missing")
        .await
        .expect("missing conversation should return empty vec");
    assert!(missing.is_empty());
}

#[tokio::test]
async fn inbound_webhook_helpers_use_token_and_author_contract() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/webhooks"))
        .and(body_json(json!({ "channel": "dev" })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "ok": true,
            "data": {
                "webhook_id": "wh_1",
                "name": "dev",
                "channel": "dev",
                "url": format!("{}/v1/hooks/wh_1", server.uri()),
                "token": "wh_live_1",
                "is_active": true,
                "created_at": "2026-01-01T00:00:00.000Z"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let created = relay
        .create_inbound_webhook(CreateWebhookRequest {
            name: None,
            channel: "dev".to_string(),
        })
        .await
        .expect("create_inbound_webhook failed");
    assert_eq!(created.token, "wh_live_1");
    assert!(created.is_active);

    Mock::given(method("POST"))
        .and(path("/v1/hooks/wh_1"))
        .and(header("authorization", "Bearer wh_live_1"))
        .and(body_json(json!({
            "message": "build failed",
            "author": "GitHub"
        })))
        .respond_with(ok(json!({
            "message_id": "m_1",
            "channel": "dev",
            "text": "build failed",
            "source": null,
            "author": "GitHub",
            "created_at": "2026-01-01T00:00:01.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let response = relay
        .trigger_webhook(
            "wh_1",
            WebhookTriggerRequest {
                text: None,
                message: Some("build failed".to_string()),
                blocks: None,
                source: None,
                author: Some("GitHub".to_string()),
                payload: None,
            },
            "wh_live_1",
        )
        .await
        .expect("trigger_webhook failed");
    assert_eq!(response.author.as_deref(), Some("GitHub"));
}

#[tokio::test]
async fn subscription_create_preserves_custom_headers() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    let mut headers = std::collections::BTreeMap::new();
    headers.insert("Authorization".to_string(), "Bearer downstream".to_string());

    Mock::given(method("POST"))
        .and(path("/v1/subscriptions"))
        .and(body_json(json!({
            "events": ["message.created"],
            "url": "https://hook.example.com",
            "headers": { "Authorization": "Bearer downstream" },
            "secret": "top-secret"
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "ok": true,
            "data": {
                "id": "sub_1",
                "events": ["message.created"],
                "filter": null,
                "url": "https://hook.example.com",
                "headers": { "Authorization": "Bearer downstream" },
                "is_active": true,
                "created_at": "2026-01-01T00:00:00.000Z"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let created = relay
        .create_subscription(CreateSubscriptionRequest {
            events: vec!["message.created".to_string()],
            filter: None,
            url: "https://hook.example.com".to_string(),
            headers: Some(headers),
            secret: Some("top-secret".to_string()),
        })
        .await
        .expect("create_subscription failed");
    assert_eq!(
        created
            .headers
            .as_ref()
            .and_then(|h| h.get("Authorization"))
            .map(String::as_str),
        Some("Bearer downstream")
    );
}

#[tokio::test]
async fn action_lifecycle_uses_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    // register
    Mock::given(method("POST"))
        .and(path("/v1/actions"))
        .and(body_json(json!({
            "name": "deploy",
            "description": "Deploy the app",
            "handler_agent": "DeployBot"
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "ok": true,
            "data": {
                "id": "act_1",
                "name": "deploy",
                "description": "Deploy the app",
                "handler_agent": "DeployBot",
                "input_schema": {},
                "output_schema": {},
                "available_to": null,
                "is_active": true,
                "created_at": "2026-01-01T00:00:00.000Z"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let action = relay
        .register_action(RegisterActionRequest {
            name: "deploy".to_string(),
            description: "Deploy the app".to_string(),
            handler_agent: "DeployBot".to_string(),
            input_schema: None,
            output_schema: None,
            available_to: None,
        })
        .await
        .expect("register_action failed");
    assert_eq!(action.name, "deploy");
    assert!(action.is_active);

    // list
    Mock::given(method("GET"))
        .and(path("/v1/actions"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;
    let actions = relay.list_actions().await.expect("list_actions failed");
    assert!(actions.is_empty());

    // get
    Mock::given(method("GET"))
        .and(path("/v1/actions/deploy"))
        .respond_with(ok(json!({
            "id": "act_1",
            "name": "deploy",
            "description": "Deploy the app",
            "handler_agent": "DeployBot",
            "input_schema": {},
            "output_schema": {},
            "available_to": ["BackendAgent"],
            "is_active": true,
            "created_at": "2026-01-01T00:00:00.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let fetched = relay.get_action("deploy").await.expect("get_action failed");
    assert_eq!(
        fetched.available_to.as_deref(),
        Some(&["BackendAgent".to_string()][..])
    );

    // delete (204)
    Mock::given(method("DELETE"))
        .and(path("/v1/actions/deploy"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    relay
        .delete_action("deploy")
        .await
        .expect("delete_action failed");
}

#[tokio::test]
async fn action_invocation_uses_agent_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");
    let agent = relay
        .as_agent("at_live_backend")
        .expect("failed to create agent client");

    // invoke
    Mock::given(method("POST"))
        .and(path("/v1/actions/deploy/invoke"))
        .and(header("authorization", "Bearer at_live_backend"))
        .and(body_json(json!({ "input": { "env": "staging" } })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "ok": true,
            "data": {
                "invocation_id": "inv_1",
                "action_name": "deploy",
                "handler_agent_id": "agent_handler",
                "input": { "env": "staging" },
                "status": "invoked",
                "created_at": "2026-01-01T00:00:00.000Z"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut input = serde_json::Map::new();
    input.insert("env".to_string(), json!("staging"));
    let invoked = agent
        .invoke_action("deploy", Some(input))
        .await
        .expect("invoke_action failed");
    assert_eq!(invoked.invocation_id, "inv_1");
    assert_eq!(invoked.status, ActionInvocationStatus::Invoked);

    // complete
    Mock::given(method("POST"))
        .and(path("/v1/actions/deploy/invocations/inv_1/complete"))
        .and(body_json(json!({
            "output": { "url": "https://staging.example.com" },
            "duration_ms": 1200
        })))
        .respond_with(ok(json!({
            "invocation_id": "inv_1",
            "action_name": "deploy",
            "status": "completed",
            "output": { "url": "https://staging.example.com" },
            "error": null,
            "duration_ms": 1200,
            "completed_at": "2026-01-01T00:00:01.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let mut output = serde_json::Map::new();
    output.insert("url".to_string(), json!("https://staging.example.com"));
    let completed = agent
        .complete_action_invocation(
            "deploy",
            "inv_1",
            CompleteInvocationRequest {
                output: Some(output),
                error: None,
                duration_ms: Some(1200),
            },
        )
        .await
        .expect("complete_action_invocation failed");
    assert_eq!(completed.status, ActionInvocationStatus::Completed);

    // get invocation
    Mock::given(method("GET"))
        .and(path("/v1/actions/deploy/invocations/inv_1"))
        .respond_with(ok(json!({
            "invocation_id": "inv_1",
            "action_name": "deploy",
            "caller_id": "agent_backend",
            "caller_name": "BackendAgent",
            "input": { "env": "staging" },
            "output": { "url": "https://staging.example.com" },
            "status": "completed",
            "error": null,
            "duration_ms": 1200,
            "created_at": "2026-01-01T00:00:00.000Z",
            "completed_at": "2026-01-01T00:00:01.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let fetched = agent
        .get_action_invocation("deploy", "inv_1")
        .await
        .expect("get_action_invocation failed");
    assert_eq!(fetched.status, ActionInvocationStatus::Completed);
    assert_eq!(fetched.caller_name.as_deref(), Some("BackendAgent"));
}

#[tokio::test]
async fn agent_session_events_use_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/agents/Worker/events"))
        .and(body_json(json!({ "type": "status.active" })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({
            "ok": true,
            "data": {
                "id": "evt_1",
                "agent_id": "agent_1",
                "type": "status.active",
                "payload": {},
                "created_at": "2026-01-01T00:00:00.000Z"
            }
        })))
        .expect(1)
        .mount(&server)
        .await;

    let event = relay
        .emit_agent_event(
            "Worker",
            EmitSessionEventRequest {
                event_type: "status.active".to_string(),
                payload: None,
            },
        )
        .await
        .expect("emit_agent_event failed");
    assert_eq!(event.event_type, "status.active");

    Mock::given(method("GET"))
        .and(path("/v1/agents/Worker/events"))
        .and(query_param("type", "status.active"))
        .and(query_param("limit", "50"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;

    let events = relay
        .list_agent_events(
            "Worker",
            Some(ListSessionEventsQuery {
                event_type: Some("status.active".to_string()),
                limit: Some(50),
            }),
        )
        .await
        .expect("list_agent_events failed");
    assert!(events.is_empty());
}

#[test]
fn deserializes_action_ws_events() {
    let invoked: WsEvent = serde_json::from_value(json!({
        "type": "action.invoked",
        "invocation_id": "inv_1",
        "action_name": "deploy",
        "caller_name": "BackendAgent",
        "handler_agent_id": "agent_handler"
    }))
    .expect("action.invoked should deserialize");
    match invoked {
        WsEvent::ActionInvoked(e) => assert_eq!(e.action_name, "deploy"),
        other => panic!("expected ActionInvoked, got {other:?}"),
    }

    let completed: WsEvent = serde_json::from_value(json!({
        "type": "action.completed",
        "invocation_id": "inv_1",
        "action_name": "deploy",
        "status": "completed",
        "output": { "url": "https://x" },
        "error": null
    }))
    .expect("action.completed should deserialize");
    match completed {
        WsEvent::ActionCompleted(e) => assert_eq!(e.action_name, "deploy"),
        other => panic!("expected ActionCompleted, got {other:?}"),
    }

    let failed: WsEvent = serde_json::from_value(json!({
        "type": "action.failed",
        "invocation_id": "inv_1",
        "action_name": "deploy",
        "status": "failed",
        "output": null,
        "error": "boom"
    }))
    .expect("action.failed should deserialize");
    match failed {
        WsEvent::ActionFailed(e) => assert_eq!(e.error.as_deref(), Some("boom")),
        other => panic!("expected ActionFailed, got {other:?}"),
    }

    let denied: WsEvent = serde_json::from_value(json!({
        "type": "action.denied",
        "action_name": "deploy",
        "caller_name": "BackendAgent",
        "error": "Action deploy is not available to BackendAgent"
    }))
    .expect("action.denied should deserialize");
    match denied {
        WsEvent::ActionDenied(e) => {
            assert_eq!(e.action_name, "deploy");
            assert_eq!(e.caller_name.as_deref(), Some("BackendAgent"));
        }
        other => panic!("expected ActionDenied, got {other:?}"),
    }

    // A mismatched status fails fast (event-specific literal): an action.completed
    // payload carrying status "invoked" must not deserialize.
    let bad: Result<WsEvent, _> = serde_json::from_value(json!({
        "type": "action.completed",
        "invocation_id": "inv_1",
        "action_name": "deploy",
        "status": "invoked"
    }));
    assert!(
        bad.is_err(),
        "action.completed with status 'invoked' should fail"
    );
}

#[test]
fn deserializes_delivery_ws_events() {
    let accepted: WsEvent = serde_json::from_value(json!({
        "type": "delivery.accepted",
        "delivery_id": "del_1",
        "message_id": "m_1",
        "channel_id": "ch_1",
        "reason": null
    }))
    .expect("delivery.accepted should deserialize");
    match accepted {
        WsEvent::DeliveryAccepted(e) => {
            assert_eq!(e.delivery_id, "del_1");
            assert_eq!(e.channel_id.as_deref(), Some("ch_1"));
        }
        other => panic!("expected DeliveryAccepted, got {other:?}"),
    }

    let delivered: WsEvent = serde_json::from_value(json!({
        "type": "delivery.delivered",
        "delivery_id": "del_1",
        "message_id": "m_1"
    }))
    .expect("delivery.delivered should deserialize");
    match delivered {
        WsEvent::DeliveryDelivered(e) => assert_eq!(e.message_id, "m_1"),
        other => panic!("expected DeliveryDelivered, got {other:?}"),
    }

    let deferred: WsEvent = serde_json::from_value(json!({
        "type": "delivery.deferred",
        "delivery_id": "del_1",
        "message_id": "m_1",
        "available_at": "2026-06-01T00:05:00.000Z",
        "reason": "busy"
    }))
    .expect("delivery.deferred should deserialize");
    match deferred {
        WsEvent::DeliveryDeferred(e) => {
            assert_eq!(e.available_at.as_deref(), Some("2026-06-01T00:05:00.000Z"));
            assert_eq!(e.reason.as_deref(), Some("busy"));
        }
        other => panic!("expected DeliveryDeferred, got {other:?}"),
    }

    let failed: WsEvent = serde_json::from_value(json!({
        "type": "delivery.failed",
        "delivery_id": "del_1",
        "message_id": "m_1",
        "error": "boom",
        "retryable": true
    }))
    .expect("delivery.failed should deserialize");
    match failed {
        WsEvent::DeliveryFailed(e) => {
            assert_eq!(e.error.as_deref(), Some("boom"));
            assert_eq!(e.retryable, Some(true));
        }
        other => panic!("expected DeliveryFailed, got {other:?}"),
    }
}

#[test]
fn delivery_status_query_values_match_canonical_lifecycle() {
    assert_eq!(DeliveryStatus::Queued.as_query_value(), Some("queued"));
    assert_eq!(DeliveryStatus::Delivered.as_query_value(), Some("delivered"));
    assert_eq!(DeliveryStatus::Acked.as_query_value(), Some("acked"));
    assert_eq!(DeliveryStatus::Failed.as_query_value(), Some("failed"));
    assert_eq!(
        DeliveryStatus::DeadLettered.as_query_value(),
        Some("dead_lettered")
    );
    assert_eq!(DeliveryStatus::Unknown.as_query_value(), None);

    let parsed: DeliveryStatus =
        serde_json::from_value(json!("dead_lettered")).expect("dead_lettered should parse");
    assert_eq!(parsed, DeliveryStatus::DeadLettered);
}

#[tokio::test]
async fn channel_mute_unmute_use_expected_endpoints() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("POST"))
        .and(path("/v1/channels/general/mute"))
        .respond_with(ok(json!({})))
        .expect(1)
        .mount(&server)
        .await;
    agent.mute_channel("general").await.expect("mute failed");

    Mock::given(method("POST"))
        .and(path("/v1/channels/general/unmute"))
        .respond_with(ok(json!({})))
        .expect(1)
        .mount(&server)
        .await;
    agent
        .unmute_channel("general")
        .await
        .expect("unmute failed");
}

#[tokio::test]
async fn invite_to_channel_uses_agent_name_payload() {
    let server = MockServer::start().await;
    let agent = AgentClient::new("at_live_test", Some(server.uri()))
        .expect("failed to create agent client");

    Mock::given(method("POST"))
        .and(path("/v1/channels/general/invite"))
        .and(body_json(json!({ "agent_name": "worker-1" })))
        .respond_with(ok(json!({ "invited": true })))
        .expect(1)
        .mount(&server)
        .await;

    agent
        .invite_to_channel("general", "worker-1")
        .await
        .expect("invite failed");
}

#[tokio::test]
async fn workspace_lookup_returns_none_on_404() {
    let server = MockServer::start().await;

    Mock::given(method("GET"))
        .and(path("/v1/workspaces/by-name/Missing"))
        .respond_with(api_error(404, "not_found", "no such workspace"))
        .expect(1)
        .mount(&server)
        .await;

    let found = RelayCast::lookup_workspace("Missing", Some(&server.uri()))
        .await
        .expect("lookup_workspace failed");
    assert!(found.is_none());

    Mock::given(method("GET"))
        .and(path("/v1/workspaces/by-name/Acme"))
        .respond_with(ok(json!({
            "id": "ws_1",
            "name": "Acme",
            "created_at": "2026-01-01T00:00:00.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let found = RelayCast::lookup_workspace("Acme", Some(&server.uri()))
        .await
        .expect("lookup_workspace failed")
        .expect("workspace should be found");
    assert_eq!(found.id, "ws_1");
    assert_eq!(found.name, "Acme");
}

#[tokio::test]
async fn a2a_surface_uses_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/a2a/register"))
        .and(body_json(json!({ "agent_card_url": "https://x.example.com/card" })))
        .respond_with(ok(json!({
            "relay_name": "external-bot",
            "relay_token": "at_live_a2a",
            "webhook_url": "https://gw/v1/a2a/webhook/ws_1/external-bot",
            "certification": "level_1"
        })))
        .expect(1)
        .mount(&server)
        .await;

    let registered = relay
        .register_a2a(RegisterA2aOptions {
            agent_card_url: Some("https://x.example.com/card".to_string()),
            ..Default::default()
        })
        .await
        .expect("register_a2a failed");
    assert_eq!(registered.relay_name, "external-bot");
    assert_eq!(registered.certification, "level_1");

    Mock::given(method("GET"))
        .and(path("/v1/a2a/agents"))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;
    let agents = relay.list_a2a_agents().await.expect("list_a2a_agents failed");
    assert!(agents.is_empty());

    Mock::given(method("GET"))
        .and(path("/v1/a2a/agents/external-bot/card"))
        .respond_with(ok(json!({
            "name": "external-bot",
            "url": "https://x.example.com",
            "version": "1.0.0",
            "skills": [{ "name": "summarize" }]
        })))
        .expect(1)
        .mount(&server)
        .await;
    let card = relay
        .get_a2a_agent_card("external-bot")
        .await
        .expect("get_a2a_agent_card failed");
    assert_eq!(card.name, "external-bot");
    assert_eq!(card.skills.len(), 1);

    Mock::given(method("DELETE"))
        .and(path("/v1/a2a/agents/external-bot"))
        .respond_with(ok(json!({ "name": "external-bot", "removed": true })))
        .expect(1)
        .mount(&server)
        .await;
    let removed = relay
        .remove_a2a_agent("external-bot")
        .await
        .expect("remove_a2a_agent failed");
    assert!(removed.removed);
}

#[tokio::test]
async fn directory_surface_uses_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    let agent_payload = json!({
        "id": "dir_1",
        "source_agent_id": null,
        "slug": "summarizer",
        "name": "Summarizer",
        "description": "Summarizes text",
        "provider": null,
        "endpoint_url": null,
        "documentation_url": null,
        "version": "1.0.0",
        "tags": ["nlp"],
        "capabilities": {},
        "metadata": {},
        "status": "active",
        "rating_avg": 4.5,
        "rating_count": 2,
        "skills": [],
        "created_at": "2026-01-01T00:00:00.000Z",
        "updated_at": "2026-01-01T00:00:00.000Z"
    });

    Mock::given(method("GET"))
        .and(path("/v1/directory/search"))
        .and(query_param("q", "summary"))
        .and(query_param("tags", "nlp,ml"))
        .and(query_param("limit", "5"))
        .respond_with(ok(json!([{
            "id": "dir_1",
            "source_agent_id": null,
            "slug": "summarizer",
            "name": "Summarizer",
            "description": null,
            "provider": null,
            "endpoint_url": null,
            "documentation_url": null,
            "version": null,
            "tags": ["nlp"],
            "capabilities": {},
            "metadata": {},
            "status": "active",
            "rating_avg": 4.5,
            "rating_count": 2,
            "skills": [],
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": "2026-01-01T00:00:00.000Z",
            "relevance_score": 0.92
        }])))
        .expect(1)
        .mount(&server)
        .await;

    let results = relay
        .search_directory(SearchDirectoryQuery {
            q: Some("summary".to_string()),
            tags: Some(vec!["nlp".to_string(), "ml".to_string()]),
            status: None,
            limit: Some(5),
        })
        .await
        .expect("search_directory failed");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].agent.slug, "summarizer");
    assert!((results[0].relevance_score - 0.92).abs() < 1e-9);

    Mock::given(method("GET"))
        .and(path("/v1/directory/agents/summarizer"))
        .respond_with(ok(agent_payload.clone()))
        .expect(1)
        .mount(&server)
        .await;
    let agent = relay
        .get_directory_agent("summarizer")
        .await
        .expect("get_directory_agent failed");
    assert_eq!(agent.name, "Summarizer");

    Mock::given(method("GET"))
        .and(path("/v1/directory/agents/summarizer/ratings"))
        .respond_with(ok(json!([{
            "id": "rat_1",
            "score": 5.0,
            "review": "great",
            "rater_agent_id": "a_1",
            "rater_agent_name": "alice",
            "created_at": "2026-01-01T00:00:00.000Z"
        }])))
        .expect(1)
        .mount(&server)
        .await;
    let ratings = relay
        .list_directory_ratings("summarizer")
        .await
        .expect("list_directory_ratings failed");
    assert_eq!(ratings[0].rater_agent_name, "alice");

    Mock::given(method("POST"))
        .and(path("/v1/directory/agents/summarizer/ratings"))
        .and(body_json(json!({ "score": 4.0, "review": "solid" })))
        .respond_with(ok(json!({
            "id": "rat_2",
            "score": 4.0,
            "review": "solid",
            "rater_agent_id": "a_2",
            "rater_agent_name": "bob",
            "created_at": "2026-01-02T00:00:00.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let rating = relay
        .rate_directory_agent(
            "summarizer",
            RateDirectoryAgentRequest {
                score: 4.0,
                review: Some("solid".to_string()),
            },
        )
        .await
        .expect("rate_directory_agent failed");
    assert_eq!(rating.id, "rat_2");
}

#[tokio::test]
async fn routing_and_skills_use_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/route"))
        .and(body_json(json!({ "skill": "summarize", "message": "do it" })))
        .respond_with(ok(json!({
            "agent_name": "Summarizer",
            "score": 0.81,
            "fallback": false
        })))
        .expect(1)
        .mount(&server)
        .await;
    let routed = relay
        .route("summarize", Some("do it"))
        .await
        .expect("route failed");
    assert_eq!(routed.agent_name, "Summarizer");
    assert!(!routed.fallback);

    Mock::given(method("POST"))
        .and(path("/v1/route/feedback"))
        .and(body_json(json!({ "agent_name": "Summarizer", "success": true })))
        .respond_with(ok(json!({ "ok": true })))
        .expect(1)
        .mount(&server)
        .await;
    let feedback = relay
        .route_feedback(RouteFeedbackRequest {
            agent_name: "Summarizer".to_string(),
            success: true,
            error: None,
        })
        .await
        .expect("route_feedback failed");
    assert!(feedback.ok);

    Mock::given(method("GET"))
        .and(path("/v1/routing/config"))
        .respond_with(ok(json!({
            "weights": {
                "skill_match": 1.0,
                "message_match": 0.5,
                "tag_match": 0.3,
                "rating": 0.2,
                "availability": 0.1
            },
            "circuit_breaker_threshold": 3.0,
            "circuit_breaker_cooldown_seconds": 60.0,
            "updated_at": null
        })))
        .expect(1)
        .mount(&server)
        .await;
    let config = relay
        .get_routing_config()
        .await
        .expect("get_routing_config failed");
    assert!((config.weights.skill_match - 1.0).abs() < 1e-9);

    Mock::given(method("PUT"))
        .and(path("/v1/routing/config"))
        .and(body_json(json!({ "circuit_breaker_threshold": 5.0 })))
        .respond_with(ok(json!({
            "weights": {
                "skill_match": 1.0,
                "message_match": 0.5,
                "tag_match": 0.3,
                "rating": 0.2,
                "availability": 0.1
            },
            "circuit_breaker_threshold": 5.0,
            "circuit_breaker_cooldown_seconds": 60.0,
            "updated_at": "2026-01-01T00:00:00.000Z"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let updated = relay
        .update_routing_config(UpdateRoutingConfigRequest {
            circuit_breaker_threshold: Some(5.0),
            ..Default::default()
        })
        .await
        .expect("update_routing_config failed");
    assert!((updated.circuit_breaker_threshold - 5.0).abs() < 1e-9);

    Mock::given(method("GET"))
        .and(path("/v1/skills/search"))
        .and(query_param("q", "summary"))
        .respond_with(ok(json!([{
            "agent_name": "Summarizer",
            "skill_name": "summarize",
            "description": null,
            "tags": ["nlp"],
            "relevance_score": 0.77
        }])))
        .expect(1)
        .mount(&server)
        .await;
    let skills = relay
        .search_skills(Some(relaycast::SkillSearchQuery {
            q: Some("summary".to_string()),
            limit: None,
        }))
        .await
        .expect("search_skills failed");
    assert_eq!(skills[0].skill_name, "summarize");
}

#[tokio::test]
async fn nodes_and_triggers_use_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/nodes"))
        .and(body_json(json!({
            "name": "http-node",
            "kind": "http_push",
            "delivery": {
                "url": "https://receiver.example.test/relaycast",
                "ack_mode": "manual",
                "auth": {
                    "type": "hmac_sha256",
                    "secret": "secret",
                    "signature_header": "X-Custom-Signature",
                    "timestamp_header": "X-Custom-Timestamp",
                    "signed_payload": "timestamp.body",
                    "prefix": "sig="
                }
            }
        })))
        .respond_with(ok(json!({
            "id": "node_http",
            "name": "http-node",
            "kind": "http_push",
            "delivery_adapter": "http.hmac.v1",
            "delivery": {
                "url": "https://receiver.example.test/relaycast",
                "ack_mode": "manual",
                "auth": { "type": "hmac_sha256", "secret": "[redacted]" }
            },
            "capabilities": [],
            "tags": [],
            "version": "unknown",
            "status": "offline",
            "live": false,
            "handlers_live": false,
            "load": 0,
            "active_agents": 0,
            "max_agents": 1,
            "last_heartbeat_at": null,
            "created_at": "2026-01-01T00:00:00.000Z",
            "token": "nt_live_test"
        })))
        .expect(1)
        .mount(&server)
        .await;
    let created = relay
        .create_node(CreateNodeRequest {
            node_id: None,
            name: "http-node".to_string(),
            kind: Some("http_push".to_string()),
            delivery_adapter: None,
            delivery: Some(NodeDeliveryConfig::from(HttpPushNodeDelivery {
                url: "https://receiver.example.test/relaycast".to_string(),
                ack_mode: Some("manual".to_string()),
                auth: Some(NodeDeliveryAuth {
                    auth_type: "hmac_sha256".to_string(),
                    token: None,
                    headers: None,
                    secret: Some("secret".to_string()),
                    signature_header: Some("X-Custom-Signature".to_string()),
                    timestamp_header: Some("X-Custom-Timestamp".to_string()),
                    signed_payload: Some("timestamp.body".to_string()),
                    encoding: None,
                    prefix: Some("sig=".to_string()),
                }),
            })),
            capabilities: None,
            max_agents: None,
            tags: None,
            version: None,
        })
        .await
        .expect("create_node failed");
    assert_eq!(created.node.kind.as_deref(), Some("http_push"));
    assert_eq!(created.token, "nt_live_test");

    Mock::given(method("GET"))
        .and(path("/v1/nodes"))
        .and(query_param("capability", "gpu"))
        .respond_with(ok(json!([{
            "id": "node_1",
            "name": "worker-node",
            "kind": "fleet_ws",
            "delivery_adapter": "fleet.ws.v1",
            "delivery": null,
            "capabilities": [{ "name": "gpu", "kind": "hardware" }],
            "tags": ["fast"],
            "version": "1.2.3",
            "status": "online",
            "live": true,
            "handlers_live": true,
            "load": 0.4,
            "active_agents": 2,
            "max_agents": 8,
            "last_heartbeat_at": "2026-01-01T00:00:00.000Z",
            "created_at": "2026-01-01T00:00:00.000Z"
        }])))
        .expect(1)
        .mount(&server)
        .await;
    let nodes = relay
        .list_nodes(Some(NodeListQuery {
            capability: Some("gpu".to_string()),
            name: None,
        }))
        .await
        .expect("list_nodes failed");
    assert_eq!(nodes[0].name, "worker-node");
    assert_eq!(nodes[0].capabilities[0].name, "gpu");
    assert_eq!(nodes[0].capabilities[0].kind.as_deref(), Some("hardware"));
    assert_eq!(nodes[0].kind.as_deref(), Some("fleet_ws"));

    Mock::given(method("GET"))
        .and(path("/v1/nodes/http-node/agents"))
        .respond_with(ok(json!([{
            "id": "anb_1",
            "agent_id": "agent_1",
            "agent_name": "billing-agent",
            "node_id": "node_http",
            "node_name": "http-node",
            "node_kind": "http_push",
            "status": "active",
            "session_ref": null,
            "priority": 0,
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": null
        }])))
        .expect(1)
        .mount(&server)
        .await;
    let bindings = relay
        .list_node_agents("http-node")
        .await
        .expect("list_node_agents failed");
    assert_eq!(bindings[0].agent_name, "billing-agent");

    Mock::given(method("POST"))
        .and(path("/v1/nodes/http-node/agents"))
        .and(body_json(json!({
            "agent_name": "billing-agent",
            "priority": 5
        })))
        .respond_with(ok(json!({
            "id": "anb_1",
            "agent_id": "agent_1",
            "agent_name": "billing-agent",
            "node_id": "node_http",
            "node_name": "http-node",
            "node_kind": "http_push",
            "status": "active",
            "session_ref": null,
            "priority": 5,
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": null
        })))
        .expect(1)
        .mount(&server)
        .await;
    let binding = relay
        .bind_agent_to_node(
            "http-node",
            BindAgentToNodeRequest {
                agent_name: "billing-agent".to_string(),
                session_ref: None,
                priority: Some(5),
            },
        )
        .await
        .expect("bind_agent_to_node failed");
    assert_eq!(binding.priority, 5);

    Mock::given(method("DELETE"))
        .and(path("/v1/nodes/http-node/agents/billing-agent"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    relay
        .unbind_agent_from_node("http-node", "billing-agent")
        .await
        .expect("unbind_agent_from_node failed");

    Mock::given(method("POST"))
        .and(path("/v1/triggers"))
        .and(body_json(json!({
            "channel": "general",
            "action_name": "deploy"
        })))
        .respond_with(ok(json!({
            "id": "trg_1",
            "channel": "general",
            "pattern": null,
            "mention": null,
            "action_name": "deploy",
            "enabled": true,
            "last_triggered_at": null,
            "created_at": "2026-01-01T00:00:00.000Z",
            "updated_at": null
        })))
        .expect(1)
        .mount(&server)
        .await;
    let trigger = relay
        .create_trigger(CreateTriggerRequest {
            channel: Some("general".to_string()),
            pattern: None,
            mention: None,
            action_name: "deploy".to_string(),
            enabled: None,
        })
        .await
        .expect("create_trigger failed");
    assert_eq!(trigger.id, "trg_1");
    assert!(trigger.enabled);

    Mock::given(method("DELETE"))
        .and(path("/v1/triggers/trg_1"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    relay
        .delete_trigger("trg_1")
        .await
        .expect("delete_trigger failed");
}

#[tokio::test]
async fn certify_and_console_use_expected_endpoints() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
        .expect("failed to create relay client");

    Mock::given(method("POST"))
        .and(path("/v1/certify"))
        .and(body_json(json!({ "agent_url": "https://x.example.com", "level": 1 })))
        .respond_with(ok(json!({
            "id": "cert_1",
            "agent_url": "https://x.example.com",
            "level": 1,
            "passed": true,
            "passed_tests": 5,
            "total_tests": 5,
            "tests": [{ "name": "handshake", "passed": true }]
        })))
        .expect(1)
        .mount(&server)
        .await;
    let run = relay
        .certify(SubmitCertificationRequest {
            agent_url: "https://x.example.com".to_string(),
            level: Some(1),
        })
        .await
        .expect("certify failed");
    assert_eq!(run.id, "cert_1");
    assert!(run.passed);
    assert_eq!(run.tests[0].name.as_deref(), Some("handshake"));

    Mock::given(method("POST"))
        .and(path("/v1/certify/monitor"))
        .and(body_json(json!({
            "agent_url": "https://x.example.com",
            "interval_minutes": 60
        })))
        .respond_with(ok(json!({
            "id": "cert_1",
            "agent_url": "https://x.example.com",
            "level": 1,
            "passed": true,
            "passed_tests": 5,
            "total_tests": 5,
            "monitor_enabled": true,
            "monitor_interval_minutes": 60,
            "tests": []
        })))
        .expect(1)
        .mount(&server)
        .await;
    let monitored = relay
        .monitor_certification(MonitorCertificationRequest {
            agent_url: "https://x.example.com".to_string(),
            level: None,
            interval_minutes: Some(60),
        })
        .await
        .expect("monitor_certification failed");
    assert_eq!(monitored.monitor_enabled, Some(true));

    let badge = relay.certification_badge_url("cert_1");
    assert!(badge.ends_with("/v1/certify/cert_1/badge.svg"));

    Mock::given(method("GET"))
        .and(path("/v1/console/messages"))
        .and(query_param("limit", "10"))
        .and(query_param("delivery_kind", "channel"))
        .respond_with(ok(json!([{
            "id": "log_1",
            "message_id": "m_1",
            "channel_id": "ch_1",
            "channel_name": "general",
            "agent_id": "a_1",
            "agent_name": "alice",
            "conversation_id": null,
            "delivery_kind": "channel",
            "text": "hi",
            "content_type": "text",
            "metadata": {},
            "attachment_count": 0,
            "mention_count": 0,
            "latency_ms": 12,
            "created_at": "2026-01-01T00:00:00.000Z"
        }])))
        .expect(1)
        .mount(&server)
        .await;
    let logs = relay
        .console_messages(Some(relaycast::ConsoleMessagesQuery {
            limit: Some(10),
            delivery_kind: Some("channel".to_string()),
            ..Default::default()
        }))
        .await
        .expect("console_messages failed");
    assert_eq!(logs[0].channel_name.as_deref(), Some("general"));

    Mock::given(method("GET"))
        .and(path("/v1/console/costs"))
        .and(query_param("days", "7"))
        .respond_with(ok(json!({
            "window_days": 7,
            "totals": {
                "total_cost_usd": 1.25,
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "total_tokens": 150
            },
            "agents": []
        })))
        .expect(1)
        .mount(&server)
        .await;
    let costs = relay
        .console_costs(Some(relaycast::ConsoleWindowQuery { days: Some(7) }))
        .await
        .expect("console_costs failed");
    assert_eq!(costs.window_days, 7);
    assert!((costs.totals.total_cost_usd - 1.25).abs() < 1e-9);
}
