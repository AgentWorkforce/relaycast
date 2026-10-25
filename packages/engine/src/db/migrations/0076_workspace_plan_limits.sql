-- Per-workspace registration-cap overrides pushed by the hosting control plane
-- (JSON: devices, agents, humans, session_retention_days; null = unlimited).
-- The entitlements provider applies these over the plan table, so a billing
-- system can change a workspace's caps without a new engine release. NULL
-- means the plan table alone decides.
ALTER TABLE workspaces ADD COLUMN plan_limits TEXT;
