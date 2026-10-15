use relaycast::{ClientOptions, HttpClient, RelayError};
use serde::Deserialize;
use serde_json::{json, Value};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// Serve one response envelope through the real HTTP client on a local mock server.
async fn client_for(status: u16, body: Value) -> (MockServer, HttpClient) {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/test"))
        .respond_with(ResponseTemplate::new(status).set_body_json(body))
        .expect(1)
        .mount(&server)
        .await;
    let client =
        HttpClient::new(ClientOptions::new("at_live_test").with_base_url(server.uri())).unwrap();
    (server, client)
}

#[tokio::test]
async fn explicit_null_data_is_valid_for_value_unit_and_optional_payloads() {
    let (_server, client) = client_for(200, json!({"ok": true, "data": null})).await;
    let result: Value = client
        .post("/v1/test", Some(json!({})), None)
        .await
        .unwrap();
    assert_eq!(result, Value::Null);

    let (_server, client) = client_for(200, json!({"ok": true, "data": null})).await;
    client
        .post::<()>("/v1/test", Some(json!({})), None)
        .await
        .unwrap();

    let (_server, client) = client_for(200, json!({"ok": true, "data": null})).await;
    let result: Option<String> = client
        .post("/v1/test", Some(json!({})), None)
        .await
        .unwrap();
    assert_eq!(result, None);
}

#[tokio::test]
async fn missing_data_is_still_an_invalid_response() {
    let (_server, client) = client_for(200, json!({"ok": true})).await;
    let error = client
        .post::<Value>("/v1/test", Some(json!({})), None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, RelayError::InvalidResponse(message) if message == "Response missing data field")
    );
}

#[derive(Debug, Deserialize, PartialEq)]
struct Payload {
    id: String,
}

#[tokio::test]
async fn null_does_not_satisfy_a_required_object_payload() {
    let (_server, client) = client_for(200, json!({"ok": true, "data": null})).await;
    let error = client
        .post::<Payload>("/v1/test", Some(json!({})), None)
        .await
        .unwrap_err();
    assert!(matches!(error, RelayError::Json(_)));
}

#[tokio::test]
async fn object_payloads_still_decode_without_requiring_default() {
    let (_server, client) = client_for(200, json!({"ok": true, "data": {"id": "agent_1"}})).await;
    let result: Payload = client
        .post("/v1/test", Some(json!({})), None)
        .await
        .unwrap();
    assert_eq!(
        result,
        Payload {
            id: "agent_1".into()
        }
    );
}

#[tokio::test]
async fn api_errors_without_data_retain_their_status_and_code() {
    let (_server, client) = client_for(
        401,
        json!({
            "ok": false, "error": {"code": "agent_token_invalid", "message": "Invalid token"}
        }),
    )
    .await;
    let error = client
        .post::<Value>("/v1/test", Some(json!({})), None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, RelayError::Api { status: 401, code, .. } if code == "agent_token_invalid")
    );
}

#[tokio::test]
async fn api_errors_with_null_data_do_not_require_the_success_payload_type() {
    let (_server, client) = client_for(
        401,
        json!({
            "ok": false, "data": null,
            "error": {"code": "agent_token_invalid", "message": "Invalid token"}
        }),
    )
    .await;
    let error = client
        .post::<Payload>("/v1/test", Some(json!({})), None)
        .await
        .unwrap_err();
    assert!(
        matches!(error, RelayError::Api { status: 401, code, .. } if code == "agent_token_invalid")
    );
}

#[tokio::test]
async fn no_content_responses_still_succeed() {
    let server = MockServer::start().await;
    Mock::given(method("DELETE"))
        .and(path("/v1/test"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    let client =
        HttpClient::new(ClientOptions::new("at_live_test").with_base_url(server.uri())).unwrap();
    client.delete("/v1/test", None).await.unwrap();
}
