-- Per-recipient inbound policy: who may address an agent. Keyed by agent id,
-- never name, so a released name re-registered by someone else cannot inherit
-- or bypass a policy. A missing row means open (the pre-policy behavior).
-- allowed_agent_ids is the agent's own list, which its token may only narrow;
-- pinned_agent_ids is set with the workspace key (owner, admins) and the
-- agent cannot remove it.
CREATE TABLE agent_inbound_policies (
  agent_id TEXT PRIMARY KEY NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('open', 'allowlist')),
  allowed_agent_ids TEXT NOT NULL DEFAULT '[]',
  pinned_agent_ids TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Conversation checks load every participant's policy in one workspace query.
CREATE INDEX idx_agent_inbound_policies_workspace
  ON agent_inbound_policies(workspace_id);
