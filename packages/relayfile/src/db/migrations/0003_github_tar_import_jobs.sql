CREATE TABLE IF NOT EXISTS github_tar_import_jobs (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT 'HEAD',
  head_sha TEXT NOT NULL,
  tarball_url TEXT NOT NULL DEFAULT '',
  archive_ref TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  next_entry_index INTEGER NOT NULL DEFAULT 0 CHECK (next_entry_index >= 0),
  imported INTEGER NOT NULL DEFAULT 0 CHECK (imported >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  errors_json TEXT NOT NULL DEFAULT '[]',
  skipped_json TEXT NOT NULL DEFAULT '[]',
  bytes_written INTEGER NOT NULL DEFAULT 0 CHECK (bytes_written >= 0),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_github_tar_import_jobs_workspace_created_at
  ON github_tar_import_jobs (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_github_tar_import_jobs_status_updated_at
  ON github_tar_import_jobs (status, updated_at DESC);
