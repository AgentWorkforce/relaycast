-- Per-device tokens of a person (type 'human') agent, beside agents.token_hash.
-- One live token per (agent, device); a message sent with one is stamped with
-- its device (__relaycast_sender_device). Additive only: a new table, no
-- backfill, and no existing token or agent row changes, so it is safe to
-- apply before the code that reads it deploys.

CREATE TABLE agent_device_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  device_kind TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX agent_device_tokens_agent_device_unique
  ON agent_device_tokens(workspace_id, agent_id, device_id);
CREATE UNIQUE INDEX agent_device_tokens_token_hash_unique
  ON agent_device_tokens(token_hash);
