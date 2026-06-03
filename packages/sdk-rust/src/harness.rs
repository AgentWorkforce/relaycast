//! Harness identifier handling.
//!
//! A harness is a User-Agent-style identifier for the process driving requests
//! (e.g. `claude-code/2.3 (model=opus-4.8; fast)`, `codex`, `human`). When set,
//! it is sent as the `X-Relaycast-Harness` HTTP header and the `harness` WS query
//! param so server-side telemetry can attribute traffic. Mirrors the contract in
//! `@relaycast/sdk` and `@relaycast/engine`.

/// HTTP header used to tell the relaycast server which harness drives a request.
pub const HARNESS_HEADER: &str = "X-Relaycast-Harness";
/// HTTP header used to forward Agent Relay's anonymous installation id.
pub const AGENT_RELAY_ANONYMOUS_ID_HEADER: &str = "X-Agent-Relay-Anonymous-Id";
/// WebSocket query param used to forward Agent Relay's anonymous installation id.
pub const AGENT_RELAY_ANONYMOUS_ID_QUERY: &str = "agent_relay_anonymous_id";

/// Upper bound on the harness value — generous enough for a UA-style token.
const HARNESS_MAX_LENGTH: usize = 120;
const AGENT_RELAY_ANONYMOUS_ID_MAX_LENGTH: usize = 128;

/// Characters permitted in a harness identifier. Deliberately broad enough for a
/// User-Agent-style token (`name/version (model=...; setting)`) while excluding
/// CR/LF and other control characters.
fn is_allowed(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            ' ' | '.' | '_' | '-' | '/' | '(' | ')' | ':' | '=' | ';' | ',' | '+'
        )
}

fn is_allowed_agent_relay_anonymous_id(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-')
}

/// Normalize a caller-supplied harness identifier to the wire contract.
///
/// Returns a trimmed, lowercased, length-capped token, or `None` when the input
/// is empty or contains disallowed characters — in which case callers omit the
/// header/param entirely rather than sending garbage the server would reject.
pub fn sanitize_harness(raw: Option<impl AsRef<str>>) -> Option<String> {
    let raw = raw?;
    let trimmed = raw.as_ref().trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.chars().all(is_allowed) {
        return None;
    }
    Some(
        trimmed
            .chars()
            .take(HARNESS_MAX_LENGTH)
            .collect::<String>()
            .to_lowercase(),
    )
}

/// Normalize an Agent Relay anonymous installation id to the wire contract.
///
/// Returns a trimmed, length-capped id, or `None` when the input is empty or
/// contains disallowed characters. Unlike harness values, this preserves case
/// because the id is an opaque token.
pub fn sanitize_agent_relay_anonymous_id(raw: Option<impl AsRef<str>>) -> Option<String> {
    let raw = raw?;
    let trimmed = raw.as_ref().trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.chars().all(is_allowed_agent_relay_anonymous_id) {
        return None;
    }
    Some(
        trimmed
            .chars()
            .take(AGENT_RELAY_ANONYMOUS_ID_MAX_LENGTH)
            .collect::<String>(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_ua_style_token_lowercased() {
        assert_eq!(
            sanitize_harness(Some("Claude-Code/2.3 (model=Opus-4.8; fast)")),
            Some("claude-code/2.3 (model=opus-4.8; fast)".to_string())
        );
    }

    #[test]
    fn trims_surrounding_whitespace() {
        assert_eq!(
            sanitize_harness(Some("  codex  ")),
            Some("codex".to_string())
        );
    }

    #[test]
    fn drops_empty_and_none() {
        assert_eq!(sanitize_harness(Some("")), None);
        assert_eq!(sanitize_harness(Some("   ")), None);
        assert_eq!(sanitize_harness(None::<&str>), None);
    }

    #[test]
    fn drops_crlf_and_control_characters() {
        assert_eq!(sanitize_harness(Some("evil\r\nX-Inject: bad")), None);
        assert_eq!(sanitize_harness(Some("a\tb")), None);
    }

    #[test]
    fn caps_at_120_characters() {
        let long = "a".repeat(200);
        assert_eq!(sanitize_harness(Some(&long)), Some("a".repeat(120)));
    }

    #[test]
    fn keeps_agent_relay_anonymous_id_without_lowercasing() {
        assert_eq!(
            sanitize_agent_relay_anonymous_id(Some("  AgentRelay.abc_123:XYZ-9  ")),
            Some("AgentRelay.abc_123:XYZ-9".to_string())
        );
    }

    #[test]
    fn drops_invalid_agent_relay_anonymous_ids() {
        assert_eq!(sanitize_agent_relay_anonymous_id(Some("")), None);
        assert_eq!(sanitize_agent_relay_anonymous_id(Some("   ")), None);
        assert_eq!(
            sanitize_agent_relay_anonymous_id(Some("evil\r\nX-Inject: bad")),
            None
        );
        assert_eq!(sanitize_agent_relay_anonymous_id(Some("a/b")), None);
    }

    #[test]
    fn caps_agent_relay_anonymous_id_at_128_characters() {
        let long = "a".repeat(200);
        assert_eq!(
            sanitize_agent_relay_anonymous_id(Some(&long)),
            Some("a".repeat(128))
        );
    }
}
