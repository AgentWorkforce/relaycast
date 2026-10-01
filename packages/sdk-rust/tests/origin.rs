use relaycast::{AgentClient, ClientOptions, RelayCast, RelayCastOptions};
use serde_json::json;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn ok(data: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"ok": true, "data": data}))
}

fn agent_data() -> serde_json::Value {
    json!({"id": "a_1", "name": "desktop", "type": "agent", "status": "online"})
}

#[test]
fn relay_origin_options_preserve_defaults_and_builder_values() {
    let defaults = RelayCastOptions::new("rk_test");
    assert!(defaults.origin_client.is_none());
    assert!(defaults.origin_version.is_none());
    let custom = defaults.with_origin("relay-desktop", "1.2.3");
    assert_eq!(custom.origin_client.as_deref(), Some("relay-desktop"));
    assert_eq!(custom.origin_version.as_deref(), Some("1.2.3"));
}

#[tokio::test]
async fn relay_requests_send_custom_origin_headers() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(
        RelayCastOptions::new("rk_test")
            .with_base_url(server.uri())
            .with_origin("relay-desktop", "1.2.3")
            .with_origin_actor("codex")
            .with_agent_relay_distinct_id("user-1"),
    )
    .unwrap();
    for endpoint in ["/v1/agents", "/v1/channels", "/v1/webhooks"] {
        Mock::given(method("GET"))
            .and(path(endpoint))
            .and(header("authorization", "Bearer rk_test"))
            .and(header("x-relaycast-origin-client", "relay-desktop"))
            .and(header("x-relaycast-origin-version", "1.2.3"))
            .and(header("x-sdk-version", VERSION))
            .and(header("x-relaycast-origin-actor", "codex"))
            .and(header("x-agent-relay-distinct-id", "user-1"))
            .respond_with(ok(json!([])))
            .expect(1)
            .mount(&server)
            .await;
    }
    relay.list_agents(None).await.unwrap();
    relay.list_channels(false).await.unwrap();
    relay.list_webhooks().await.unwrap();
}

#[tokio::test]
async fn relay_and_legacy_agent_requests_keep_sdk_defaults() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v1/agents"))
        .and(header("x-relaycast-origin-client", "@relaycast/sdk-rust"))
        .and(header("x-relaycast-origin-version", VERSION))
        .respond_with(ok(json!([])))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/heartbeat"))
        .and(header("x-relaycast-origin-client", "@relaycast/sdk-rust"))
        .and(header("x-relaycast-origin-version", VERSION))
        .respond_with(ok(json!({})))
        .expect(1)
        .mount(&server)
        .await;
    let relay =
        RelayCast::new(RelayCastOptions::new("rk_test").with_base_url(server.uri())).unwrap();
    relay.list_agents(None).await.unwrap();
    AgentClient::new("at_test", Some(server.uri()))
        .unwrap()
        .heartbeat()
        .await
        .unwrap();
}

