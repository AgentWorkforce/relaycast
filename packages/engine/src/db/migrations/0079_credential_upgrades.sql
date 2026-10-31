-- Legacy credentials replaced through POST /v1/credentials/upgrade. The
-- principal's own hash column holds the ar_ credential; the legacy one keeps
-- working until expires_at, and only while the principal still holds the ar_
-- credential it was upgraded to.
CREATE TABLE credential_upgrades (
  legacy_hash TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  ar_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_credential_upgrades_workspace ON credential_upgrades(workspace_id);
