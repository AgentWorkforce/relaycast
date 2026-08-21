//! Agent registration helpers with token caching, cooldown handling, and retries.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use thiserror::Error;

use crate::error::RelayError;
use crate::{AgentClient, CreateAgentRequest, RelayCast};

const DEFAULT_REGISTRATION_COOLDOWN_SECS: u64 = 60;

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn normalize_cli(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }

    let candidate = trimmed
        .split_whitespace()
        .next()
        .unwrap_or(trimmed)
        .to_string();

    let executable = Path::new(&candidate)
        .file_name()
        .and_then(|part| part.to_str())
        .unwrap_or(candidate.as_str());

    let cli = executable
        .split(':')
        .next()
        .unwrap_or(executable)
        .trim()
        .to_ascii_lowercase();

    let normalized = match cli.as_str() {
        "claude" | "claudecode" | "claude-code" | "claude_code" => "claude",
        "codex" => "codex",
        "gemini" => "gemini",
        "aider" => "aider",
        "goose" => "goose",
        _ => return None,
    };

    Some(normalized.to_string())
}

fn registration_cli_from_hint(cli_hint: Option<&str>, default_cli: &str) -> String {
    cli_hint
        .and_then(normalize_cli)
        .or_else(|| normalize_cli(default_cli))
        .unwrap_or_else(|| "claude".to_string())
}

/// Errors emitted by [`AgentRegistrationClient`].
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum AgentRegistrationError {
    #[error("invalid agent name for registration")]
    InvalidAgentName,
    #[error(
        "registration for '{agent_name}' is blocked for {retry_after_secs}s due to previous rate limiting"
    )]
    Blocked {
        agent_name: String,
        retry_after_secs: u64,
    },
    #[error(
        "registration for '{agent_name}' was rate-limited; retry after {retry_after_secs}s: {detail}"
    )]
    RateLimited {
        agent_name: String,
        retry_after_secs: u64,
        detail: String,
    },
    #[error("registration failed for '{agent_name}' ({status}): {detail}")]
    Api {
        agent_name: String,
        status: u16,
        detail: String,
    },
    #[error("registration transport error for '{agent_name}': {detail}")]
    Transport { agent_name: String, detail: String },
    #[error("registration response missing token for '{agent_name}'")]
    MissingToken { agent_name: String },
    /// The name is taken and registration is create-only.
    ///
    /// Since engine 8.2.0 (#349) registration never replaces an existing
    /// identity. Replacing one is an explicit, audited operation: `recover`
    /// with a recovery proof, or `takeover` as the workspace owner. Callers
    /// that just need their own agent should use a name unique to the run.
    #[error(
        "agent '{agent_name}' already exists and registration is create-only; \
         use recover (with a recovery proof) or takeover (workspace owner, audited) \
         to replace an existing identity, or register under a unique name"
    )]
    AlreadyExists { agent_name: String },
}

/// Retries exhausted or fatal outcome for [`retry_agent_registration`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentRegistrationRetryOutcome {
    /// All retries exhausted for a retryable error.
    RetryableExhausted(AgentRegistrationError),
    /// Non-retryable error.
    Fatal(AgentRegistrationError),
}

/// Registers agents via RelayCast spawn endpoint and caches bearer tokens.
#[derive(Clone)]
pub struct AgentRegistrationClient {
    relay: RelayCast,
    default_cli: String,
    agent_tokens: Arc<Mutex<HashMap<String, String>>>,
    registration_cooldowns: Arc<Mutex<HashMap<String, Instant>>>,
}

