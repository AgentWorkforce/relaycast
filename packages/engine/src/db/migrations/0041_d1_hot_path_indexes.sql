-- Node reconnect/heartbeat drains only pending invocations, but the previous
-- workspace index included every completed invocation. Keep the hot index
-- partial and ordered by creation time so the drain reads the small pending
-- working set in dispatch order.
CREATE INDEX IF NOT EXISTS idx_action_invocations_pending_workspace
  ON action_invocations(workspace_id, created_at)
  WHERE status = 'pending';

-- The activity feed left-joins a DM conversation by channel for every message.
-- Without this lookup index SQLite scans the entire DM table once per result.
CREATE INDEX IF NOT EXISTS idx_dm_conversations_channel
  ON dm_conversations(channel_id);
