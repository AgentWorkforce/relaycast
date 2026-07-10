ALTER TABLE cloud_agents ADD COLUMN IF NOT EXISTS credential_expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_cloud_agents_expires_at ON cloud_agents(credential_expires_at) WHERE credential_expires_at IS NOT NULL;
