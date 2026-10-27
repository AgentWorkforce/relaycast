-- Spawn reservation tracking and node retry state.
ALTER TABLE nodes ADD COLUMN reserved_agents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE action_invocations ADD COLUMN attempted_node_ids TEXT NOT NULL DEFAULT '[]';
ALTER TABLE action_invocations ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE action_invocations ADD COLUMN retry_after_at INTEGER DEFAULT NULL;
