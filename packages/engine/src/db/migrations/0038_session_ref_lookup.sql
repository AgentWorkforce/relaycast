-- Indexed replay lookup plus a payload-free ledger that survives message TTL
-- pruning. The ledger is what lets an empty live-message slice mean aged_out
-- when appropriate instead of silently pretending the session never existed.
ALTER TABLE messages ADD COLUMN session_ref TEXT;

CREATE INDEX idx_messages_workspace_session
  ON messages(workspace_id, session_ref, id);

CREATE TABLE message_sessions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_ref TEXT NOT NULL,
  first_message_at INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, session_ref)
);

CREATE INDEX idx_message_sessions_workspace_last
  ON message_sessions(workspace_id, last_message_at);

-- Backfill public, string-valued session_ref metadata already persisted by
-- direct-DM and raw HTTP callers. Opaque refs are bounded to keep the index
-- key predictable; Relay UUIDs are comfortably within this limit.
UPDATE messages
SET session_ref = json_extract(metadata, '$.session_ref')
WHERE metadata IS NOT NULL
  AND json_valid(metadata)
  AND json_type(metadata, '$.session_ref') = 'text'
  AND length(json_extract(metadata, '$.session_ref')) BETWEEN 1 AND 255;

INSERT INTO message_sessions (
  workspace_id,
  session_ref,
  first_message_at,
  last_message_at
)
SELECT
  workspace_id,
  session_ref,
  MIN(created_at),
  MAX(created_at)
FROM messages
WHERE session_ref IS NOT NULL
GROUP BY workspace_id, session_ref;
