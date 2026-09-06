//! HTTP client for the RelayCast API.

use reqwest::{header::HeaderMap, Client, Method, RequestBuilder};
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;

use crate::error::{RelayError, Result};
use crate::origin_actor::{
    sanitize_agent_relay_distinct_id, sanitize_origin_actor, AGENT_RELAY_DISTINCT_ID_HEADER,
    ORIGIN_ACTOR_HEADER,
};
use crate::types::ApiResponse;

use crate::DEFAULT_BASE_URL;

const SDK_VERSION: &str = env!("CARGO_PKG_VERSION");
const DEFAULT_ORIGIN_CLIENT: &str = "@relaycast/sdk-rust";
// One entry per attempt. The delay for the final attempt is never used —
// there is nothing left to wait for once retries are exhausted.
const RETRY_BACKOFFS_MS: [u64; 3] = [200, 400, 800];
// Upper bound on a server-provided `Retry-After` delay so a misconfigured or
// hostile response can't stall a caller far past the client's own backoff.
const MAX_RETRY_AFTER_MS: u64 = 5_000;
const MAX_ERROR_BODY_SUMMARY_CHARS: usize = 512;
const MAX_REQUEST_ID_CHARS: usize = 256;
const REQUEST_ID_HEADER_CANDIDATES: [&str; 2] = ["x-request-id", "x-correlation-id"];

/// Parse a bounded retry delay (in milliseconds) from a response's
/// `Retry-After` header. Only the delay-seconds form is supported; malformed
/// or missing headers fall back to the caller's default backoff.
fn parse_retry_after_ms(headers: &HeaderMap) -> Option<u64> {
    let value = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let seconds: u64 = value.trim().parse().ok()?;
    Some(seconds.saturating_mul(1000).min(MAX_RETRY_AFTER_MS))
}

fn retry_delay_ms(headers: &HeaderMap, fallback_ms: u64) -> u64 {
    parse_retry_after_ms(headers).unwrap_or(fallback_ms)
}

fn request_is_retryable(method: &Method, options: &RequestOptions) -> bool {
    matches!(
        *method,
        Method::GET | Method::HEAD | Method::OPTIONS | Method::TRACE | Method::PUT | Method::DELETE
    ) || options.idempotency_key.is_some()
}

fn should_retry_server_error(
    method: &Method,
    options: &RequestOptions,
    status: u16,
    attempt: usize,
    last_attempt: usize,
) -> bool {
    request_is_retryable(method, options) && (500..=599).contains(&status) && attempt < last_attempt
}

/// Extract a correlation/request id from a response, if the server sent one.
fn extract_request_id(headers: &HeaderMap) -> Option<String> {
    REQUEST_ID_HEADER_CANDIDATES.iter().find_map(|name| {
        headers
            .get(*name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| {
                let value = value.trim();
                let value: String = value
                    .chars()
                    .filter(|character| !character.is_control())
                    .take(MAX_REQUEST_ID_CHARS)
                    .collect();
                (!value.is_empty()).then_some(value)
            })
    })
}

/// Return a bounded, single-line, lossy summary suitable for an error message.
///
/// Gateway errors are often HTML or plain text. Keeping a small diagnostic
/// excerpt is materially more useful than a serde parse error, but response
/// bodies must not be allowed to create multi-line logs or unbounded errors.
fn error_body_summary(bytes: &[u8]) -> String {
    let decoded = String::from_utf8_lossy(bytes);
    let mut characters = decoded.chars().map(|character| {
        if character.is_control() || matches!(character, '\u{2028}' | '\u{2029}') {
            ' '
        } else {
            character
        }
    });
    let summary: String = characters
        .by_ref()
        .take(MAX_ERROR_BODY_SUMMARY_CHARS)
        .collect();
    let truncated = characters.next().is_some();
    let summary = summary.trim();

    if summary.is_empty() {
        "<empty>".to_string()
    } else if truncated {
        format!("{summary}…")
    } else {
        summary.to_string()
    }
}

/// Options for creating an HTTP client.
#[derive(Debug, Clone)]
pub struct ClientOptions {
    /// The API key for authentication.
    pub api_key: String,
    /// The base URL for the API (defaults to https://cast.agentrelay.com).
    pub base_url: Option<String>,
    /// SDK origin client metadata.
    pub origin_client: Option<String>,
    /// SDK origin version metadata.
    pub origin_version: Option<String>,
    /// User-Agent-style identifier for the origin_actor driving requests
    /// (e.g. `"claude-code/2.3 (model=opus-4.8)"`, `"codex"`, `"human"`). Sent as
    /// the `X-Relaycast-Origin-Actor` header; invalid values are dropped.
    pub origin_actor: Option<String>,
    /// Agent Relay distinct telemetry id. Sent as the
    /// `X-Agent-Relay-Distinct-Id` header; invalid values are dropped.
    pub agent_relay_distinct_id: Option<String>,
}

