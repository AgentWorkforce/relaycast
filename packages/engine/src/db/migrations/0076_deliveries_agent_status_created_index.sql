-- `GET /v1/deliveries?status=<status>` (`listDeliveries` with an explicit
-- status) filters one agent's rows by status and orders them by
-- (created_at, id). The only index that serves that ORDER BY is
-- idx_deliveries_status (workspace_id, status, created_at), which is not
-- agent-scoped: the query walks every row with that status in the whole
-- workspace, discarding other agents' rows, then sorts the id tie-break in a
-- temp b-tree. On the hosted gateway ~4M of ~6.5M delivery rows are
-- `dead_lettered`, so one agent's `?status=dead_lettered` read could scan
-- millions of rows on the shared D1 before its LIMIT applied.
--
-- This index makes that read an agent-scoped seek that is already in the
-- requested order, so it stops at the LIMIT. The existing
-- idx_deliveries_agent_status_seq orders by `seq`, which is not the API's
-- order for historical rows (0029 renumbered active rows above settled ones).
-- No data changes. Building it is one pass over `deliveries`.
CREATE INDEX IF NOT EXISTS idx_deliveries_agent_status_created
  ON deliveries(workspace_id, agent_id, status, created_at, id);
