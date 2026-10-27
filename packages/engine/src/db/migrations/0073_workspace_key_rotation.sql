-- Workspace-key rotation mirrors the agent-token handoff: the superseded key
-- is captured into a previous slot so a caller that lost a concurrent
-- rotation race, or a peer mid-propagation, stays authenticatable for a
-- bounded grace window. A rotation with grace_seconds = 0 writes no usable
-- previous slot, so a compromised credential is never kept alive.
ALTER TABLE workspaces ADD COLUMN previous_api_key_hash TEXT;
ALTER TABLE workspaces ADD COLUMN previous_api_key_expires_at INTEGER;

-- Monotonic ordering fence for out-of-band key writers (hosted control-plane
-- pushes, canonical repair). A writer that knows only generation N must lose
-- to an existing generation N+1, so a stale repair cannot resurrect a
-- superseded key over a fresher rotation.
ALTER TABLE workspaces ADD COLUMN api_key_generation INTEGER NOT NULL DEFAULT 0;

-- Previous-slot lookups happen only on current-hash misses, but the auth path
-- must stay indexed: an unindexed miss path turns every expired or rotated
-- key probe into a table scan.
CREATE INDEX idx_workspaces_previous_api_key
  ON workspaces(previous_api_key_hash);
