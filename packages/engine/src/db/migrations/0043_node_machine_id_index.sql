-- Enrollment (POST /v1/nodes) now falls back to machine_id when it can match
-- neither node_id nor name, so a host that re-enrolls under a fresh name
-- rotates its existing row instead of minting another one.
--
-- That lookup runs on every enrollment, so give it an index. Not unique: the
-- roster already holds many rows per machine from before this path existed,
-- and only broker rows are deduped -- a machine legitimately runs many
-- direct (node-of-one) delivery hosts.
CREATE INDEX IF NOT EXISTS idx_nodes_workspace_machine
  ON nodes(workspace_id, machine_id);
