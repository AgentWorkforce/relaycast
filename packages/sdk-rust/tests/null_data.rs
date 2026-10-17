//! Acknowledgement routes (engine `jsonSuccess`) answer
//! `{ "ok": true, "data": null }`. Callers that expect no payload must
//! succeed; callers that expect a typed payload must still see the error.

use relaycast::{AgentClient, ClientOptions, HttpClient, RelayError};
use serde::Deserialize;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn null_data() -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "data": null }))
}

#[tokio::test]
async fn heartbeat_accepts_null_data() {
    let mock_server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/agents/heartbeat"))
        .respond_with(null_data())
        .expect(1)
        .mount(&mock_server)
        .await;

    let agent = AgentClient::new("at_live_test", Some(mock_server.uri())).expect("agent client");
    agent
        .heartbeat()
        .await
        .expect("null data acknowledges the heartbeat");
}

#[tokio::test]
async fn untyped_and_optional_requests_accept_null_data() {
    let mock_server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(null_data())
        .mount(&mock_server)
        .await;

    let client =
        HttpClient::new(ClientOptions::new("rk_live_test").with_base_url(mock_server.uri()))
            .expect("client options are valid");
    let value: Value = client.get("/v1/ack", None, None).await.expect("value");
    assert_eq!(value, Value::Null);
    let optional: Option<Value> = client.get("/v1/ack", None, None).await.expect("option");
    assert!(optional.is_none());
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
struct Typed {
    id: String,
}

#[tokio::test]
async fn typed_request_still_rejects_null_data() {
    let mock_server = MockServer::start().await;
    Mock::given(method("GET"))
        .respond_with(null_data())
        .mount(&mock_server)
        .await;

    let client =
        HttpClient::new(ClientOptions::new("rk_live_test").with_base_url(mock_server.uri()))
            .expect("client options are valid");
    let error = client
        .get::<Typed>("/v1/typed", None, None)
        .await
        .expect_err("a typed payload cannot be null");
    assert!(
        matches!(error, RelayError::Json(_)),
        "unexpected error: {error:?}"
    );
}
