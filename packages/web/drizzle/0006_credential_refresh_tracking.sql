ALTER TABLE cloud_agents ADD COLUMN IF NOT EXISTS refresh_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cloud_agents ADD COLUMN IF NOT EXISTS refresh_exhausted BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cloud_agents ADD COLUMN IF NOT EXISTS last_refresh_attempt_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_cloud_agents_refresh_sweep
  ON cloud_agents(credential_expires_at, refresh_exhausted)
  WHERE credential_expires_at IS NOT NULL AND refresh_exhausted = FALSE;
