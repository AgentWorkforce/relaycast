CREATE TABLE IF NOT EXISTS github_base_snapshots (
  workspace_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  content_root TEXT NOT NULL,
  manifest_ref TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  current INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, owner, repo, head_sha)
);

CREATE INDEX IF NOT EXISTS idx_github_base_snapshots_current
  ON github_base_snapshots (workspace_id, owner, repo, current);
