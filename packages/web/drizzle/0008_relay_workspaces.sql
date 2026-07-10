CREATE TABLE IF NOT EXISTS relay_workspaces (
  id TEXT PRIMARY KEY,
  owner_user_id UUID NOT NULL,
  name TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_relay_workspaces_owner
  ON relay_workspaces (owner_user_id);
