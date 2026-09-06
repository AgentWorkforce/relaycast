//! Deterministic coverage for `HttpClient`'s 5xx retry loop (issue #374):
//! a retryable 5xx must honor a bounded `Retry-After` delay, must not sleep
//! after the final attempt, and must surface the *last* response's real
//! diagnostic instead of an opaque "max retries exceeded".

use relaycast::{ClientOptions, HttpClient, RelayError, RequestOptions};
use reqwest::Method;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use wiremock::matchers::method as method_matcher;
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

fn ok(data: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "data": data }))
}

fn api_error(status: u16, code: &str, message: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({
        "ok": false,
        "error": { "code": code, "message": message }
    }))
}

/// Simulates a server that committed a mutation before an intermediary
/// returned a 503 to the client.
struct CommitThen503 {
    committed_mutations: Arc<AtomicUsize>,
}

impl Respond for CommitThen503 {
    fn respond(&self, _request: &Request) -> ResponseTemplate {
        self.committed_mutations.fetch_add(1, Ordering::SeqCst);
        api_error(
            503,
            "service_unavailable",
            "committed mutation behind proxy failure",
        )
    }
}

fn client_for(mock_server: &MockServer) -> HttpClient {
    HttpClient::new(ClientOptions::new("rk_live_test").with_base_url(mock_server.uri()))
        .expect("client options are valid")
}

/// A 503 with a `Retry-After` header on every attempt is retried, then
/// recovers once the server responds 200 — using the retry-after delay
/// instead of the client's default backoff.
#[tokio::test]
async fn recovers_from_503_with_retry_after_header() {
    let mock_server = MockServer::start().await;

    Mock::given(method_matcher("GET"))
        .respond_with(
            api_error(503, "service_unavailable", "backing store is warming up")
                .insert_header("Retry-After", "0"),
        )
        .up_to_n_times(1)
        .expect(1)
        .mount(&mock_server)
        .await;

    Mock::given(method_matcher("GET"))
        .respond_with(ok(json!({ "id": "ws_1" })))
        .expect(1)
        .mount(&mock_server)
        .await;

    let client = client_for(&mock_server);
    let result: Value = client
        .request(Method::GET, "/v1/workspace", None::<()>, None, None)
        .await
        .expect("second attempt should succeed");

    assert_eq!(result, json!({ "id": "ws_1" }));
}

/// Every attempt returning a retryable 5xx must not sleep after the final
/// attempt, and must return that last response's real status/code/message
/// instead of a generic "max retries exceeded" error.
#[tokio::test]
async fn exhausted_retries_preserve_the_terminal_diagnostic_without_a_final_sleep() {
    let mock_server = MockServer::start().await;

    Mock::given(method_matcher("POST"))
        .respond_with(api_error(
            503,
            "upstream_timeout",
            "no healthy upstream after 3 attempts",
        ))
        .expect(3)
        .mount(&mock_server)
        .await;

    let client = client_for(&mock_server);
    let err = client
        .request::<Value>(
            Method::POST,
            "/v1/workspace",
            Some(json!({ "name": "worker-374" })),
            None,
            Some(RequestOptions::with_idempotency_key("worker-374-retry")),
        )
        .await
        .expect_err("retries should exhaust with the last response's error");

    assert!(err.is_retryable(), "exhausted 5xx must stay retryable");
    match err {
        RelayError::Api {
            code,
            message,
            status,
            attempts,
            ..
        } => {
            assert_eq!(status, 503);
            assert_eq!(code, "upstream_timeout");
            assert_eq!(message, "no healthy upstream after 3 attempts");
            assert_eq!(attempts, 3);
        }
        other => panic!("expected a preserved RelayError::Api, got {other:?}"),
    }
}

#[tokio::test]
async fn unsafe_mutations_retry_only_with_an_idempotency_key() {
    let unkeyed_server = MockServer::start().await;
    let committed_mutations = Arc::new(AtomicUsize::new(0));
    Mock::given(method_matcher("POST"))
        .respond_with(CommitThen503 {
            committed_mutations: Arc::clone(&committed_mutations),
        })
        .expect(1)
        .mount(&unkeyed_server)
        .await;

    let unkeyed = client_for(&unkeyed_server)
        .post::<Value>("/v1/agents", Some(json!({ "name": "worker-unsafe" })), None)
        .await
        .expect_err("unkeyed mutation must not retry after an ambiguous 503");
    assert_eq!(unkeyed.attempts(), Some(1));
    assert_eq!(
        committed_mutations.load(Ordering::SeqCst),
        1,
        "an ambiguous committed mutation must be sent exactly once"
    );

    let keyed_server = MockServer::start().await;
    Mock::given(method_matcher("POST"))
        .respond_with(
            api_error(503, "service_unavailable", "retry safely").insert_header("Retry-After", "0"),
        )
        .up_to_n_times(1)
        .expect(1)
        .mount(&keyed_server)
        .await;
    Mock::given(method_matcher("POST"))
        .respond_with(ok(json!({ "id": "agent-keyed" })))
        .expect(1)
        .mount(&keyed_server)
        .await;

    let value: Value = client_for(&keyed_server)
        .post(
            "/v1/agents",
            Some(json!({ "name": "worker-keyed" })),
            Some(RequestOptions::with_idempotency_key("worker-keyed-retry")),
        )
        .await
        .expect("keyed mutation should retry safely");
    assert_eq!(value, json!({ "id": "agent-keyed" }));
}

/// A non-JSON body on the final exhausted attempt (e.g. a bare-text 502 from
/// a proxy in front of the API) must surface both the real HTTP status and a
/// bounded, single-line body summary instead of an opaque JSON-parse error.
#[tokio::test]
async fn exhausted_retries_preserve_status_even_with_a_non_json_body() {
    let mock_server = MockServer::start().await;

    Mock::given(method_matcher("GET"))
        .respond_with(
            ResponseTemplate::new(502)
                .set_body_string("<html>Bad Gateway marker-374</html>\nnext line"),
        )
        .expect(3)
        .mount(&mock_server)
        .await;

    let client = client_for(&mock_server);
    let err = client
        .request::<Value>(Method::GET, "/v1/workspace", None::<()>, None, None)
        .await
        .expect_err("non-JSON terminal response should still be an error");

    match err {
        RelayError::Api {
            status,
            attempts,
            message,
            ..
        } => {
            assert_eq!(status, 502);
            assert_eq!(attempts, 3);
            assert!(message.contains("Bad Gateway marker-374"));
            assert!(message.contains("next line"));
            assert!(!message.contains('\n'));
        }
        other => panic!("expected status to survive a non-JSON body, got {other:?}"),
    }
}

/// A single retryable 5xx followed by success is the base case: it must
/// recover without surfacing any error.
#[tokio::test]
async fn recovers_after_one_retryable_5xx() {
    let mock_server = MockServer::start().await;

    Mock::given(method_matcher("GET"))
        .respond_with(api_error(500, "internal_error", "transient failure"))
        .up_to_n_times(1)
        .expect(1)
        .mount(&mock_server)
        .await;

    Mock::given(method_matcher("GET"))
        .respond_with(ok(json!({ "id": "ws_1" })))
        .expect(1)
        .mount(&mock_server)
        .await;

    let client = client_for(&mock_server);
    let result: Value = client
        .request(Method::GET, "/v1/workspace", None::<()>, None, None)
        .await
        .expect("should recover after the first retryable 5xx");

    assert_eq!(result, json!({ "id": "ws_1" }));
}
