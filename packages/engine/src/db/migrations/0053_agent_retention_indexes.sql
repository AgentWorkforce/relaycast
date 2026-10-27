-- Physical agent reclamation must not scan unrelated retained history for each
-- identity, including implicit foreign-key probes on DELETE. No data changes.
CREATE INDEX IF NOT EXISTS idx_messages_agent ON messages(agent_id);
CREATE INDEX IF NOT EXISTS idx_channels_creator ON channels(created_by);
CREATE INDEX IF NOT EXISTS idx_webhooks_creator ON webhooks(created_by);
CREATE INDEX IF NOT EXISTS idx_reactions_agent ON reactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_directory_ratings_rater ON directory_ratings(rater_agent_id);
CREATE INDEX IF NOT EXISTS idx_routing_failures_agent ON routing_failures(agent_id);
