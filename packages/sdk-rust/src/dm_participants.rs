//! Cached resolution for workspace DM conversation participants.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use crate::{RelayCast, Result};

/// Default successful participant lookup TTL.
pub const DM_PARTICIPANT_CACHE_TTL: Duration = Duration::from_secs(30);
/// Default failed participant lookup TTL.
pub const DM_PARTICIPANT_FAILURE_TTL: Duration = Duration::from_secs(5);
const DEFAULT_MAX_DM_CACHE_ENTRIES: usize = 8192;

/// A cached DM participant lookup entry.
#[derive(Debug, Clone)]
pub enum DmParticipantsCacheEntry {
    Success {
        fetched_at: Instant,
        participants: Vec<String>,
    },
    Failure {
        failed_at: Instant,
    },
}

impl DmParticipantsCacheEntry {
    fn timestamp(&self) -> Instant {
        match self {
            Self::Success { fetched_at, .. } => *fetched_at,
            Self::Failure { failed_at } => *failed_at,
        }
    }
}

/// Small bounded cache for resolving workspace DM conversation participants.
#[derive(Debug, Clone)]
pub struct DmParticipantsCache {
    entries: HashMap<String, DmParticipantsCacheEntry>,
    success_ttl: Duration,
    failure_ttl: Duration,
    max_entries: usize,
}

impl Default for DmParticipantsCache {
    fn default() -> Self {
        Self::new()
    }
}

impl DmParticipantsCache {
    /// Create a cache with the default TTLs and entry limit.
    pub fn new() -> Self {
        Self::with_options(
            DM_PARTICIPANT_CACHE_TTL,
            DM_PARTICIPANT_FAILURE_TTL,
            DEFAULT_MAX_DM_CACHE_ENTRIES,
        )
    }

    /// Create a cache with explicit TTLs and entry limit.
    pub fn with_options(success_ttl: Duration, failure_ttl: Duration, max_entries: usize) -> Self {
        Self {
            entries: HashMap::new(),
            success_ttl,
            failure_ttl,
            max_entries,
        }
    }

    /// Number of cached entries.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the cache is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Clear all cached entries.
    pub fn clear(&mut self) {
        self.entries.clear();
    }

    /// Resolve participants, returning cached successes and suppressing only
    /// recently cached failures.
    pub async fn resolve(
        &mut self,
        relay: &RelayCast,
        workspace_id: &str,
        conversation_id: &str,
    ) -> Result<Vec<String>> {
        let workspace_id = workspace_id.trim();
        let conversation_id = conversation_id.trim();
        if conversation_id.is_empty() {
            return Ok(vec![]);
        }

        let cache_key = format!("{workspace_id}:{conversation_id}");
        if let Some(entry) = self.entries.get(&cache_key) {
            match entry {
                DmParticipantsCacheEntry::Success {
                    fetched_at,
                    participants,
                } if fetched_at.elapsed() < self.success_ttl => {
                    return Ok(participants.clone());
                }
                DmParticipantsCacheEntry::Failure { failed_at }
                    if failed_at.elapsed() < self.failure_ttl =>
                {
                    return Ok(vec![]);
                }
                _ => {}
            }
        }

        match relay.dm_conversation_participants(conversation_id).await {
            Ok(participants) => {
                self.insert(
                    cache_key,
                    DmParticipantsCacheEntry::Success {
                        fetched_at: Instant::now(),
                        participants: participants.clone(),
                    },
                );
                Ok(participants)
            }
            Err(error) => {
                self.insert(
                    cache_key,
                    DmParticipantsCacheEntry::Failure {
                        failed_at: Instant::now(),
                    },
                );
                Err(error)
            }
        }
    }

    /// Resolve participants and convert lookup errors into an empty list.
    pub async fn resolve_or_empty(
        &mut self,
        relay: &RelayCast,
        workspace_id: &str,
        conversation_id: &str,
    ) -> Vec<String> {
        match self.resolve(relay, workspace_id, conversation_id).await {
            Ok(participants) => participants,
            Err(error) => {
                tracing::warn!(
                    workspace_id = %workspace_id,
                    conversation_id = %conversation_id,
                    error = %error,
                    "failed resolving DM participants"
                );
                vec![]
            }
        }
    }

    fn insert(&mut self, cache_key: String, entry: DmParticipantsCacheEntry) {
        if self.max_entries == 0 {
            return;
        }

        if !self.entries.contains_key(&cache_key) && self.entries.len() >= self.max_entries {
            if let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.timestamp())
                .map(|(key, _)| key.clone())
            {
                self.entries.remove(&oldest_key);
            }
        }

        self.entries.insert(cache_key, entry);
    }
}

#[cfg(test)]
mod tests {
    use super::{DmParticipantsCache, DmParticipantsCacheEntry};
    use std::time::{Duration, Instant};

    #[test]
    fn cache_entry_timestamp_tracks_entry_kind() {
        let now = Instant::now();
        let success = DmParticipantsCacheEntry::Success {
            fetched_at: now,
            participants: vec!["alice".to_string()],
        };
        let failure = DmParticipantsCacheEntry::Failure { failed_at: now };

        assert_eq!(success.timestamp(), now);
        assert_eq!(failure.timestamp(), now);
    }

    #[test]
    fn cache_zero_capacity_drops_entries() {
        let mut cache =
            DmParticipantsCache::with_options(Duration::from_secs(1), Duration::from_secs(1), 0);

        cache.insert(
            "workspace:dm_1".to_string(),
            DmParticipantsCacheEntry::Failure {
                failed_at: Instant::now(),
            },
        );

        assert!(cache.is_empty());
    }

    #[test]
    fn cache_evicts_oldest_entry_at_capacity() {
        let mut cache =
            DmParticipantsCache::with_options(Duration::from_secs(1), Duration::from_secs(1), 1);

        cache.insert(
            "workspace:dm_1".to_string(),
            DmParticipantsCacheEntry::Success {
                fetched_at: Instant::now() - Duration::from_secs(2),
                participants: vec!["alice".to_string()],
            },
        );
        cache.insert(
            "workspace:dm_2".to_string(),
            DmParticipantsCacheEntry::Success {
                fetched_at: Instant::now(),
                participants: vec!["bob".to_string()],
            },
        );

        assert_eq!(cache.len(), 1);
        assert!(cache.entries.contains_key("workspace:dm_2"));
    }
}
