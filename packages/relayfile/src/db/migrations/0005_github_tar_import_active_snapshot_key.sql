UPDATE github_tar_import_jobs
SET
  status = 'failed',
  last_error = 'canonicalized by 0005 migration (duplicate active snapshot key)',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status IN ('queued', 'fetching', 'importing')
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM github_tar_import_jobs
    WHERE status IN ('queued', 'fetching', 'importing')
    GROUP BY workspace_id, owner, repo, head_sha
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_github_tar_import_jobs_active_snapshot_key
  ON github_tar_import_jobs (workspace_id, owner, repo, head_sha)
  WHERE status IN ('queued', 'fetching', 'importing');
