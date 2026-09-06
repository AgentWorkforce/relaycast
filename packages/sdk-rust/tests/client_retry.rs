//! Deterministic coverage for `HttpClient`'s 5xx retry loop (issue #374):
//! a retryable 5xx must honor a bounded `Retry-After` delay, must not sleep
//! after the final attempt, and must surface the *last* response's real
//! diagnostic instead of an opaque "max retries exceeded".

use relaycast::{ClientOptions, HttpClient, RelayError};
use reqwest::Method;
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use wiremock::matchers::method as method_matcher;
use wiremock::{Mock, MockServer, ResponseTemplate};

fn ok(data: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "data": data }))
}

fn api_error(status: u16, code: &str, message: &str) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_json(json!({
        "ok": false,
        "error": { "code": code, "message": message }
    }))
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
    let started = Instant::now();
    let result: Value = client
        .request(Method::GET, "/v1/workspace", None::<()>, None, None)
        .await
        .expect("second attempt should succeed");

    assert_eq!(result, json!({ "id": "ws_1" }));
    // Retry-After: 0 must not fall back to the larger default backoff.
    assert!(started.elapsed() < Duration::from_millis(150));
}

/// A `Retry-After` value larger than the client's bound is capped rather
/// than honored verbatim, so a hostile or misconfigured server can't stall
/// the caller far past the client's own backoff policy.
#[tokio::test]
async fn bounds_an_excessive_retry_after_delay() {
    let mock_server = MockServer::start().await;

    Mock::given(method_matcher("GET"))
        .respond_with(
            api_error(503, "service_unavailable", "slow down").insert_header("Retry-After", "3600"),
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
    let started = Instant::now();
    let result: Value = client
        .request(Method::GET, "/v1/workspace", None::<()>, None, None)
        .await
        .expect("second attempt should succeed");

    assert_eq!(result, json!({ "id": "ws_1" }));
    // Bounded well under the 3600s the header asked for.
    assert!(started.elapsed() < Duration::from_secs(6));
}

/// Every attempt returning a retryable 5xx must not sleep after the final
/// attempt, and must return that last response's real status/code/message
/// instead of a generic "max retries exceeded" error.
#[tokio::test]
async fn exhausted_retries_preserve_the_terminal_diagnostic_without_a_final_sleep() {
    let mock_server = MockServer::start().await;

    Mock::given(method_matcher("GET"))
        .respond_with(api_error(
            503,
            "upstream_timeout",
            "no healthy upstream after 3 attempts",
        ))
        .expect(3)
        .mount(&mock_server)
        .await;

    let client = client_for(&mock_server);
    let started = Instant::now();
    let err = client
        .request::<Value>(Method::GET, "/v1/workspace", None::<()>, None, None)
        .await
        .expect_err("retries should exhaust with the last response's error");
    let elapsed = started.elapsed();

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

    // Only 2 sleeps should occur (after attempts 1 and 2); the loop's default
    // backoffs are 200ms + 400ms, well under a 1s ceiling even with scheduling
    // slack. A regression that sleeps after the final attempt too would add
    // another 800ms and push this well past the ceiling.
    assert!(
        elapsed < Duration::from_millis(1000),
        "expected no sleep after the final attempt, took {elapsed:?}"
    );
}

/// A non-JSON body on the final exhausted attempt (e.g. a bare-text 502 from
/// a proxy in front of the API) must still surface the real HTTP status
/// instead of being swallowed into an opaque JSON-parse error.
#[tokio::test]
async fn exhausted_retries_preserve_status_even_with_a_non_json_body() {
    let mock_server = MockServer::start().await;

    Mock::given(method_matcher("GET"))
        .respond_with(ResponseTemplate::new(502).set_body_string("<html>Bad Gateway</html>"))
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
            status, attempts, ..
        } => {
            assert_eq!(status, 502);
            assert_eq!(attempts, 3);
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
