-- The cloud cron's `reconcileStaleOnlineNodes` candidate scan runs a global
-- liveness query with no workspace predicate:
--   SELECT id, workspace_id FROM nodes
--   WHERE status = 'online'
--     AND (last_heartbeat_at IS NULL OR last_heartbeat_at < ?) LIMIT ?
-- Every existing nodes index leads with workspace_id, so prod answers it with
-- a full table scan (~24k rows) on every maintenance tick, on the same
-- database whose overload the sweep exists to relieve. A partial covering
-- index over only the online rows turns it into an index-only scan of the
-- live set (tens to hundreds of rows, not tens of thousands). The OR keeps
-- it a scan of the index rather than a seek, which is fine at partial-index
-- cardinality. No data changes.
CREATE INDEX IF NOT EXISTS idx_nodes_online_liveness
  ON nodes(last_heartbeat_at, workspace_id, id)
  WHERE status = 'online';
