ALTER TABLE relay_workspaces
  ADD COLUMN IF NOT EXISTS relaycast_api_key TEXT NOT NULL DEFAULT '';

ALTER TABLE workflow_runs
  ADD COLUMN IF NOT EXISTS relay_workspace_id TEXT;
