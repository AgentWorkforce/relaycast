-- Host-owned per-workspace limit overrides (JSON). The hosting control plane
-- stores whatever its entitlements provider needs to derive this workspace's
-- limits; the engine never reads the value itself. NULL means the host's
-- defaults alone decide.
ALTER TABLE workspaces ADD COLUMN limit_overrides TEXT;