impl AgentRegistrationClient {
    /// Create a new registration client.
    pub fn new(relay: RelayCast, default_cli: impl Into<String>) -> Self {
        Self {
            relay,
            default_cli: default_cli.into(),
            agent_tokens: Arc::new(Mutex::new(HashMap::new())),
            registration_cooldowns: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Pre-populate the token cache for an agent.
    pub fn seed_agent_token(&self, agent_name: &str, token: &str) {
        lock_unpoisoned(&self.agent_tokens).insert(agent_name.to_string(), token.to_string());
    }

    /// Read an agent token from cache, if present.
    pub fn cached_agent_token(&self, agent_name: &str) -> Option<String> {
        lock_unpoisoned(&self.agent_tokens).get(agent_name).cloned()
    }

    /// Return remaining block duration for a rate-limited agent registration.
    pub fn registration_block_remaining(&self, agent_name: &str) -> Option<Duration> {
        let trimmed = agent_name.trim();
        if trimmed.is_empty() {
            return None;
        }

        let mut guard = lock_unpoisoned(&self.registration_cooldowns);
        let blocked_until = guard.get(trimmed).copied()?;
        let now = Instant::now();
        if blocked_until <= now {
            guard.remove(trimmed);
            return None;
        }
        Some(blocked_until - now)
    }

    /// Remove cached token and cooldown state for an agent.
    pub fn invalidate_cached_registration(&self, agent_name: &str) {
        let trimmed = agent_name.trim();
        if trimmed.is_empty() {
            return;
        }
        lock_unpoisoned(&self.agent_tokens).remove(trimmed);
        lock_unpoisoned(&self.registration_cooldowns).remove(trimmed);
    }

    /// Register a **new** agent and return its token.
    ///
    /// Registration is create-only as of engine 8.2.0 (#349): a name already
    /// held by another identity yields
    /// [`AgentRegistrationError::AlreadyExists`], and this method will not
    /// silently replace it. Note the cache is per-client and in memory, so a
    /// restarted process registering the same stable name hits that error
    /// rather than reusing the previous token.
    ///
    /// Pick one of:
    ///
    /// - **a name unique per run** (simplest, and the intended model for
    ///   ephemeral agents),
    /// - **persist the agent token** and roll it over yourself with
    ///   [`RelayCast::rotate_agent_token`],
    /// - **take the identity over explicitly** with
    ///   [`RelayCast::take_over_agent`] or [`RelayCast::recover_agent`], which
    ///   are audited operations requiring an expected agent id and a reason.
    pub async fn register_agent_token(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
    ) -> std::result::Result<String, AgentRegistrationError> {
        let trimmed_name = agent_name.trim();
        if trimmed_name.is_empty() {
            return Err(AgentRegistrationError::InvalidAgentName);
        }

        if let Some(token) = self.cached_agent_token(trimmed_name) {
            return Ok(token);
        }

        if let Some(remaining) = self.registration_block_remaining(trimmed_name) {
            return Err(AgentRegistrationError::Blocked {
                agent_name: trimmed_name.to_string(),
                retry_after_secs: remaining.as_secs().max(1),
            });
        }

        let mut metadata = serde_json::Map::new();
        metadata.insert(
            "cli".to_string(),
            serde_json::Value::String(registration_cli_from_hint(cli_hint, &self.default_cli)),
        );
        let request = CreateAgentRequest {
            name: trimmed_name.to_string(),
            agent_type: Some("agent".to_string()),
            persona: None,
            metadata: Some(metadata),
        };

        match self.relay.register_agent(request).await {
            Ok(result) => {
                if result.token.trim().is_empty() {
                    return Err(AgentRegistrationError::MissingToken {
                        agent_name: trimmed_name.to_string(),
                    });
                }
                lock_unpoisoned(&self.agent_tokens)
                    .insert(trimmed_name.to_string(), result.token.clone());
                lock_unpoisoned(&self.registration_cooldowns).remove(trimmed_name);
                Ok(result.token)
            }
            // Registration is create-only as of engine 8.2.0 (#349): a 409 means
            // the name is held by an existing identity, and replacing it is a
            // deliberate, audited act (`recover` with a proof, or `takeover` as
            // the workspace owner) rather than something a registration call
            // should do silently.
            //
            // This branch used to fall back to `rotate_agent_token` with the
            // workspace key. That route became `requireAgentToken` in the same
            // release, so the fallback could only ever return
            // `401 Agent token required (at_live_...)` — a misleading auth error
            // for what is really "this name is taken". Report the real condition.
            Err(RelayError::Api { status: 409, .. }) => {
                Err(AgentRegistrationError::AlreadyExists {
                    agent_name: trimmed_name.to_string(),
                })
            }
            Err(RelayError::Api {
                status: 429,
                message,
                code,
            }) => {
                let retry_after_secs = DEFAULT_REGISTRATION_COOLDOWN_SECS;
                let blocked_until = Instant::now() + Duration::from_secs(retry_after_secs);
                lock_unpoisoned(&self.registration_cooldowns)
                    .insert(trimmed_name.to_string(), blocked_until);
                Err(AgentRegistrationError::RateLimited {
                    agent_name: trimmed_name.to_string(),
                    retry_after_secs,
                    detail: format!("{message} (code: {code})"),
                })
            }
            Err(RelayError::Api {
                status,
                message,
                code,
            }) => Err(AgentRegistrationError::Api {
                agent_name: trimmed_name.to_string(),
                status,
                detail: format!("{message} (code: {code})"),
            }),
            Err(error) => Err(AgentRegistrationError::Transport {
                agent_name: trimmed_name.to_string(),
                detail: error.to_string(),
            }),
        }
    }

    /// Register an agent token if needed and return an [`AgentClient`] using it.
    pub async fn registered_agent_client(
        &self,
        agent_name: &str,
        cli_hint: Option<&str>,
    ) -> std::result::Result<AgentClient, AgentRegistrationError> {
        let trimmed_name = agent_name.trim();
        let token = self.register_agent_token(trimmed_name, cli_hint).await?;
        self.relay
            .as_agent(token)
            .map_err(|error| AgentRegistrationError::Transport {
                agent_name: trimmed_name.to_string(),
                detail: error.to_string(),
            })
    }
}

/// Return retry delay seconds for rate-limited registration errors.
pub fn registration_retry_after_secs(error: &AgentRegistrationError) -> Option<u64> {
    match error {
        AgentRegistrationError::Blocked {
            retry_after_secs, ..
        } => Some(*retry_after_secs),
        AgentRegistrationError::RateLimited {
            retry_after_secs, ..
        } => Some(*retry_after_secs),
        _ => None,
    }
}

/// Return whether registration errors are transient and safe to retry.
pub fn registration_is_retryable(error: &AgentRegistrationError) -> bool {
    matches!(
        error,
        AgentRegistrationError::Blocked { .. }
            | AgentRegistrationError::RateLimited { .. }
            | AgentRegistrationError::Transport { .. }
    )
}

/// Format a human-readable registration error message.
pub fn format_registration_error(agent_name: &str, error: &AgentRegistrationError) -> String {
    let mut message = format!("failed to register agent '{}': {}", agent_name, error);
    if let Some(retry_after_secs) = registration_retry_after_secs(error) {
        if !message.to_ascii_lowercase().contains("retry after") {
            message.push_str(&format!(" (retry after {}s)", retry_after_secs));
        }
    }
    message
}

/// Attempt registration with bounded retries for transient errors.
pub async fn retry_agent_registration(
    client: &AgentRegistrationClient,
    agent_name: &str,
    cli_hint: Option<&str>,
) -> std::result::Result<String, AgentRegistrationRetryOutcome> {
    const MAX_ATTEMPTS: u32 = 3;
    for attempt in 0..MAX_ATTEMPTS {
        match client.register_agent_token(agent_name, cli_hint).await {
            Ok(token) => return Ok(token),
            Err(error) if registration_is_retryable(&error) && attempt < MAX_ATTEMPTS - 1 => {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(error) if registration_is_retryable(&error) => {
                return Err(AgentRegistrationRetryOutcome::RetryableExhausted(error));
            }
            Err(error) => return Err(AgentRegistrationRetryOutcome::Fatal(error)),
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::{
        format_registration_error, normalize_cli, registration_cli_from_hint,
        registration_is_retryable, registration_retry_after_secs, AgentRegistrationClient,
        AgentRegistrationError,
    };
    use crate::{RelayCast, RelayCastOptions};
    use serde_json::json;
    use wiremock::matchers::{body_string_contains, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn ok(data: serde_json::Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(json!({ "ok": true, "data": data }))
    }

    #[test]
    fn normalize_cli_accepts_known_executables() {
        assert_eq!(normalize_cli("codex"), Some("codex".to_string()));
        assert_eq!(normalize_cli("node /tmp/claude-code.js"), None);
        assert_eq!(normalize_cli("python /tmp/unknown.py"), None);
    }

    #[test]
    fn registration_cli_falls_back_to_default() {
        assert_eq!(
            registration_cli_from_hint(Some("unknown"), "gemini"),
            "gemini"
        );
        assert_eq!(
            registration_cli_from_hint(None, "totally-unknown"),
            "claude"
        );
    }

    #[tokio::test]
    async fn register_agent_token_uses_cache_before_network() {
        let server = MockServer::start().await;
        let relay =
            RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
                .expect("relay init");
        let client = AgentRegistrationClient::new(relay, "claude");
        client.seed_agent_token("worker-a", "at_live_cached");

        let token = client
            .register_agent_token("worker-a", Some("codex"))
            .await
            .expect("cache hit should succeed");
        assert_eq!(token, "at_live_cached");
    }

    #[tokio::test]
    async fn registered_agent_client_uses_cached_token() {
        let server = MockServer::start().await;
        let relay =
            RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
                .expect("relay init");
        let client = AgentRegistrationClient::new(relay, "claude");
        client.seed_agent_token("worker-a", "at_live_cached");

        let agent = client
            .registered_agent_client("worker-a", Some("codex"))
            .await
            .expect("registered agent client should use cached token");

        assert_eq!(agent.http_client().api_key(), "at_live_cached");
        assert_eq!(agent.http_client().base_url(), server.uri());
    }

    #[tokio::test]
    async fn register_agent_token_parses_register_success() {
        let server = MockServer::start().await;
        let relay =
            RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
                .expect("relay init");
        let client = AgentRegistrationClient::new(relay, "claude");

        Mock::given(method("POST"))
            .and(path("/v1/agents"))
            .and(body_string_contains("\"name\":\"worker-b\""))
            .and(body_string_contains("\"cli\":\"codex\""))
            .respond_with(ok(json!({
                "id": "a_worker_b",
                "name": "worker-b",
                "token": "at_live_worker_b",
                "status": "online",
                "created_at": "2026-01-01T00:00:00.000Z"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let token = client
            .register_agent_token("worker-b", Some("codex"))
            .await
            .expect("spawn should succeed");
        assert_eq!(token, "at_live_worker_b");
    }

    #[tokio::test]
    async fn register_agent_token_reports_conflict_as_already_exists() {
        // Registration is create-only since engine 8.2.0 (#349). A 409 must be
        // reported as the conflict it is, not laundered through a rotate call
        // that can no longer authenticate.
        let server = MockServer::start().await;
        let relay =
            RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
                .expect("relay init");
        let client = AgentRegistrationClient::new(relay, "claude");

        Mock::given(method("POST"))
            .and(path("/v1/agents"))
            .respond_with(ResponseTemplate::new(409).set_body_json(json!({
                "ok": false,
                "error": {
                    "code": "agent_already_exists",
                    "message": "Agent \"worker-dupe\" already exists in this workspace"
                }
            })))
            .expect(1)
            .mount(&server)
            .await;

        // No rotate-token mock is registered on purpose: reaching that route
        // at all is the regression this test exists to catch.
        let error = client
            .register_agent_token("worker-dupe", Some("claude"))
            .await
            .expect_err("expected a conflict error");

        match error {
            AgentRegistrationError::AlreadyExists { agent_name } => {
                assert_eq!(agent_name, "worker-dupe");
            }
            other => panic!("expected AlreadyExists, got: {other:?}"),
        }
    }

    #[tokio::test]
    async fn already_exists_error_explains_the_supported_paths() {
        // The message is the whole point: the previous behaviour surfaced
        // "401 Agent token required (at_live_...)" for a name collision, which
        // sent three separate investigations after an auth bug that did not
        // exist.
        let message = AgentRegistrationError::AlreadyExists {
            agent_name: "writer".to_string(),
        }
        .to_string();

        assert!(message.contains("writer"), "names the agent: {message}");
        assert!(
            message.contains("create-only"),
            "states the policy: {message}"
        );
        assert!(message.contains("recover"), "points at recover: {message}");
        assert!(
            message.contains("takeover"),
            "points at takeover: {message}"
        );
        assert!(
            message.contains("unique name"),
            "offers the simple fix: {message}"
        );
    }

    #[tokio::test]
    async fn rotate_agent_token_authenticates_as_the_agent() {
        // Self-rollover: the route is `requireAgentToken` as of engine 8.2.0,
        // so the agent's own token must be sent, never the workspace key.
        let server = MockServer::start().await;
        let relay =
            RelayCast::new(RelayCastOptions::new("rk_live_workspace").with_base_url(server.uri()))
                .expect("relay init");

        Mock::given(method("POST"))
            // Built with `format!` so the SDK/OpenAPI route-sync test normalizes
            // this to `/v1/agents/{param}/rotate-token` rather than treating
            // `worker-self` as a literal route missing from openapi.yaml.
            .and(path(format!("/v1/agents/{}/rotate-token", "worker-self")))
            .and(header("authorization", "Bearer at_live_current"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "ok": true,
                "data": { "name": "worker-self", "token": "at_live_rolled" }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let rotated = relay
            .rotate_agent_token("worker-self", "at_live_current")
            .await
            .expect("self-rollover should succeed");
        assert_eq!(rotated.token, "at_live_rolled");
    }

    #[tokio::test]
    async fn register_agent_token_sets_cooldown_on_rate_limit() {
        let server = MockServer::start().await;
        let relay =
            RelayCast::new(RelayCastOptions::new("rk_live_test").with_base_url(server.uri()))
                .expect("relay init");
        let client = AgentRegistrationClient::new(relay, "claude");

        let rate_limited = ResponseTemplate::new(429).set_body_json(json!({
            "ok": false,
            "error": {
                "code": "rate_limited",
                "message": "too many requests"
            }
        }));

        Mock::given(method("POST"))
            .and(path("/v1/agents"))
            .respond_with(rate_limited)
            .expect(1)
            .mount(&server)
            .await;

        let error = client
            .register_agent_token("worker-c", None)
            .await
            .expect_err("expected rate-limited error");
        match error {
            AgentRegistrationError::RateLimited {
                retry_after_secs, ..
            } => assert_eq!(retry_after_secs, 60),
            other => panic!("unexpected error variant: {other:?}"),
        }

        assert!(client.registration_block_remaining("worker-c").is_some());
    }

    #[test]
    fn registration_retry_helpers_for_rate_limit() {
        let error = AgentRegistrationError::RateLimited {
            agent_name: "worker-d".to_string(),
            retry_after_secs: 25,
            detail: "429".to_string(),
        };
        assert!(registration_is_retryable(&error));
        assert_eq!(registration_retry_after_secs(&error), Some(25));
        let message = format_registration_error("worker-d", &error);
        assert!(message.contains("worker-d"));
        assert!(message.contains("retry after"));
    }
}
