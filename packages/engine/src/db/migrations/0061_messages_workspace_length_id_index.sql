-- Inbox mention keyset scans order by (length(id), id) within a workspace.
-- idx_messages_retention is (length(id), id) but workspace-agnostic, so a
-- workspace-scoped range cannot stop at the batch limit without scanning
-- other workspaces' rows. This index keeps each 200-candidate batch indexed.
-- No data changes.
CREATE INDEX IF NOT EXISTS idx_messages_workspace_length_id
  ON messages(workspace_id, length(id), id);
