-- #422: GET /v1/nodes now pushes a liveness selector (status=online/offline)
-- into SQL instead of fetching every historical row and filtering in JS.
-- The live-node path (status='online') needs its heartbeat freshness check
-- covered by the same index as the status equality, or it degrades to a
-- workspace-wide scan on every roster read once a workspace accumulates
-- thousands of dead rows. No data changes.
CREATE INDEX IF NOT EXISTS idx_nodes_status_heartbeat
  ON nodes(workspace_id, status, last_heartbeat_at);
