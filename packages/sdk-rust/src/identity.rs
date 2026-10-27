//! Identity helpers shared by RelayCast clients.

/// Case-insensitive comparison for agent names.
///
/// Agent names can arrive from registration responses, WebSocket events, and
/// API responses with inconsistent casing. Centralizing the comparison keeps
/// routing code from rolling its own matching rules.
pub fn agent_name_eq(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Check whether any known local/self names match `name`.
pub fn is_self_name<'a, I, S>(self_names: I, name: &str) -> bool
where
    I: IntoIterator<Item = &'a S>,
    S: AsRef<str> + 'a,
{
    self_names
        .into_iter()
        .any(|candidate| agent_name_eq(candidate.as_ref(), name))
}

#[cfg(test)]
mod tests {
    use super::{agent_name_eq, is_self_name};

    #[test]
    fn agent_name_eq_is_case_insensitive() {
        assert!(agent_name_eq("Alice", "alice"));
        assert!(agent_name_eq("worker-1", "WORKER-1"));
        assert!(!agent_name_eq("Alice", "Bob"));
    }

    #[test]
    fn is_self_name_checks_all_candidates() {
        let names = vec!["Lead".to_string(), "worker-a".to_string()];

        assert!(is_self_name(&names, "lead"));
        assert!(is_self_name(&names, "WORKER-A"));
        assert!(!is_self_name(&names, "reviewer"));
    }
}
