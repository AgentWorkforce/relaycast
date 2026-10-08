-- 0064 and 0065 left two sweeps reading every row of a status. The pending
-- retry sweep (status = ? AND retry_after_at <= ?) could seek only on status,
-- so it visited every pending row. The task deadline sweep
-- (task_state IS NOT NULL AND status IN (?, ?, ?) AND deadline <= ?) was
-- planned through the (status, dispatched_at) index rather than the
-- deadline-only expression index, so it visited every live row. These indexes
-- give each sweep a range on its timestamp within each status, and the
-- deadline-only index from 0065 is dropped because this one supersedes it.
-- No data changes.
CREATE INDEX IF NOT EXISTS idx_action_invocations_status_retry_after
  ON action_invocations(status, retry_after_at);
CREATE INDEX IF NOT EXISTS idx_action_invocations_status_task_deadline
  ON action_invocations(status, json_extract(task_state, '$.deadline'))
  WHERE task_state IS NOT NULL;
DROP INDEX IF EXISTS idx_action_invocations_task_deadline_any_status;