impl ClientOptions {
    /// Create new client options with the given API key.
    pub fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            base_url: None,
            origin_client: None,
            origin_version: None,
            origin_actor: None,
            agent_relay_distinct_id: None,
        }
    }

    /// Set a custom base URL.
    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = Some(base_url.into());
        self
    }

    /// Set origin metadata headers.
    pub fn with_origin(
        mut self,
        origin_client: impl Into<String>,
        origin_version: impl Into<String>,
    ) -> Self {
        self.origin_client = Some(origin_client.into());
        self.origin_version = Some(origin_version.into());
        self
    }

    /// Set the origin_actor identifier sent as the `X-Relaycast-Origin-Actor` header.
    pub fn with_origin_actor(mut self, origin_actor: impl Into<String>) -> Self {
        self.origin_actor = Some(origin_actor.into());
        self
    }

    /// Set Agent Relay's distinct telemetry id.
    pub fn with_agent_relay_distinct_id(mut self, id: impl Into<String>) -> Self {
        self.agent_relay_distinct_id = Some(id.into());
        self
    }
}

/// Options for individual requests.
#[derive(Debug, Clone, Default)]
pub struct RequestOptions {
    /// Additional headers to include.
    pub headers: Option<Vec<(String, String)>>,
    /// Idempotency key for the request.
    pub idempotency_key: Option<String>,
}

impl RequestOptions {
    /// Create request options with an idempotency key.
    pub fn with_idempotency_key(key: impl Into<String>) -> Self {
        Self {
            idempotency_key: Some(key.into()),
            ..Default::default()
        }
    }
}

/// HTTP client for making requests to the RelayCast API.
#[derive(Debug, Clone)]
pub struct HttpClient {
    client: Client,
    api_key: String,
    base_url: String,
    origin_client: String,
    origin_version: String,
    origin_actor: Option<String>,
    agent_relay_distinct_id: Option<String>,
}

impl HttpClient {
    /// Create a new HTTP client with the given options.
    pub fn new(options: ClientOptions) -> Result<Self> {
        let client = Client::builder().timeout(Duration::from_secs(30)).build()?;

        Ok(Self {
            client,
            api_key: options.api_key,
            base_url: options
                .base_url
                .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
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
        })
    }

    /// Get the API key.
    pub fn api_key(&self) -> &str {
        &self.api_key
    }

    /// Get the base URL.
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Get the origin client metadata value.
    pub fn origin_client(&self) -> &str {
        &self.origin_client
    }

    /// Get the origin version metadata value.
    pub fn origin_version(&self) -> &str {
        &self.origin_version
    }

    /// Get the sanitized origin_actor identifier, if one was supplied.
    pub fn origin_actor(&self) -> Option<&str> {
        self.origin_actor.as_deref()
    }

    /// Get the sanitized Agent Relay distinct id, if one was supplied.
    pub fn agent_relay_distinct_id(&self) -> Option<&str> {
        self.agent_relay_distinct_id.as_deref()
    }

    /// Return a cloned client with a different API key while preserving base URL and origin metadata.
    pub fn with_api_key(&self, api_key: impl Into<String>) -> Result<Self> {
        let mut options = ClientOptions::new(api_key)
            .with_base_url(self.base_url.clone())
            .with_origin(self.origin_client.clone(), self.origin_version.clone());
        if let Some(origin_actor) = &self.origin_actor {
            options = options.with_origin_actor(origin_actor.clone());
        }
        if let Some(id) = &self.agent_relay_distinct_id {
            options = options.with_agent_relay_distinct_id(id.clone());
        }
        HttpClient::new(options)
    }

    /// Make a request to the API.
    pub async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<impl Serialize>,
        query: Option<&[(&str, &str)]>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        let url = format!("{}{}", self.base_url, path);
        let options = options.unwrap_or_default();
        let last_attempt = RETRY_BACKOFFS_MS.len() - 1;

        for (attempt, backoff) in RETRY_BACKOFFS_MS.iter().enumerate() {
            let mut request = self.build_request(method.clone(), &url, &options);

            if let Some(ref q) = query {
                request = request.query(q);
            }

            if let Some(ref b) = body {
                request = request.json(b);
            }

            let response = request.send().await?;
            let status = response.status().as_u16();
            let attempts = (attempt + 1) as u32;

            // Retry on 5xx errors, but never after the final attempt: there is
            // nothing left to wait for, and the caller needs this response's
            // real diagnostic instead of a swallowed "max retries exceeded".
            if should_retry_server_error(&method, &options, status, attempt, last_attempt) {
                let delay_ms = retry_delay_ms(response.headers(), *backoff);
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                continue;
            }

            let request_id = extract_request_id(response.headers());

            // Handle 204 No Content
            if status == 204 {
                // Return default value for T (works for () and Option<T>)
                let empty_json = serde_json::from_str("null")?;
                return Ok(empty_json);
            }

            let bytes = response.bytes().await?;
            let json: ApiResponse<T> = match serde_json::from_slice(&bytes) {
                Ok(json) => json,
                Err(err) => {
                    // A non-JSON body from an error status (e.g. a gateway's
                    // plain-text 502/503/504) still carries a real status; do
                    // not let a body-parse failure erase it.
                    if (400..=599).contains(&status) {
                        return Err(RelayError::Api {
                            code: "invalid_response_body".to_string(),
                            message: format!(
                                "Server returned a non-JSON {status} response: {err}; body: {}",
                                error_body_summary(&bytes)
                            ),
                            status,
                            request_id,
                            attempts,
                        });
                    }
                    return Err(err.into());
                }
            };

            if !json.ok {
                let error = json.error.unwrap_or_else(|| crate::types::ApiErrorInfo {
                    code: "unknown_error".to_string(),
                    message: "Unknown error".to_string(),
                });
                return Err(RelayError::Api {
                    code: error.code,
                    message: error.message,
                    status,
                    request_id,
                    attempts,
                });
            }

            return json.data.ok_or_else(|| {
                RelayError::InvalidResponse("Response missing data field".to_string())
            });
        }

