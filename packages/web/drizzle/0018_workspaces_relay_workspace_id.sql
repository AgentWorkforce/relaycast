ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS relay_workspace_id TEXT;
CREATE INDEX IF NOT EXISTS idx_workspaces_relay_workspace_id ON workspaces (relay_workspace_id);