#[tokio::test]
async fn relay_origin_fields_default_independently() {
    let server = MockServer::start().await;
    for (client, version, token) in [
        ("relay-desktop", VERSION, "rk_client"),
        ("@relaycast/sdk-rust", "1.2.3", "rk_version"),
    ] {
        Mock::given(method("GET"))
            .and(path("/v1/agents"))
            .and(header("authorization", format!("Bearer {token}")))
            .and(header("x-relaycast-origin-client", client))
            .and(header("x-relaycast-origin-version", version))
            .respond_with(ok(json!([])))
            .expect(1)
            .mount(&server)
            .await;
        let mut options = RelayCastOptions::new(token).with_base_url(server.uri());
        if token == "rk_client" {
            options.origin_client = Some(client.into());
        } else {
            options.origin_version = Some(version.into());
        }
        RelayCast::new(options)
            .unwrap()
            .list_agents(None)
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn inherited_and_reconnected_agents_preserve_origin_after_token_replacement() {
    let server = MockServer::start().await;
    let relay = RelayCast::new(
        RelayCastOptions::new("rk_test")
            .with_base_url(server.uri())
            .with_origin("relay-desktop", "1.2.3"),
    )
    .unwrap();
    Mock::given(method("GET"))
        .and(path("/v1/agent"))
        .and(header("authorization", "Bearer at_reconnect"))
        .and(header("x-relaycast-origin-client", "relay-desktop"))
        .and(header("x-relaycast-origin-version", "1.2.3"))
        .respond_with(ok(agent_data()))
        .expect(1)
        .mount(&server)
        .await;
    for token in ["at_first", "at_rotated", "at_reconnect"] {
        Mock::given(method("POST"))
            .and(path("/v1/agents/heartbeat"))
            .and(header("authorization", format!("Bearer {token}")))
            .and(header("x-relaycast-origin-client", "relay-desktop"))
            .and(header("x-relaycast-origin-version", "1.2.3"))
            .respond_with(ok(json!({})))
            .expect(1)
            .mount(&server)
            .await;
    }
    let mut agent = relay.as_agent("at_first").unwrap();
    agent.heartbeat().await.unwrap();
    agent.set_token("at_rotated").await.unwrap();
    agent.heartbeat().await.unwrap();
    relay
        .reconnect_agent("at_reconnect")
        .await
        .unwrap()
        .heartbeat()
        .await
        .unwrap();
}

#[tokio::test]
async fn standalone_agent_accepts_origin_options_and_preserves_them_on_rotation() {
    let server = MockServer::start().await;
    let mut agent = AgentClient::with_options(
        ClientOptions::new("at_first")
            .with_base_url(server.uri())
            .with_origin("relay-desktop", "1.2.3")
            .with_origin_actor("codex")
            .with_agent_relay_distinct_id("user-1"),
    )
    .unwrap();
    for token in ["at_first", "at_rotated"] {
        Mock::given(method("POST"))
            .and(path("/v1/agents/heartbeat"))
            .and(header("authorization", format!("Bearer {token}")))
            .and(header("x-relaycast-origin-client", "relay-desktop"))
            .and(header("x-relaycast-origin-version", "1.2.3"))
            .and(header("x-relaycast-origin-actor", "codex"))
            .and(header("x-agent-relay-distinct-id", "user-1"))
            .respond_with(ok(json!({})))
            .expect(1)
            .mount(&server)
            .await;
        agent.set_token(token).await.unwrap();
        agent.heartbeat().await.unwrap();
    }
}

#[tokio::test]
async fn inherited_and_standalone_agents_forward_origin_to_websocket() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::time::Duration;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};

    for inherited in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base_url = format!("http://{}", listener.local_addr().unwrap());
        let (uri_tx, uri_rx) = mpsc::channel();
        let server = std::thread::spawn(move || {
            for (endpoint, data) in [
                ("GET /v1/agent ", agent_data()),
                (
                    "POST /v1/agent/node-token ",
                    json!({"node_id": "n_1", "node_name": "desktop", "token": "nt_test"}),
                ),
            ] {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                let request = String::from_utf8(request).unwrap();
                assert!(request.starts_with(endpoint));
                let content_length = request
                    .lines()
                    .filter_map(|line| line.split_once(':'))
                    .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                    .map(|(_, value)| value.trim().parse::<usize>().unwrap())
                    .unwrap_or(0);
                stream.read_exact(&mut vec![0; content_length]).unwrap();
                let body = json!({"ok": true, "data": data}).to_string();
                write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", body.len(), body).unwrap();
            }
            let (stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let _socket = tokio_tungstenite::tungstenite::accept_hdr(
                stream,
                |request: &Request, response: Response| {
                    uri_tx.send(request.uri().to_string()).unwrap();
                    Ok(response)
                },
            )
            .unwrap();
        });
        let mut agent = if inherited {
            RelayCast::new(
                RelayCastOptions::new("rk_test")
                    .with_base_url(base_url)
                    .with_origin("relay-desktop", "1.2.3"),
            )
            .unwrap()
            .as_agent("at_test")
            .unwrap()
        } else {
            AgentClient::with_options(
                ClientOptions::new("at_test")
                    .with_base_url(base_url)
                    .with_origin("relay-desktop", "1.2.3"),
            )
            .unwrap()
        };
        agent.connect().await.unwrap();
        let uri = uri_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let url = url::Url::parse(&format!("http://localhost{uri}")).unwrap();
        assert_eq!(url.path(), "/v1/node/ws");
        for (key, expected) in [
            ("origin_client", "relay-desktop"),
            ("origin_version", "1.2.3"),
            ("token", "nt_test"),
        ] {
            assert_eq!(
                url.query_pairs().find(|(k, _)| k == key).unwrap().1,
                expected
            );
        }
        server.join().unwrap();
    }
}
