use relaycast::{
    AgentClient, CreateAgentRequest, CreateChannelRequest, DmConversationSummary,
    MessageInjectionMode, MessageListQuery, RelayCast, RelayCastOptions, ReleaseAgentRequest,
    SpawnAgentRequest, WsEvent,
};
use serde_json::json;
use wiremock::matchers::{body_json, header, method, path, query_param};
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
        .and(header("x-relaycast-origin-surface", "sdk"))
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