        unreachable!("the retry loop always returns on its final attempt")
    }

    fn build_request(&self, method: Method, url: &str, options: &RequestOptions) -> RequestBuilder {
        let mut request = self
            .client
            .request(method, url)
            .bearer_auth(&self.api_key)
            .header("X-SDK-Version", SDK_VERSION)
            .header("X-Relaycast-Origin-Client", &self.origin_client)
            .header("X-Relaycast-Origin-Version", &self.origin_version);

        if let Some(ref origin_actor) = self.origin_actor {
            request = request.header(ORIGIN_ACTOR_HEADER, origin_actor);
        }
        if let Some(ref id) = self.agent_relay_distinct_id {
            request = request.header(AGENT_RELAY_DISTINCT_ID_HEADER, id);
        }

        if let Some(ref key) = options.idempotency_key {
            request = request.header("Idempotency-Key", key);
        }

        if let Some(ref headers) = options.headers {
            for (name, value) in headers {
                request = request.header(name.as_str(), value.as_str());
            }
        }

        request
    }

    /// Make a GET request.
    pub async fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        query: Option<&[(&str, &str)]>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        self.request::<T>(Method::GET, path, None::<()>, query, options)
            .await
    }

    /// Make a POST request.
    pub async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<impl Serialize>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        self.request(Method::POST, path, body, None, options).await
    }

    /// Make a PATCH request.
    pub async fn patch<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<impl Serialize>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        self.request(Method::PATCH, path, body, None, options).await
    }

    /// Make a PUT request.
    pub async fn put<T: DeserializeOwned>(
        &self,
        path: &str,
        body: Option<impl Serialize>,
        options: Option<RequestOptions>,
    ) -> Result<T> {
        self.request(Method::PUT, path, body, None, options).await
    }

    /// Make a DELETE request.
    pub async fn delete(&self, path: &str, options: Option<RequestOptions>) -> Result<()> {
        self.request::<()>(Method::DELETE, path, None::<()>, None, options)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::{
        error_body_summary, extract_request_id, parse_retry_after_ms, retry_delay_ms,
        should_retry_server_error, RequestOptions, MAX_RETRY_AFTER_MS,
    };
    use reqwest::header::{HeaderMap, HeaderValue};
    use reqwest::Method;

    #[test]
    fn retry_after_is_bounded_without_a_wall_clock_wait() {
        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("3600"));
        assert_eq!(parse_retry_after_ms(&headers), Some(MAX_RETRY_AFTER_MS));

        headers.insert("retry-after", HeaderValue::from_static("0"));
        assert_eq!(retry_delay_ms(&headers, 200), 0);

        assert!(should_retry_server_error(
            &Method::GET,
            &RequestOptions::default(),
            503,
            1,
            2
        ));
        assert!(!should_retry_server_error(
            &Method::GET,
            &RequestOptions::default(),
            503,
            2,
            2
        ));
        assert!(!should_retry_server_error(
            &Method::POST,
            &RequestOptions::default(),
            503,
            0,
            2
        ));
        assert!(should_retry_server_error(
            &Method::POST,
            &RequestOptions::with_idempotency_key("retry-374"),
            503,
            0,
            2
        ));
    }

    #[test]
    fn response_metadata_is_trimmed_bounded_and_single_line() {
        let mut headers = HeaderMap::new();
        headers.insert("x-request-id", HeaderValue::from_static("  request-374  "));
        assert_eq!(extract_request_id(&headers).as_deref(), Some("request-374"));
        headers.remove("x-request-id");
        headers.insert(
            "x-correlation-id",
            HeaderValue::from_static(" correlation-374 "),
        );
        assert_eq!(
            extract_request_id(&headers).as_deref(),
            Some("correlation-374")
        );

        let summary = error_body_summary("gateway marker-374\nnext\u{2028}line\u{2029}".as_bytes());
        assert_eq!(summary, "gateway marker-374 next line");
    }
}
