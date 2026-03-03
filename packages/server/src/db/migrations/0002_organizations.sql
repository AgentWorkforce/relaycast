-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Create organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',
  org_api_key_hash TEXT UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Create org_memberships table
CREATE TABLE IF NOT EXISTS org_memberships (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_org_memberships_org ON org_memberships(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_memberships_user ON org_memberships(user_id);

-- Create sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  active_org_id TEXT REFERENCES organizations(id),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Create email_verifications table
CREATE TABLE IF NOT EXISTS email_verifications (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications(user_id);

-- Add new columns to workspaces
ALTER TABLE workspaces ADD COLUMN organization_id TEXT REFERENCES organizations(id);
ALTER TABLE workspaces ADD COLUMN last_activity_at INTEGER;
ALTER TABLE workspaces ADD COLUMN deleted_at INTEGER;

-- Backfill: create a shadow org for each existing workspace and link them.
-- Uses the workspace id as the org id for simplicity in a one-time migration.
INSERT INTO organizations (id, name, created_at)
SELECT id, 'shadow-' || name, created_at FROM workspaces WHERE organization_id IS NULL;

UPDATE workspaces SET organization_id = id WHERE organization_id IS NULL;
